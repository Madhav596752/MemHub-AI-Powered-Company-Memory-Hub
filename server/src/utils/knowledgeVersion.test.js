// Module 9.4: company-level knowledge-base versioning. FAKE Redis, FAKE Prisma (see test-helpers/fakeKnowledgeState.js):
// no Redis server, database or network. They check when the version advances (and when it must NOT), that an in-flight
// change switches the caches off, how partial failures between the stores are classified, crash recovery, and the
// authorization rules of the cache layers.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { initRedisCache, closeRedisCache, setRedisClientFactoryForTests } from './redisCache.js'
import {
  EFFECT, advanceKnowledgeVersion, beginKnowledgeChange, changeLeaseSeconds, graphResultEffect, graphWriteEffect,
  invalidateCompanyKnowledge, knowledgeBaseVersion, readKnowledgeState, uncertainGraceSeconds, vectorWriteEffect,
} from './knowledgeVersion.js'
import { prepareAskCache, askScopeHash } from './askCache.js'
import { cachedGraphRead, graphCacheVersion } from './graphCache.js'
import { fakeKnowledgeState } from '../test-helpers/fakeKnowledgeState.js'

function withEnv(values) {
  const saved = {}
  for (const k of Object.keys(values)) {
    saved[k] = process.env[k]
    if (values[k] === undefined) delete process.env[k]
    else process.env[k] = values[k]
  }
  return () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

function fakeRedis() {
  const store = new Map()
  const c = new EventEmitter()
  c.isOpen = false
  c.isReady = false
  c.connect = async () => { c.isOpen = true; c.isReady = true; c.emit('ready') }
  c.get = async (key) => (store.has(key) ? store.get(key) : null)
  c.sendCommand = async (args) => {
    const [, key, value, ...opts] = args
    if (opts.includes('NX') && store.has(key)) return null
    store.set(key, value)
    return 'OK'
  }
  c.ping = async () => 'PONG'
  c.quit = async () => { c.isOpen = false; c.isReady = false }
  c.disconnect = c.quit
  return { client: c, store }
}

const iso = (s) => new Date(s)
function fakePrisma() {
  const state = {
    users: [
      { id: 'u-a1', companyId: 'company-A', role: 'MEMBER' },
      { id: 'u-a2', companyId: 'company-A', role: 'ADMIN' },
      { id: 'u-b1', companyId: 'company-B', role: 'MEMBER' },
    ],
    docs: [{ id: 'd1', companyId: 'company-A', updatedAt: iso('2026-10-01T00:00:00Z') }],
  }
  const agg = (rows) => async ({ where }) => {
    const mine = rows().filter((r) => r.companyId === where.companyId)
    const times = mine.map((r) => r.updatedAt).filter(Boolean).sort((a, b) => b - a)
    return { _count: { _all: mine.length }, _max: { updatedAt: times[0] ?? null } }
  }
  const kb = fakeKnowledgeState()
  return {
    state,
    kb,
    ...kb.models,
    user: { findUnique: async ({ where }) => state.users.find((u) => u.id === where.id) ?? null },
    document: { aggregate: agg(() => state.docs) },
    graphIngestion: { aggregate: agg(() => []) },
  }
}

const CONFIG = { topK: 5, minScore: 0.25, maxContextChars: 6000, graph: { enabled: false, maxFacts: 8, maxContextChars: 1500, evidenceChars: 500 }, model: 'm' }
const GOOD = () => ({
  success: true, grounded: true, answer: 'Refunds within 14 days [1].',
  sources: [{ ref: 1, kind: 'chunk', documentId: 'd1', documentName: 'refund.txt', chunkIndex: 0, text: 'Refund within 14 days.', startChar: 0, endChar: 22, score: 0.9 }],
  retrieval: { vector: { status: 'ok', chunks: 1 }, graph: { status: 'disabled', facts: 0 } },
})
const memberA = { userId: 'u-a1', companyId: 'company-A', role: 'MEMBER' }

let restoreEnv
let fake
let prisma
test.beforeEach(async () => {
  restoreEnv = withEnv({ REDIS_URL: 'redis://127.0.0.1:6379', REDIS_CONNECT_TIMEOUT: '100', KB_CHANGE_LEASE_SECONDS: undefined, KB_UNCERTAIN_GRACE_SECONDS: undefined, GRAPH_CACHE_ENABLED: undefined, ASK_CACHE_ENABLED: undefined })
  for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {})
  fake = fakeRedis()
  setRedisClientFactoryForTests(() => fake.client)
  await initRedisCache()
  prisma = fakePrisma()
})
test.afterEach(async () => {
  await closeRedisCache()
  setRedisClientFactoryForTests(null)
  mock.restoreAll()
  restoreEnv()
})

