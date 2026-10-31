// Company-level knowledge-base versioning (Phase 9, Module 9.4).
//
// WHAT THE VERSION IS
//   Every company has ONE knowledge-base version. It is the thing the /api/ask cache (askCache.js) and the graph
//   cache (graphCache.js) put into every key, so a cached value can only be found while the knowledge it was
//   computed from is still the knowledge the company has. Changing the version makes every older entry
//   unreachable at once (no key is ever searched for or deleted); Redis expires the orphans by TTL.
//
//   version string = "<counter>.<epoch>.<fingerprint>"
//     counter      Company.knowledgeVersion in PostgreSQL. Durable, monotonic, advanced with one atomic
//                  "increment" statement. THE source of truth. It survives a Redis flush / restart / eviction.
//     epoch        a random token in Redis, rotated whenever the counter advances (Module 9.2). Belt and braces:
//                  if the counter ever went backwards (database restored from a backup) old keys still would not match.
//     fingerprint  document count + newest Document.updatedAt + graph-ingestion count + newest updatedAt (Module 9.2).
//                  Catches changes made behind the application's back (manual SQL, an old script).
//
// WHY A VERSION ALONE IS NOT ENOUGH
//   PostgreSQL, ChromaDB (vectors) and Neo4j (graph) do NOT share a transaction. An upload writes to all three,
//   one after the other, and any step can fail or time out half-way. So the version is combined with a LEASE:
//
//     beginKnowledgeChange()  inserts a KnowledgeChange row (the lease) BEFORE anything is written. While an
//                             unexpired lease exists the company is "busy": knowledgeBaseVersion() returns null,
//                             which makes the callers skip the cache completely (no read, no write). Nobody can
//                             therefore cache, or be served, an answer computed over half-written data.
//     change.step()/record()  account for what each store did (see "effects").
//     change.settle()         ends the change:
//                               - something changed  -> the version advances ONCE, then the lease is removed;
//                               - nothing changed    -> the lease is removed and the version stays (a failed change
//                                                       that provably wrote nothing does not flush valid caches).
//                             The lease is only removed AFTER the version advanced. If advancing fails the lease is
//                             kept and expires; the first reader afterwards advances the version for us.
//
// EFFECTS (what one step did to a store)
//   'none'     provably did not change the store            (embedding failed before ChromaDB was touched,
//                                                            NLP failed before Neo4j was written, a rejected token ...)
//   'changed'  did change it, or may have, and the outcome is known (success; ChromaDB reported an error after it may
//                                                            already have deleted the old chunks)
//   'unknown'  the call may still be running or may have been committed without us hearing about it (timeout,
//                                                            connection lost). The version advances now, and the
//                                                            lease is KEPT for a short grace period (quarantine) so
//                                                            the cache stays off while a late write could still land;
//                                                            when it expires the next reader advances the version again.
//   The rule is deliberately one-sided: when in doubt the version advances. The only cost of a needless advance is a
//   colder cache; a missed advance would serve stale knowledge.
//
// CRASHES: a lease is just a row with an expiry. A process that dies mid-change leaves it behind; readers treat an
// expired lease as "that change may have written something": they advance the version, then delete the row.
//
// This module never throws. If PostgreSQL cannot record the lease (e.g. the migration was not applied) the change is
// "untracked": it still runs, and settle() falls back to rotating the Redis epoch, which is what Module 9.2 did.
// In that situation knowledgeBaseVersion() cannot read the durable counter either, so the caches stay OFF.

import { randomUUID, createHash } from 'node:crypto'
import { cacheGetOrCreateToken, cacheKey, cacheRotateToken, getRedisStatus } from './redisCache.js'

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// ---------- configuration ----------

