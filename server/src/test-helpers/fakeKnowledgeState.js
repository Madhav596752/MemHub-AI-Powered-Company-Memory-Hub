// In-memory stand-in for the two PostgreSQL pieces of Module 9.4 (Company.knowledgeVersion and the KnowledgeChange
// lease table), shaped like the Prisma calls knowledgeVersion.js makes. Spread `models` into a fake Prisma client:
//
//   const kb = fakeKnowledgeState()
//   const prisma = { user: {...}, document: {...}, ...kb.models }
//
// `kb.state` is inspectable and has switches to simulate failures:
//   state.versions        Map companyId -> counter (missing = 0)
//   state.leases          [{ id, companyId, operation, expiresAt }]
//   state.failRead        findUnique throws            (e.g. the migration was not applied)
//   state.failCreate      lease insert throws          (a change then runs "untracked")
//   state.failAdvance     counter increment throws
//   state.failRelease     lease update / delete throws
//   state.unknownCompanies  Set of company ids that have no row
export function fakeKnowledgeState(initial = {}) {
  const state = {
    versions: new Map(Object.entries(initial.versions ?? {})),
    leases: [],
    failRead: false,
    failCreate: false,
    failAdvance: false,
    failRelease: false,
    unknownCompanies: new Set(),
    advances: [], // companyId of every successful increment, in order
  }
  const counter = (id) => state.versions.get(id) ?? 0

  const models = {
    company: {
      findUnique: async ({ where }) => {
        if (state.failRead) throw Object.assign(new Error('column "knowledgeVersion" does not exist'), { code: 'P2022' })
        if (state.unknownCompanies.has(where.id)) return null
        const rows = state.leases
          .filter((l) => l.companyId === where.id)
          .sort((a, b) => b.expiresAt - a.expiresAt)
          .slice(0, 50)
          .map((l) => ({ id: l.id, expiresAt: l.expiresAt }))
        return { knowledgeVersion: counter(where.id), knowledgeChanges: rows }
      },
      update: async ({ where, data }) => {
        if (state.failAdvance) throw new Error('db down')
        if (state.unknownCompanies.has(where.id)) throw Object.assign(new Error('not found'), { code: 'P2025' })
        const next = counter(where.id) + (data.knowledgeVersion?.increment ?? 0)
        state.versions.set(where.id, next)
        state.advances.push(where.id)
        return { knowledgeVersion: next }
      },
    },
    knowledgeChange: {
      create: async ({ data }) => {
        if (state.failCreate) throw new Error('table "KnowledgeChange" does not exist')
        state.leases.push({ id: data.id, companyId: data.companyId, operation: data.operation, expiresAt: data.expiresAt })
        return data
      },
      update: async ({ where, data }) => {
        if (state.failRelease) throw new Error('db down')
        const lease = state.leases.find((l) => l.id === where.id)
        if (!lease) throw Object.assign(new Error('not found'), { code: 'P2025' })
        if (data.expiresAt) lease.expiresAt = data.expiresAt
        return lease
      },
      deleteMany: async ({ where }) => {
        if (state.failRelease) throw new Error('db down')
        const ids = where.id?.in ?? (where.id ? [where.id] : null)
        const before = state.leases.length
        state.leases = state.leases.filter((l) => !(l.companyId === (where.companyId ?? l.companyId) && (ids ? ids.includes(l.id) : true)))
        return { count: before - state.leases.length }
      },
    },
  }

  return { state, models, counter }
}