const version = () => knowledgeBaseVersion(prisma, 'company-A')
const prep = (over = {}) => prepareAskCache({ prisma, user: memberA, question: 'What is our refund policy?', config: CONFIG, ...over })

// ---------- configuration ----------

test('lease and grace durations: defaults, valid overrides, invalid values fall back', () => {
  assert.equal(changeLeaseSeconds(), 900)
  assert.equal(uncertainGraceSeconds(), 300)
  const restore = withEnv({ KB_CHANGE_LEASE_SECONDS: '120', KB_UNCERTAIN_GRACE_SECONDS: '45' })
  assert.equal(changeLeaseSeconds(), 120)
  assert.equal(uncertainGraceSeconds(), 45)
  restore()
  const bad = withEnv({ KB_CHANGE_LEASE_SECONDS: '5', KB_UNCERTAIN_GRACE_SECONDS: 'abc' })
  assert.equal(changeLeaseSeconds(), 900)
  assert.equal(uncertainGraceSeconds(), 300)
  bad()
})

// ---------- classification of what a failed step did to a store ----------

test('vector writes: failures that provably left ChromaDB alone are "none"; a ChromaDB failure or a timeout is not', () => {
  for (const code of ['NO_TEXT', 'EMBEDDING_FAILED', 'VECTOR_SERVICE_MISCONFIGURED']) assert.equal(vectorWriteEffect({ code }), EFFECT.NONE, code)
  assert.equal(vectorWriteEffect({ code: 'VECTOR_STORE_FAILED' }), EFFECT.CHANGED) // old chunks may already be deleted
  assert.equal(vectorWriteEffect({ code: 'EMBEDDING_SERVICE_UNAVAILABLE' }), EFFECT.UNKNOWN) // the call may still complete
  assert.equal(vectorWriteEffect(new Error('boom')), EFFECT.UNKNOWN)
})

test('graph writes: a rolled-back / refused write is "none"; a lost connection is "unknown"', () => {
  for (const code of ['GRAPH_NOT_CONFIGURED', 'GRAPH_AUTH_FAILED', 'GRAPH_QUERY_FAILED', 'GRAPH_TOO_LARGE']) assert.equal(graphWriteEffect({ code }), EFFECT.NONE, code)
  assert.equal(graphWriteEffect({ code: 'GRAPH_UNAVAILABLE' }), EFFECT.UNKNOWN)
  assert.equal(graphWriteEffect({ code: 'GRAPH_PROCESSING_FAILED' }), EFFECT.UNKNOWN)
})

test('processDocumentGraph() results: processed = changed; skipped and NLP failures = none; Neo4j trouble follows the write rules', () => {
  assert.equal(graphResultEffect({ status: 'processed' }), EFFECT.CHANGED)
  assert.equal(graphResultEffect({ status: 'skipped', code: 'NLP_NOT_CONFIGURED' }), EFFECT.NONE)
  for (const code of ['NLP_CHUNK_FAILED', 'NLP_SERVICE_UNAVAILABLE', 'NLP_FAILED', 'NLP_BAD_RESPONSE']) assert.equal(graphResultEffect({ status: 'failed', code }), EFFECT.NONE, code)
  assert.equal(graphResultEffect({ status: 'failed', code: 'GRAPH_QUERY_FAILED' }), EFFECT.NONE)
  assert.equal(graphResultEffect({ status: 'failed', code: 'GRAPH_UNAVAILABLE' }), EFFECT.UNKNOWN)
  assert.equal(graphResultEffect(undefined), EFFECT.UNKNOWN)
})

// ---------- the version ----------

test('the version has the form <counter>.<epoch>.<fingerprint> and is stable while nothing changes', async () => {
  const v1 = await version()
  assert.match(v1, /^0\.[0-9a-f-]{36}\.[0-9a-f]{16}$/)
  assert.equal(await version(), v1)
  assert.equal(prisma.kb.state.advances.length, 0, 'reading never advances')
})

