// Role-based access control, through the REAL Express routers and the REAL JWT + permission middleware,
// with an in-memory stand-in for Prisma that filters by companyId / id like PostgreSQL would, and spies on every
// side effect (vector delete, graph delete, Cloudinary delete, reindex, reprocess).
//
// Covers: unauthenticated requests, administrators, members, role-modification attempts (privilege escalation),
// cross-company access (even by an administrator of another company), stale/forged tokens, document deletion and
// reprocessing, and integration-management endpoints.
//
// NOTE on integrations: the product has no meeting / GitHub / credential / company-settings routes yet. The
// `/api/_test/...` routes below are a stand-in that uses exactly the permissions those routes must use
// ('integration:manage', 'credentials:manage', 'company:configure'), so the rule is tested before the routes exist.
import test, { mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import jwt from 'jsonwebtoken'

process.env.JWT_ACCESS_SECRET = 'unit-test-access-secret'
// The rate limiter opens its own Redis connection when REDIS_URL is set at import time and these tests never close it, which would
// keep the test process alive after the last test (e.g. when REDIS_URL is exported in the developer's shell). These tests do not need Redis.
delete process.env.REDIS_URL
process.env.JWT_REFRESH_SECRET = 'unit-test-refresh-secret'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const COMPANY_A = id(1)
const COMPANY_B = id(2)
const ADMIN_A = id(11)
const ADMIN_A2 = id(12)
const MEMBER_A = id(13)
const MEMBER_A2 = id(14)
const ADMIN_B = id(21)
const MEMBER_B = id(22)
const DOC_A = id(101)
const DOC_B = id(102)

// ---------- in-memory database + spies ----------
let users
let documents
let companies
const effects = [] // every side effect that happened, in order
const dbCalls = [] // every database operation that happened
let txOptions = null
let refreshRows = []
const userLookups = [] // the `where` of every user.findFirst

const resetState = () => {
  const u = (uid, companyId, role, name) => ({ id: uid, companyId, role, name, email: `${name.toLowerCase().replace(/\s/g, '.')}@example.test`, password: 'HASHED-SECRET', createdAt: new Date('2026-09-01T10:00:00Z') })
  users = [
    u(ADMIN_A, COMPANY_A, 'ADMIN', 'Alice Admin'),
    u(ADMIN_A2, COMPANY_A, 'ADMIN', 'Adam Second'),
    u(MEMBER_A, COMPANY_A, 'MEMBER', 'Mia Member'),
    u(MEMBER_A2, COMPANY_A, 'MEMBER', 'Max Member'),
    u(ADMIN_B, COMPANY_B, 'ADMIN', 'Bob Boss'),
    u(MEMBER_B, COMPANY_B, 'MEMBER', 'Bea Member'),
  ]
  const d = (docId, companyId, name) => ({
    id: docId, companyId, originalName: name, fileName: `${docId}.txt`, mimeType: 'text/plain', fileSize: 10,
    cloudinaryUrl: `https://files.example/${docId}.txt`, cloudinaryPublicId: `pid-${docId}`, extractedText: `text of ${name}`, createdAt: new Date('2026-09-01T10:00:00Z'),
    uploader: null, graphIngestion: null,
  })
  documents = [d(DOC_A, COMPANY_A, 'a-handbook.txt'), d(DOC_B, COMPANY_B, 'b-secret.txt')]
  companies = [{ id: COMPANY_A, name: 'Company A' }, { id: COMPANY_B, name: 'Company B' }]
  effects.length = 0
  dbCalls.length = 0
  txOptions = null
  refreshRows = []
  userLookups.length = 0
}
resetState()

const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : row)
const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => row[k] === v)