function readSeconds(name, fallback, { min, max }) {
  const value = Number.parseInt((process.env[name] || '').trim(), 10)
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

// KB_CHANGE_LEASE_SECONDS (30 - 86400, default 900): the longest a single upload / delete / reindex / reprocess is
// expected to take. A change that outlives its lease is not harmful (it still advances the version when it ends);
// the cache is simply allowed again, under a version that this change's own settle() then makes obsolete.
export const changeLeaseSeconds = () => readSeconds('KB_CHANGE_LEASE_SECONDS', 900, { min: 30, max: 86_400 })

// KB_UNCERTAIN_GRACE_SECONDS (10 - 3600, default 300): how long the cache stays off after a failure whose outcome is
// unknown (a timeout may still complete in ChromaDB / Neo4j). Keep it at least as long as INDEX_TIMEOUT_MS.
export const uncertainGraceSeconds = () => readSeconds('KB_UNCERTAIN_GRACE_SECONDS', 300, { min: 10, max: 3600 })

// ---------- effect classification ----------

export const EFFECT = Object.freeze({ NONE: 'none', CHANGED: 'changed', UNKNOWN: 'unknown' })

// Writing a document's chunks to ChromaDB (indexDocument). The Python service embeds first, THEN deletes the old
// chunks, THEN adds the new ones.
export function vectorWriteEffect(err) {
  switch (err?.code) {
    case 'NO_TEXT': // refused locally, nothing was sent
    case 'EMBEDDING_FAILED': // the service failed while embedding, before it touched ChromaDB
    case 'VECTOR_SERVICE_MISCONFIGURED': // 401 / 403: rejected before any work
      return EFFECT.NONE
    case 'VECTOR_STORE_FAILED': // ChromaDB failed, possibly after the old chunks were deleted
      return EFFECT.CHANGED
    default: // EMBEDDING_SERVICE_UNAVAILABLE (timeout / connection lost) or anything unexpected
      return EFFECT.UNKNOWN
  }
}

// Deleting a document's chunks from ChromaDB. Same reasoning; a failed delete reported by ChromaDB may be partial.
export const vectorDeleteEffect = vectorWriteEffect

// An error thrown by a Neo4j write (replaceDocumentGraph / deleteDocumentGraph). Every graph write is ONE Neo4j
// transaction, so a query error rolls back completely. A lost connection may have happened before or after the commit.
export function graphWriteEffect(err) {
  switch (err?.code) {
    case 'GRAPH_NOT_CONFIGURED':
    case 'GRAPH_AUTH_FAILED':
    case 'GRAPH_QUERY_FAILED':
    case 'GRAPH_TOO_LARGE':
      return EFFECT.NONE
    default: // GRAPH_UNAVAILABLE (may have committed), GRAPH_PROCESSING_FAILED (unexpected), anything else
      return EFFECT.UNKNOWN
  }
}

// The result object of processDocumentGraph() (which never throws): { status, code }.
export function graphResultEffect(result) {
  if (!result || typeof result !== 'object') return EFFECT.UNKNOWN
  if (result.status === 'processed') return EFFECT.CHANGED
  if (result.status === 'skipped') return EFFECT.NONE
  // 'failed': NLP problems happen before anything is written, and "NLP_CHUNK_FAILED" explicitly leaves the graph untouched.
  if (typeof result.code === 'string' && result.code.startsWith('NLP_')) return EFFECT.NONE
  return graphWriteEffect({ code: result.code })
}

// ---------- the Redis epoch (Module 9.2) ----------

const epochKey = (companyId) => cacheKey(companyId, 'kb-epoch')

// Rotates the random epoch in Redis: every key built from the old one becomes unreachable. Never throws.
// false = Redis is off or down (then no answer is being cached through this process anyway).
export async function invalidateCompanyKnowledge(companyId) {
  if (typeof companyId !== 'string' || !companyId) return false
  try {
    const ok = await cacheRotateToken(epochKey(companyId))
    if (!ok && getRedisStatus().configured) console.warn('[ask-cache] could not rotate the cache epoch (Redis unavailable); the durable version still protects the caches')
    return ok
  } catch {
    return false
  }
}

// ---------- the durable counter ----------

// Advances the company's version by one (one atomic UPDATE ... SET knowledgeVersion = knowledgeVersion + 1).
// -> the new counter, or null when it could not be advanced. Never throws.
export async function advanceKnowledgeVersion(prisma, companyId) {
  try {
    const row = await prisma.company.update({
      where: { id: companyId },
      data: { knowledgeVersion: { increment: 1 } },
      select: { knowledgeVersion: true },
    })
    return Number.isInteger(row?.knowledgeVersion) ? row.knowledgeVersion : null
  } catch (err) {
    console.error('[kb-version] could not advance the knowledge-base version:', err?.code || err?.message)
    return null
  }
}

// Reads the durable state: { counter, busy }.
//   busy = at least one unexpired lease exists (a change is in flight or quarantined).
// Expired leases are recovered here: a change that never settled (crash, or the grace period after an unknown
// outcome ran out) may have written something, so the counter advances FIRST and the rows are deleted afterwards.
// If the delete fails the rows are simply found again, which advances the counter once more (harmless).
// -> null when the state cannot be read (no row, database error, migration missing): callers must not use the cache.
export async function readKnowledgeState(prisma, companyId) {
  try {
    const now = new Date()
    const row = await prisma.company.findUnique({
      where: { id: companyId },
      select: {
        knowledgeVersion: true,
        // Newest-expiring first: if ANY lease is still valid, the first row is. 50 rows are plenty; the rest is recovered next time.
        knowledgeChanges: { select: { id: true, expiresAt: true }, orderBy: { expiresAt: 'desc' }, take: 50 },
      },
    })
    if (!row || !Number.isInteger(row.knowledgeVersion) || !Array.isArray(row.knowledgeChanges)) return null

    const expired = row.knowledgeChanges.filter((c) => new Date(c.expiresAt) <= now)
    let counter = row.knowledgeVersion
    if (expired.length > 0) {
      const advanced = await advanceKnowledgeVersion(prisma, companyId)
      if (advanced === null) return null // cannot honour the recovery -> do not trust the counter
      counter = advanced
      await prisma.knowledgeChange.deleteMany({ where: { companyId, id: { in: expired.map((c) => c.id) } } }).catch(() => {})
    }
    return { counter, busy: expired.length < row.knowledgeChanges.length }
  } catch (err) {
    console.warn('[kb-version] knowledge-base state unavailable:', err?.code || err?.message)
    return null
  }
}

const iso = (d) => (d instanceof Date ? d.toISOString() : d ? String(d) : 'none')

// -> "<counter>.<epoch>.<fingerprint>", or null = "do not use the cache for this request": Redis / PostgreSQL could not
// provide the version, OR a knowledge change is in flight for this company. Never throws.
// Callers read it BEFORE they retrieve anything and store their result under that same value.
export async function knowledgeBaseVersion(prisma, companyId) {
  try {
    const [epoch, docs, graph, state] = await Promise.all([
      cacheGetOrCreateToken(epochKey(companyId)),
      prisma.document.aggregate({ where: { companyId }, _count: { _all: true }, _max: { updatedAt: true } }),
      prisma.graphIngestion.aggregate({ where: { companyId }, _count: { _all: true }, _max: { updatedAt: true } }),
      readKnowledgeState(prisma, companyId),
    ])
    if (!epoch || !state || state.busy) return null
    const fingerprint = sha256(JSON.stringify([docs._count._all, iso(docs._max.updatedAt), graph._count._all, iso(graph._max.updatedAt)]))
    return `${state.counter}.${epoch}.${fingerprint.slice(0, 16)}`
  } catch (err) {
    console.warn('[kb-version] knowledge-base version unavailable:', err?.code || err?.message)
    return null
  }
}

// ---------- the change lifecycle ----------

// const change = await beginKnowledgeChange(prisma, companyId, 'upload')
// try {
//   const n = await change.step(() => indexDocument(doc), { onError: vectorWriteEffect })   // runs fn, records its effect, rethrows its error
//   change.record(graphResultEffect(await processDocumentGraph(doc)))                       // for calls that report instead of throw
// } finally {
//   await change.settle()   // idempotent: call it before responding AND in finally
// }
//
// Never throws. operation is only a label for the lease row ('upload' | 'delete' | 'reindex' | 'graph-reprocess' | ...).
export async function beginKnowledgeChange(prisma, companyId, operation) {
  let leaseId = null
  try {
    if (typeof companyId !== 'string' || !companyId) throw new TypeError('companyId is required')
    const id = randomUUID()
    await prisma.knowledgeChange.create({
      data: { id, companyId, operation: String(operation || 'change').slice(0, 40), expiresAt: new Date(Date.now() + changeLeaseSeconds() * 1000) },
    })
    leaseId = id
  } catch (err) {
    console.warn('[kb-version] change not tracked (caches stay off; the Redis epoch is rotated instead):', err?.code || err?.message)
  }

  let changed = false
  let unknown = false
  let settled = null

  const record = (effect) => {
    if (effect === EFFECT.CHANGED) changed = true
    else if (effect === EFFECT.UNKNOWN) unknown = true
  }

  return {
    tracked: leaseId !== null,

    record,

    // Runs fn (a store write). Success = the store changed, unless onSuccess(result) says otherwise.
    // A failure is classified by onError(err); the error is always rethrown unchanged.
    async step(fn, { onError = () => EFFECT.UNKNOWN, onSuccess = () => EFFECT.CHANGED } = {}) {
      let result
      try {
        result = await fn()
      } catch (err) {
        let effect
        try { effect = onError(err) } catch { effect = EFFECT.UNKNOWN }
        record(effect)
        throw err
      }
      let effect
      try { effect = onSuccess(result) } catch { effect = EFFECT.CHANGED }
      record(effect)
      return result
    },

    // Ends the change. Idempotent. -> { advanced: boolean, quarantined: boolean }
    settle() {
      if (!settled) {
        settled = (async () => {
          const needsAdvance = changed || unknown
          let advanced = false

          if (needsAdvance) {
            advanced = (await advanceKnowledgeVersion(prisma, companyId)) !== null
            // Redis epoch: second line of defence, and the ONLY one when the durable counter could not be advanced.
            if (getRedisStatus().status === 'ok' || !advanced) await invalidateCompanyKnowledge(companyId)
          }

          if (leaseId) {
            try {
              if (needsAdvance && !advanced) {
                // Could not advance: keep the lease. It expires, and the first reader then advances the version.
                console.error('[kb-version] version not advanced; the lease is kept so the next reader recovers it')
              } else if (unknown) {
                // Outcome unknown: stay "busy" for a grace period so nothing is cached while a late write could land.
                await prisma.knowledgeChange.update({ where: { id: leaseId }, data: { expiresAt: new Date(Date.now() + uncertainGraceSeconds() * 1000) } })
              } else {
                await prisma.knowledgeChange.deleteMany({ where: { id: leaseId, companyId } })
              }
            } catch (err) {
              // The lease stays and expires by itself; readers recover it (advance + delete).
              console.warn('[kb-version] could not release the change lease:', err?.code || err?.message)
            }
          }
          return { advanced, quarantined: unknown }
        })()
      }
      return settled
    },
  }
}