test('versions of two companies are independent', async () => {
  const a1 = await version()
  const b1 = await knowledgeBaseVersion(prisma, 'company-B')
  await advanceKnowledgeVersion(prisma, 'company-B')
  assert.equal(await version(), a1)
  assert.notEqual(await knowledgeBaseVersion(prisma, 'company-B'), b1)
})

test('no version (= no caching) when Redis is off, the durable state cannot be read, or the company row is missing', async () => {
  prisma.kb.state.failRead = true // e.g. the migration was not applied
  assert.equal(await version(), null)
  prisma.kb.state.failRead = false
  prisma.kb.state.unknownCompanies.add('company-A')
  assert.equal(await version(), null)
  prisma.kb.state.unknownCompanies.clear()
  assert.match(await version(), /^0\./)
  await closeRedisCache()
  const restore = withEnv({ REDIS_URL: undefined })
  assert.equal(await version(), null)
  restore()
})

// ---------- the change lifecycle ----------

test('a change that wrote nothing does not advance the version; its lease is released', async () => {
  const v1 = await version()
  const change = await beginKnowledgeChange(prisma, 'company-A', 'reindex')
  assert.equal(change.tracked, true)
  assert.equal(prisma.kb.state.leases.length, 1)
  assert.equal(prisma.kb.state.leases[0].operation, 'reindex')
  await assert.rejects(change.step(async () => { throw Object.assign(new Error('x'), { code: 'EMBEDDING_FAILED' }) }, { onError: vectorWriteEffect }), /x/)
  assert.deepEqual(await change.settle(), { advanced: false, quarantined: false })
  assert.equal(prisma.kb.state.leases.length, 0)
  assert.equal(prisma.kb.counter('company-A'), 0)
  assert.equal(await version(), v1, 'valid cache entries stay valid')
})

test('a change that wrote something advances the version exactly once, and settle() is idempotent', async () => {
  const v1 = await version()
  const change = await beginKnowledgeChange(prisma, 'company-A', 'upload')
  assert.equal(await change.step(async () => 7), 7, 'step returns the result')
  change.record(EFFECT.CHANGED)
  const [a, b] = await Promise.all([change.settle(), change.settle()])
  assert.equal(a, b)
  await change.settle()
  assert.equal(prisma.kb.counter('company-A'), 1)
  assert.equal(prisma.kb.state.leases.length, 0)
  const v2 = await version()
  assert.notEqual(v2, v1)
  assert.match(v2, /^1\./)
})

test('a step that fails AFTER it may have changed a store advances the version and rethrows the original error', async () => {
  const boom = Object.assign(new Error('chroma_failed'), { code: 'VECTOR_STORE_FAILED' })
  const change = await beginKnowledgeChange(prisma, 'company-A', 'reindex')
  await assert.rejects(change.step(async () => { throw boom }, { onError: vectorWriteEffect }), (e) => e === boom)
  assert.deepEqual(await change.settle(), { advanced: true, quarantined: false })
  assert.equal(prisma.kb.counter('company-A'), 1)
  assert.equal(prisma.kb.state.leases.length, 0)
})

test('while a change is in flight the version is unavailable, so nothing is cached or served from cache', async () => {
  const handle = await prep()
  await handle.store(GOOD())
  assert.ok(await (await prep()).lookup(), 'before the change the entry is served')

  const change = await beginKnowledgeChange(prisma, 'company-A', 'delete')
  assert.equal(await version(), null)
  assert.equal(await prep(), null, 'no ask-cache handle at all: neither read nor write')
  assert.equal(await graphCacheVersion(prisma, 'company-A', memberA), null)
  const read = await cachedGraphRead({ companyId: 'company-A', kb: await graphCacheVersion(prisma, 'company-A', memberA), kind: 'overview', params: {}, compute: async () => ({ nodes: [], edges: [] }) })
  assert.equal(read.cache, 'BYPASS')

  change.record(EFFECT.CHANGED)
  await change.settle()
  const after = await prep()
  assert.ok(after, 'caching resumes once the change settled')
  assert.equal(await after.lookup(), null, 'but the entry from before the change is unreachable')
})