const fakePrisma = {
  user: {
    findUnique: async ({ where, select, include }) => {
      dbCalls.push('user.findUnique')
      const row = users.find((x) => (where.id !== undefined ? x.id === where.id : x.email === where.email))
      if (!row) return null
      const out = pick(row, select)
      return include?.company ? { ...out, company: companies.find((c) => c.id === row.companyId) } : out
    },
    findMany: async ({ where, select }) => { dbCalls.push('user.findMany'); return users.filter((x) => matches(x, where)).map((x) => pick(x, select)) },
    findFirst: async ({ where, select }) => { dbCalls.push('user.findFirst'); userLookups.push(where); const row = users.find((x) => matches(x, where)); return row ? pick(row, select) : null },
    count: async ({ where }) => users.filter((x) => matches(x, where)).length,
    updateMany: async ({ where, data }) => {
      dbCalls.push('user.updateMany')
      const rows = users.filter((x) => matches(x, where))
      // The route must only ever write `role`: anything else would be a mass-assignment hole.
      assert.deepEqual(Object.keys(data), ['role'])
      rows.forEach((x) => Object.assign(x, data))
      return { count: rows.length }
    },
    deleteMany: async ({ where }) => {
      dbCalls.push('user.deleteMany')
      const before = users.length
      users = users.filter((x) => !matches(x, where))
      return { count: before - users.length }
    },
    create: async ({ data, include }) => {
      dbCalls.push('user.create')
      const row = { id: id(900 + users.length), createdAt: new Date(), ...data }
      users.push(row)
      return include?.company ? { ...row, company: companies.find((c) => c.id === row.companyId) } : row
    },
  },
  company: {
    findUnique: async ({ where }) => companies.find((c) => c.id === where.id) ?? null,
    create: async ({ data }) => { const row = { id: id(800 + companies.length), ...data }; companies.push(row); return row },
  },
  document: {
    findMany: async ({ where }) => { dbCalls.push('document.findMany'); return documents.filter((x) => matches(x, where)) },
    findFirst: async ({ where }) => { dbCalls.push('document.findFirst'); return documents.find((x) => matches(x, where)) ?? null },
    deleteMany: async ({ where }) => {
      dbCalls.push('document.deleteMany')
      const before = documents.length
      documents = documents.filter((x) => !matches(x, where))
      return { count: before - documents.length }
    },
  },
  // Refresh-token sessions (routes/auth.js stores one row per refresh token).
  refreshToken: {
    create: async ({ data }) => { const row = { revokedAt: null, revokeReason: null, ...data }; refreshRows.push(row); return row },
    findUnique: async ({ where }) => refreshRows.find((x) => x.id === where.id) ?? null,
    updateMany: async ({ where, data }) => { const rows = refreshRows.filter((x) => matches(x, where)); rows.forEach((x) => Object.assign(x, data)); return { count: rows.length } },
  },
  $transaction: async (arg, options) => {
    if (typeof arg === 'function') { txOptions = options; return arg(fakePrisma) }
    return Promise.all(arg)
  },
}
mock.module('../prisma.js', { defaultExport: fakePrisma })

mock.module('../cloudinary.js', {
  namedExports: {
    isCloudinaryConfigured: () => true,
    uploadDocumentFile: async () => ({ url: 'https://files.example/x', publicId: 'x' }),
    deleteDocumentFile: async (publicId) => { effects.push(['cloudinary.delete', publicId]) },
  },
})
class FakeRagError extends Error {
  constructor(message, code = 'RAG', status = 502) { super(message); this.code = code; this.status = status }
}
mock.module('../utils/vectorStore.js', {
  namedExports: {
    RagError: FakeRagError,
    MAX_SEARCH_LIMIT: 20,
    searchChunks: async () => [],
    indexDocument: async (doc) => { effects.push(['vector.index', doc.companyId, doc.id]); return 3 },
    deleteDocumentChunks: async (companyId, documentId) => { effects.push(['vector.delete', companyId, documentId]) },
  },
})
mock.module('../utils/graphStore.js', {
  namedExports: {
    deleteDocumentGraph: async (companyId, documentId) => { effects.push(['graph.delete', companyId, documentId]) },
    getEntityDetail: async () => null,
    getGraphOverview: async () => ({ nodes: [], edges: [], stats: { entities: 0, relationships: 0 }, truncated: false }),
  },
})
mock.module('../utils/graphIngest.js', {
  namedExports: {
    processDocumentGraph: async (doc) => {
      effects.push(['graph.reprocess', doc.companyId, doc.id])
      return { status: 'processed', entities: 2, relationships: 1, relationshipStatus: 'ok' }
    },
  },
})