test('another company keeps its cache while this company is busy', async () => {
  await beginKnowledgeChange(prisma, 'company-A', 'upload')
  assert.equal(await version(), null)
  prisma.state.docs.push({ id: 'db', companyId: 'company-B', updatedAt: iso('2026-10-01T00:00:00Z') })
  assert.match(await knowledgeBaseVersion(prisma, 'company-B'), /^0\./)
})

test('an answer stored under the old version by a request that was already running cannot be served after the change', async () => {
  const running = await prep() // the request read version 0 before the change started
  const change = await beginKnowledgeChange(prisma, 'company-A', 'upload')
  change.record(EFFECT.CHANGED)
  await change.settle()
  assert.equal(await running.store(GOOD()), true, 'its late store lands under the OLD version')
  assert.equal(await (await prep()).lookup(), null, 'nobody asks for the old version any more')
})

// ---------- unknown outcomes (timeouts): quarantine ----------

test('an unknown outcome advances the version now and keeps the caches off for the grace period, then advances again', async () => {
  const restore = withEnv({ KB_UNCERTAIN_GRACE_SECONDS: '60' })
  const change = await beginKnowledgeChange(prisma, 'company-A', 'reindex')
  await assert.rejects(change.step(async () => { throw Object.assign(new Error('timeout'), { code: 'EMBEDDING_SERVICE_UNAVAILABLE' }) }, { onError: vectorWriteEffect }))
  assert.deepEqual(await change.settle(), { advanced: true, quarantined: true })
  assert.equal(prisma.kb.counter('company-A'), 1)
  assert.equal(prisma.kb.state.leases.length, 1, 'the lease stays')
  const grace = prisma.kb.state.leases[0].expiresAt - Date.now()
  assert.ok(grace > 50_000 && grace <= 60_000, `grace period applied (${grace} ms)`)
  assert.equal(await version(), null, 'quarantined: no caching')

  // the grace period passes: a late write may have landed meanwhile, so the next reader advances once more
  prisma.kb.state.leases[0].expiresAt = new Date(Date.now() - 1000)
  const v = await version()
  assert.match(v, /^2\./)
  assert.equal(prisma.kb.state.leases.length, 0)
  restore()
})

// ---------- crash recovery ----------

test('a change that never settled (crashed process) is recovered by the next reader: version advances, lease is deleted', async () => {
  await beginKnowledgeChange(prisma, 'company-A', 'upload') // never settled
  assert.equal(await version(), null)
  prisma.kb.state.leases[0].expiresAt = new Date(Date.now() - 1)
  const state = await readKnowledgeState(prisma, 'company-A')
  assert.deepEqual(state, { counter: 1, busy: false })
  assert.equal(prisma.kb.state.leases.length, 0)
  assert.equal((await readKnowledgeState(prisma, 'company-A')).counter, 1, 'recovered once, not on every read')
})

test('an expired lease next to a live one: recovered, but the company stays busy', async () => {
  await beginKnowledgeChange(prisma, 'company-A', 'a')
  await beginKnowledgeChange(prisma, 'company-A', 'b')
  prisma.kb.state.leases[0].expiresAt = new Date(Date.now() - 1)
  assert.deepEqual(await readKnowledgeState(prisma, 'company-A'), { counter: 1, busy: true })
  assert.equal(prisma.kb.state.leases.length, 1)
})

test('if recovery cannot advance the counter the state is "unknown" - never trusted', async () => {
  await beginKnowledgeChange(prisma, 'company-A', 'upload')
  prisma.kb.state.leases[0].expiresAt = new Date(Date.now() - 1)
  prisma.kb.state.failAdvance = true
  assert.equal(await readKnowledgeState(prisma, 'company-A'), null)
  assert.equal(await version(), null)
})

// ---------- partial failures of the bookkeeping itself ----------

test('if the version cannot be advanced the lease is KEPT (caches stay off) and the Redis epoch is still rotated', async () => {
  await version() // creates the epoch
  const epoch1 = [...fake.store.entries()].find(([k]) => k.endsWith(':kb-epoch'))[1]
  const change = await beginKnowledgeChange(prisma, 'company-A', 'delete')
  change.record(EFFECT.CHANGED)
  prisma.kb.state.failAdvance = true
  assert.deepEqual(await change.settle(), { advanced: false, quarantined: false })
  assert.equal(prisma.kb.state.leases.length, 1, 'lease kept')
  assert.notEqual([...fake.store.entries()].find(([k]) => k.endsWith(':kb-epoch'))[1], epoch1, 'epoch rotated as the fallback')

  // PostgreSQL is back and the lease runs out: the first reader advances the version
  prisma.kb.state.failAdvance = false
  prisma.kb.state.leases[0].expiresAt = new Date(Date.now() - 1)
  assert.match(await version(), /^1\./)
})