const { default: express } = await import('express')
const { default: documentsRouter } = await import('./documents.js')
const { default: graphRouter } = await import('./graph.js')
const { default: usersRouter } = await import('./users.js')
const { default: authRouter } = await import('./auth.js')
const { requireAuth } = await import('../middleware/auth.js')
const { issueRefreshToken } = await import('../utils/refreshTokens.js')
const { requirePermission, PERMISSIONS } = await import('../middleware/permissions.js')

// Stand-in for the integration / credential / company-settings routes that do not exist yet.
const futureRouter = express.Router()
for (const [path, permission] of [['/integrations/github', 'integration:manage'], ['/integrations/meetings', 'integration:manage'], ['/credentials', 'credentials:manage'], ['/company/config', 'company:configure']]) {
  futureRouter.post(path, requireAuth, requirePermission(permission), (req, res) => res.json({ success: true, companyId: req.user.companyId }))
}

const app = express()
app.use(express.json())
app.use('/api/auth', authRouter)
app.use('/api/documents', documentsRouter)
app.use('/api/graph', graphRouter)
app.use('/api/users', usersRouter)
app.use('/api/_test', futureRouter)
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => { server.closeAllConnections?.(); server.close() })
beforeEach(resetState)

// ---------- helpers ----------
const SECRET = () => process.env.JWT_ACCESS_SECRET
// A normal, valid token for a user that exists in the database.
const tokenFor = (userId, overrides = {}) => {
  const row = users.find((x) => x.id === userId)
  return jwt.sign({ userId, companyId: row.companyId, role: row.role, ...overrides }, SECRET(), { algorithm: 'HS256' })
}
const call = async (method, path, token, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const roleOf = (userId) => users.find((x) => x.id === userId)?.role
const docExists = (docId) => documents.some((x) => x.id === docId)

const PRIVILEGED_DOCUMENT_CALLS = (docId) => [
  ['DELETE', `/api/documents/${docId}`],
  ['POST', `/api/documents/${docId}/reindex`],
  ['POST', `/api/graph/documents/${docId}/reprocess`],
]
const USER_MANAGEMENT_CALLS = [
  ['PATCH', `/api/users/${MEMBER_A}/role`, { role: 'ADMIN' }],
  ['DELETE', `/api/users/${MEMBER_A}`],
]
const FUTURE_CALLS = ['/api/_test/integrations/github', '/api/_test/integrations/meetings', '/api/_test/credentials', '/api/_test/company/config']

// =====================================================================================
// 1. Unauthenticated requests
// =====================================================================================
test('unauthenticated: every privileged route answers 401 and nothing is read, written or executed', async () => {
  const wrongSecret = jwt.sign({ userId: ADMIN_A, companyId: COMPANY_A, role: 'ADMIN' }, 'another-secret', { algorithm: 'HS256' })
  const expired = jwt.sign({ userId: ADMIN_A, companyId: COMPANY_A, role: 'ADMIN' }, SECRET(), { algorithm: 'HS256', expiresIn: -10 })
  // alg=none token claiming to be an admin
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ userId: ADMIN_A, companyId: COMPANY_A, role: 'ADMIN' })).toString('base64url')}.`

  const calls = [...PRIVILEGED_DOCUMENT_CALLS(DOC_A), ...USER_MANAGEMENT_CALLS, ['GET', '/api/users'], ...FUTURE_CALLS.map((p) => ['POST', p])]
  for (const [method, path, body] of calls) {
    for (const tok of [undefined, 'not-a-token', wrongSecret, expired, none]) {
      assert.equal((await call(method, path, tok, body)).status, 401, `${method} ${path}`)
    }
  }
  assert.deepEqual(effects, [])
  assert.deepEqual(dbCalls, [], 'rejected before touching the database')
  assert.ok(docExists(DOC_A))
})

// =====================================================================================
// 2. Members: allowed to use the product, blocked from restricted operations
// =====================================================================================
test('member: document delete, reindex and graph reprocess are 403 and have NO side effects', async () => {
  const member = tokenFor(MEMBER_A)
  for (const [method, path] of PRIVILEGED_DOCUMENT_CALLS(DOC_A)) {
    const r = await call(method, path, member)
    assert.equal(r.status, 403, `${method} ${path}`)
    assert.equal(r.body.success, false)
  }
  assert.deepEqual(effects, [], 'no vector/graph/cloud operation may run for a member')
  assert.ok(docExists(DOC_A), 'the document must survive')
  assert.ok(!dbCalls.includes('document.deleteMany'))
})

test('member: integration, credential and company-configuration endpoints are 403', async () => {
  for (const path of FUTURE_CALLS) assert.equal((await call('POST', path, tokenFor(MEMBER_A), {})).status, 403, path)
})

test('member: ordinary company features still work (list and read documents, list teammates)', async () => {
  const member = tokenFor(MEMBER_A)
  const list = await call('GET', '/api/documents', member)
  assert.equal(list.status, 200)
  assert.deepEqual(list.body.documents.map((x) => x.id), [DOC_A])
  const one = await call('GET', `/api/documents/${DOC_A}`, member)
  assert.equal(one.status, 200)
  assert.equal(one.body.document.id, DOC_A)
  const team = await call('GET', '/api/users', member)
  assert.equal(team.status, 200)
  assert.equal(team.body.users.length, 4)
})

test('member: a role claim is not enough, an unknown or missing role claim is refused too', async () => {
  for (const role of [undefined, 'SUPERADMIN', 'admin', '', null, ['ADMIN'], { $eq: 'ADMIN' }]) {
    const tok = jwt.sign({ userId: MEMBER_A, companyId: COMPANY_A, role }, SECRET(), { algorithm: 'HS256' })
    assert.equal((await call('DELETE', `/api/documents/${DOC_A}`, tok)).status, 403, JSON.stringify(role))
  }
  assert.ok(docExists(DOC_A))
})

// =====================================================================================
// 3. Administrators: legitimate operations keep working, always inside their own company
// =====================================================================================
test('admin: can reindex, reprocess and delete a document of their own company', async () => {
  const admin = tokenFor(ADMIN_A)

  const reindex = await call('POST', `/api/documents/${DOC_A}/reindex`, admin)
  assert.equal(reindex.status, 200)
  assert.equal(reindex.body.indexing.status, 'indexed')

  const reprocess = await call('POST', `/api/graph/documents/${DOC_A}/reprocess`, admin)
  assert.equal(reprocess.status, 200)
  assert.equal(reprocess.body.graph.status, 'processed')

  const del = await call('DELETE', `/api/documents/${DOC_A}`, admin)
  assert.equal(del.status, 200)
  assert.ok(!docExists(DOC_A))

  assert.deepEqual(effects, [
    ['vector.index', COMPANY_A, DOC_A],
    ['graph.reprocess', COMPANY_A, DOC_A],
    ['vector.delete', COMPANY_A, DOC_A],
    ['graph.delete', COMPANY_A, DOC_A],
    ['cloudinary.delete', `pid-${DOC_A}`],
  ])
  assert.ok(documents.some((x) => x.id === DOC_B), "company B's document is untouched")
})

test('admin: integration, credential and company-configuration endpoints are allowed, scoped to the JWT company', async () => {
  for (const path of FUTURE_CALLS) {
    const r = await call('POST', path, tokenFor(ADMIN_A), { companyId: COMPANY_B })
    assert.equal(r.status, 200, path)
    assert.equal(r.body.companyId, COMPANY_A, 'a companyId in the body never changes the company')
  }
})

// =====================================================================================
// 4. Cross-company access: being an ADMIN grants nothing in another company
// =====================================================================================
test('cross-company: an admin of company A cannot delete, reindex or reprocess company B\'s document (404, no side effects)', async () => {
  const adminA = tokenFor(ADMIN_A)
  for (const [method, path] of PRIVILEGED_DOCUMENT_CALLS(DOC_B)) {
    const r = await call(method, path, adminA)
    assert.equal(r.status, 404, `${method} ${path}`)
  }
  assert.deepEqual(effects, [])
  assert.ok(docExists(DOC_B))
})

test('cross-company: reads are scoped too (company A cannot read company B\'s document or list it)', async () => {
  const adminA = tokenFor(ADMIN_A)
  assert.equal((await call('GET', `/api/documents/${DOC_B}`, adminA)).status, 404)
  const list = await call('GET', '/api/documents?companyId=' + COMPANY_B, adminA)
  assert.ok(!JSON.stringify(list.body).includes('b-secret'))
  const team = await call('GET', '/api/users?companyId=' + COMPANY_B, adminA)
  assert.ok(team.body.users.every((x) => [ADMIN_A, ADMIN_A2, MEMBER_A, MEMBER_A2].includes(x.id)), 'only company A people')
})

test('cross-company: the companyId in a token that does not match the database is refused (stale or tampered claim)', async () => {
  // Admin of B whose token claims company A: signed correctly, but the database says B.
  const forged = jwt.sign({ userId: ADMIN_B, companyId: COMPANY_A, role: 'ADMIN' }, SECRET(), { algorithm: 'HS256' })
  for (const [method, path] of PRIVILEGED_DOCUMENT_CALLS(DOC_A)) assert.equal((await call(method, path, forged)).status, 403, path)
  assert.equal((await call('PATCH', `/api/users/${MEMBER_A}/role`, forged, { role: 'ADMIN' })).status, 403)
  assert.deepEqual(effects, [])
  assert.ok(docExists(DOC_A))
  assert.equal(roleOf(MEMBER_A), 'MEMBER')
})

// =====================================================================================
// 5. Stale tokens: demotion and removal take effect immediately for privileged actions
// =====================================================================================
test('demoted admin: a still-valid ADMIN token no longer works for privileged operations', async () => {
  const staleAdminToken = tokenFor(ADMIN_A2) // issued while ADMIN
  users.find((x) => x.id === ADMIN_A2).role = 'MEMBER' // demoted afterwards
  for (const [method, path] of PRIVILEGED_DOCUMENT_CALLS(DOC_A)) assert.equal((await call(method, path, staleAdminToken)).status, 403, path)
  assert.equal((await call('POST', '/api/_test/credentials', staleAdminToken, {})).status, 403)
  assert.deepEqual(effects, [])
  assert.ok(docExists(DOC_A))
})

test('removed user: a still-valid token is refused (401) on privileged operations', async () => {
  const tok = tokenFor(ADMIN_A2)
  users = users.filter((x) => x.id !== ADMIN_A2)
  assert.equal((await call('DELETE', `/api/documents/${DOC_A}`, tok)).status, 401)
  assert.deepEqual(effects, [])
})

test('refresh: a new access token carries the CURRENT role from the database, not the old one', async () => {
  const refreshToken = await issueRefreshToken(users.find((x) => x.id === ADMIN_A2))
  users.find((x) => x.id === ADMIN_A2).role = 'MEMBER'
  const r = await call('POST', '/api/auth/refresh', undefined, { refreshToken })
  assert.equal(r.status, 200)
  assert.equal(jwt.verify(r.body.accessToken, SECRET()).role, 'MEMBER')
})

// =====================================================================================
// 6. Privilege escalation: attempts to modify roles
// =====================================================================================
test('escalation: a member cannot promote themselves or anyone else (403, role unchanged)', async () => {
  const member = tokenFor(MEMBER_A)
  assert.equal((await call('PATCH', `/api/users/${MEMBER_A}/role`, member, { role: 'ADMIN' })).status, 403)
  assert.equal((await call('PATCH', `/api/users/${MEMBER_A2}/role`, member, { role: 'ADMIN' })).status, 403)
  assert.equal(roleOf(MEMBER_A), 'MEMBER')
  assert.equal(roleOf(MEMBER_A2), 'MEMBER')
  assert.ok(!dbCalls.includes('user.updateMany'))
})

test('escalation: a member cannot demote an admin or remove anybody', async () => {
  const member = tokenFor(MEMBER_A)
  assert.equal((await call('PATCH', `/api/users/${ADMIN_A}/role`, member, { role: 'MEMBER' })).status, 403)
  assert.equal((await call('DELETE', `/api/users/${ADMIN_A}`, member)).status, 403)
  assert.equal((await call('DELETE', `/api/users/${MEMBER_A}`, member)).status, 403)
  assert.equal(roleOf(ADMIN_A), 'ADMIN')
  assert.equal(users.length, 6)
})

test('escalation: registering never accepts a role, joining a company always makes a MEMBER', async () => {
  const join = await call('POST', '/api/auth/register', undefined, {
    name: 'Eve Evil', email: 'eve@example.test', password: 'long-enough-password', inviteCode: COMPANY_A,
    role: 'ADMIN', companyId: COMPANY_B, isAdmin: true,
  })
  assert.equal(join.status, 201)
  assert.equal(join.body.user.role, 'MEMBER')
  assert.equal(join.body.user.companyId, COMPANY_A, 'the invite code decides the company, not a companyId field')
  const claims = jwt.verify(join.body.accessToken, SECRET())
  assert.equal(claims.role, 'MEMBER')
  assert.equal((await call('DELETE', `/api/documents/${DOC_A}`, join.body.accessToken)).status, 403)
  assert.ok(docExists(DOC_A))
})

test('escalation: creating a NEW company makes the creator ADMIN of that new company only', async () => {
  const r = await call('POST', '/api/auth/register', undefined, { name: 'Neil New', email: 'neil@example.test', password: 'long-enough-password', companyName: 'Fresh Co', role: 'MEMBER' })
  assert.equal(r.status, 201)
  assert.equal(r.body.user.role, 'ADMIN')
  assert.notEqual(r.body.user.companyId, COMPANY_A)
  assert.notEqual(r.body.user.companyId, COMPANY_B)
  // that admin has no power over company A's documents
  assert.equal((await call('DELETE', `/api/documents/${DOC_A}`, r.body.accessToken)).status, 404)
  assert.ok(docExists(DOC_A))
})

test('role change (admin): only the role is written; invalid, unknown or injected role values are 400', async () => {
  const admin = tokenFor(ADMIN_A)
  for (const role of [undefined, null, '', 'admin', 'SUPERADMIN', 'OWNER', ['ADMIN'], { $ne: 'x' }, 1, true]) {
    const r = await call('PATCH', `/api/users/${MEMBER_A}/role`, admin, { role })
    assert.equal(r.status, 400, JSON.stringify(role))
  }
  assert.equal((await call('PATCH', `/api/users/${MEMBER_A}/role`, admin, {})).status, 400)
  assert.equal((await call('PATCH', '/api/users/not-a-uuid/role', admin, { role: 'ADMIN' })).status, 400)
  assert.equal(roleOf(MEMBER_A), 'MEMBER')
})

test('role change (admin): promote and demote within the company; extra body fields cannot move a user or change anything else', async () => {
  const admin = tokenFor(ADMIN_A)
  const up = await call('PATCH', `/api/users/${MEMBER_A}/role`, admin, { role: 'ADMIN', companyId: COMPANY_B, email: 'x@evil.test', password: 'pwned', id: ADMIN_B })
  assert.equal(up.status, 200)
  assert.equal(up.body.user.role, 'ADMIN')
  const row = users.find((x) => x.id === MEMBER_A)
  assert.equal(row.role, 'ADMIN')
  assert.equal(row.companyId, COMPANY_A)
  assert.equal(row.password, 'HASHED-SECRET')
  assert.ok(row.email.endsWith('@example.test'))

  assert.equal((await call('PATCH', `/api/users/${MEMBER_A}/role`, admin, { role: 'MEMBER' })).status, 200)
  assert.equal(roleOf(MEMBER_A), 'MEMBER')
  assert.equal(txOptions.isolationLevel, 'Serializable', 'role changes run in a serializable transaction (no two-admins-demote-each-other race)')
})

test('role change: an admin of company A cannot change the role of a user of company B (404, unchanged)', async () => {
  const adminA = tokenFor(ADMIN_A)
  assert.equal((await call('PATCH', `/api/users/${MEMBER_B}/role`, adminA, { role: 'ADMIN' })).status, 404)
  assert.equal((await call('PATCH', `/api/users/${ADMIN_B}/role`, adminA, { role: 'MEMBER' })).status, 404)
  assert.equal(roleOf(MEMBER_B), 'MEMBER')
  assert.equal(roleOf(ADMIN_B), 'ADMIN')
  // The target is looked up by id AND the caller's company from the very first query, so a probe for another
  // company's user is indistinguishable from a missing user (never a 409 "last admin" that would confirm it exists).
  assert.ok(userLookups.length >= 2 && userLookups.every((w) => w.companyId === COMPANY_A), JSON.stringify(userLookups))
})

test('role change: the last administrator of a company cannot be demoted, but one of several can', async () => {
  // company B has exactly one admin
  assert.equal((await call('PATCH', `/api/users/${ADMIN_B}/role`, tokenFor(ADMIN_B), { role: 'MEMBER' })).status, 409)
  assert.equal(roleOf(ADMIN_B), 'ADMIN')
  // company A has two: demoting one is fine, then the remaining one is protected
  assert.equal((await call('PATCH', `/api/users/${ADMIN_A2}/role`, tokenFor(ADMIN_A), { role: 'MEMBER' })).status, 200)
  assert.equal((await call('PATCH', `/api/users/${ADMIN_A}/role`, tokenFor(ADMIN_A), { role: 'MEMBER' })).status, 409)
  assert.equal(roleOf(ADMIN_A), 'ADMIN')
})

// =====================================================================================
// 7. Removing users
// =====================================================================================
test('remove user: admin removes a teammate; cannot remove themselves or another company\'s user', async () => {
  const admin = tokenFor(ADMIN_A)
  assert.equal((await call('DELETE', `/api/users/${ADMIN_A}`, admin)).status, 400, 'self-removal refused (also protects the last admin)')
  assert.equal((await call('DELETE', `/api/users/${MEMBER_B}`, admin)).status, 404)
  assert.equal((await call('DELETE', '/api/users/not-a-uuid', admin)).status, 400)
  assert.ok(users.some((x) => x.id === MEMBER_B))

  assert.equal((await call('DELETE', `/api/users/${MEMBER_A2}`, admin)).status, 200)
  assert.ok(!users.some((x) => x.id === MEMBER_A2))
})

// =====================================================================================
// 8. Responses never leak secrets
// =====================================================================================
test('GET /api/users returns names and roles only (no emails, no password hashes) for the caller\'s company', async () => {
  for (const who of [MEMBER_A, ADMIN_A]) {
    const r = await call('GET', '/api/users', tokenFor(who))
    assert.equal(r.status, 200)
    const text = JSON.stringify(r.body)
    for (const secret of ['HASHED-SECRET', '@example.test', 'password', 'email', 'Bob Boss']) assert.ok(!text.includes(secret), `${secret} must not be returned`)
    assert.deepEqual(Object.keys(r.body.users[0]).sort(), ['createdAt', 'id', 'name', 'role'])
  }
})

// =====================================================================================
// 9. The permission map itself
// =====================================================================================
test('permissions: unknown permission names throw when the route is defined (fail closed, not open)', () => {
  assert.throws(() => requirePermission('document:destroy'), /Unknown permission/)
  assert.throws(() => requirePermission(undefined), /Unknown permission/)
})

test('permissions: destructive, administrative and reserved integration permissions are ADMIN-only', () => {
  for (const name of ['document:delete', 'document:reindex', 'graph:reprocess', 'users:manage', 'company:configure', 'integration:manage', 'credentials:manage']) {
    assert.deepEqual(PERMISSIONS[name], ['ADMIN'], name)
  }
  assert.throws(() => { PERMISSIONS['document:delete'] = ['MEMBER'] }, TypeError, 'the map is frozen')
})

test('permissions: every role used anywhere exists in the Prisma Role enum (a new role forces this file to be reviewed)', () => {
  const schema = fs.readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8')
  const enumRoles = schema.match(/enum Role \{([^}]*)\}/)[1].split(/\s+/).filter(Boolean)
  assert.deepEqual(enumRoles.sort(), ['ADMIN', 'MEMBER'])
  for (const [name, roles] of Object.entries(PERMISSIONS)) {
    for (const r of roles) assert.ok(enumRoles.includes(r), `${name} uses unknown role ${r}`)
  }
})