test('if the lease cannot be released after the version advanced, it simply expires and is recovered', async () => {
  const change = await beginKnowledgeChange(prisma, 'company-A', 'upload')
  change.record(EFFECT.CHANGED)
  prisma.kb.state.failRelease = true
  assert.equal((await change.settle()).advanced, true)
  assert.equal(prisma.kb.state.leases.length, 1)
  assert.equal(await version(), null, 'still busy until the lease expires')
  prisma.kb.state.failRelease = false
  prisma.kb.state.leases[0].expiresAt = new Date(Date.now() - 1)
  assert.match(await version(), /^2\./, 'advanced once more by the recovery, which is harmless')
})

test('a change that cannot record its lease still runs: untracked, the Redis epoch is rotated when it changed something', async () => {
  prisma.kb.state.failCreate = true
  const change = await beginKnowledgeChange(prisma, 'company-A', 'upload')
  assert.equal(change.tracked, false)
  await version()
  const epoch1 = [...fake.store.entries()].find(([k]) => k.endsWith(':kb-epoch'))[1]
  change.record(EFFECT.CHANGED)
  await change.settle()
  assert.notEqual([...fake.store.entries()].find(([k]) => k.endsWith(':kb-epoch'))[1], epoch1)
  assert.equal(await beginKnowledgeChange(prisma, '', 'x').then((c) => c.tracked), false, 'a missing company id is never tracked, never throws')
})

test('invalidateCompanyKnowledge() still rotates the epoch (the Module 9.2 API is unchanged)', async () => {
  const v1 = await version()
  assert.equal(await invalidateCompanyKnowledge('company-A'), true)
  assert.notEqual(await version(), v1)
  assert.equal(await invalidateCompanyKnowledge(''), false)
})

// ---------- authorization ----------

test('ask cache: a role change selects another scope by itself and does NOT advance the knowledge-base version', async () => {
  await (await prep()).store(GOOD())
  const versionBefore = prisma.kb.counter('company-A')
  prisma.state.users.find((u) => u.id === 'u-a1').role = 'ADMIN' // PATCH /api/users/:id/role
  const asAdmin = await prep()
  assert.equal(await asAdmin.lookup(), null, 'the answer produced for MEMBER is not served to ADMIN')
  assert.equal(prisma.kb.counter('company-A'), versionBefore)
  assert.notEqual(askScopeHash({ role: 'MEMBER' }), askScopeHash({ role: 'ADMIN' }))
  // the other member of the same role is unaffected: no company-wide flush for a per-user change
  prisma.state.users.find((u) => u.id === 'u-a1').role = 'MEMBER'
  assert.ok(await (await prep()).lookup())
})

test('ask cache: a removed user gets no cache handle even with a valid token', async () => {
  await (await prep()).store(GOOD())
  prisma.state.users = prisma.state.users.filter((u) => u.id !== 'u-a1')
  assert.equal(await prep(), null)
})

test('graph cache: the caller must be confirmed in PostgreSQL as a member of the company (removed, moved, forged, missing)', async () => {
  assert.match(await graphCacheVersion(prisma, 'company-A', memberA), /^0\./)
  assert.equal(await graphCacheVersion(prisma, 'company-A'), null, 'no caller -> no cache')
  assert.equal(await graphCacheVersion(prisma, 'company-A', { userId: 'u-b1', companyId: 'company-A' }), null, 'a user of company B claiming company A')
  assert.equal(await graphCacheVersion(prisma, 'company-A', { userId: 'nobody', companyId: 'company-A' }), null, 'unknown user')
  assert.equal(await graphCacheVersion(prisma, 'company-A', { userId: 'u-a1', companyId: 'company-B' }), null, 'token company differs from the requested company')
  prisma.state.users = prisma.state.users.filter((u) => u.id !== 'u-a1')
  assert.equal(await graphCacheVersion(prisma, 'company-A', memberA), null, 'a removed user')
})
