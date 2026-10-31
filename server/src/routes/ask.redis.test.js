// Module 9.5: POST /api/ask with the answer cache on a REAL Redis server (started by this file, see
// test-helpers/redisServer.js). Everything else is the production code path: the real Express route, the real JWT
// middleware, the real rate limiter (in memory), the real RAG pipeline and the real knowledge-base versioning.
// Fakes: PostgreSQL (in memory), the vector service and the LLM provider (local HTTP servers), Neo4j (recording driver).
//
// What this adds to ask.cache.test.js (fake Redis client): real TTL expiry, real Redis outage / recovery in the middle of
// requests, concurrent identical requests, a knowledge change while a question is being answered, and checks of what is
// actually stored in Redis and written to the log.
//
//   npm run test:redis        (skipped when the redis-server binary is not installed)
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import jwt from 'jsonwebtoken'
import { createClient } from 'redis'
import { clearGraphEnv, makeFakeDriver, setGraphEnv } from '../test-helpers/fakeNeo4j.js'
import { fakeKnowledgeState } from '../test-helpers/fakeKnowledgeState.js'
import { SKIP_NO_REDIS_SERVER, startRedisServer } from '../test-helpers/redisServer.js'

const skip = SKIP_NO_REDIS_SERVER
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 8000, step = 25) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(step)
  }
  return false
}

const SECRET = 'unit-test-access-secret'
const GROQ_KEY = 'sk-test-not-a-real-key'
process.env.JWT_ACCESS_SECRET = SECRET
process.env.GROQ_API_KEY = GROQ_KEY
process.env.LLM_MODEL = 'test-model'
process.env.RATE_LIMIT_ASK_MAX = '100000'
// REDIS_URL must NOT be set while the route is imported (the rate limiter would open its own Redis connection).
delete process.env.REDIS_URL
for (const k of ['RAG_MIN_SCORE', 'RAG_TOP_K', 'ASK_CACHE_TTL', 'ASK_CACHE_ENABLED', 'REDIS_CACHE_TTL']) delete process.env[k]
clearGraphEnv()

// ---------- in-memory "PostgreSQL" ----------
const T0 = new Date('2026-10-01T00:00:00Z')
const fresh = () => ({
  users: [
    { id: 'u-a-member', companyId: 'company-A', role: 'MEMBER' },
    { id: 'u-a-admin', companyId: 'company-A', role: 'ADMIN' },
    { id: 'u-b-member', companyId: 'company-B', role: 'MEMBER' },
  ],
  docs: [
    { id: 'doc-a-refund', companyId: 'company-A', originalName: 'refund-policy.txt', updatedAt: T0 },
    { id: 'doc-b-leave', companyId: 'company-B', originalName: 'leave-policy.txt', updatedAt: T0 },
  ],
  ingestions: [],
})
let db = fresh()
const aggregate = (rows) => async ({ where }) => {
  const mine = rows().filter((r) => r.companyId === where.companyId)
  const newest = mine.map((r) => r.updatedAt).sort((a, b) => b - a)[0] ?? null
  return { _count: { _all: mine.length }, _max: { updatedAt: newest } }
}
const knowledge = fakeKnowledgeState()
mock.module('../prisma.js', {
  defaultExport: {
    ...knowledge.models,
    user: { findUnique: async ({ where }) => db.users.find((u) => u.id === where.id) ?? null },
    document: {
      findMany: async ({ where }) => db.docs.filter((d) => where.id.in.includes(d.id) && d.companyId === where.companyId).map((d) => ({ id: d.id, originalName: d.originalName })),
      aggregate: aggregate(() => db.docs),
    },
    graphIngestion: { aggregate: aggregate(() => db.ingestions) },
  },
})

const { default: express } = await import('express')
const { default: askRouter } = await import('./ask.js')
const { default: prisma } = await import('../prisma.js')
const cacheLayer = await import('../utils/redisCache.js')
const { setDriverForTests } = await import('../utils/neo4j.js')
const { beginKnowledgeChange, EFFECT, uncertainGraceSeconds } = await import('../utils/knowledgeVersion.js')

// ---------- fake vector service + fake LLM ----------
const CHUNKS = {
  'company-A': { documentId: 'doc-a-refund', documentName: 'refund-policy.txt', text: 'Customers can request a refund within 14 days of purchase. Refunds are paid within five business days.' },
  'company-B': { documentId: 'doc-b-leave', documentName: 'leave-policy.txt', text: 'Employees receive 25 days of paid leave per year.' },
}
const vector = { requests: 0 }
const vectorServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    vector.requests += 1
    const body = raw ? JSON.parse(raw) : {}
    const c = CHUNKS[body.companyId]
    const results = c ? [{ text: c.text, distance: 0.1, metadata: { companyId: body.companyId, documentId: c.documentId, documentName: c.documentName, chunkIndex: 0, startChar: 0, endChar: c.text.length } }] : []
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ results }))
  })
})
// mode: 'answer' | 'error500' | 'unanswerable'.  gate: a promise the LLM waits for before it answers (to hold a request in flight).
const llm = { calls: 0, mode: 'answer', gate: null, prompts: [] }
const llmServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', async () => {
    llm.calls += 1
    llm.prompts.push(raw)
    if (llm.gate) await llm.gate
    const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)) }
    if (llm.mode === 'error500') return send(500, { error: { type: 'api_error', message: 'boom' } })
    const answer = raw.includes('25 days of paid leave') ? 'Employees get 25 days of paid leave [1].' : 'Refunds can be requested within 14 days of purchase [1].'
    const content = llm.mode === 'unanswerable' ? { answerable: false, answer: '', citations: [] } : { answerable: true, answer, citations: [1] }
    send(200, { choices: [{ message: { content: JSON.stringify(content) } }] })
  })
})
await Promise.all([vectorServer, llmServer].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))))
process.env.EMBEDDING_SERVICE_URL = `http://127.0.0.1:${vectorServer.address().port}`
process.env.LLM_API_URL = `http://127.0.0.1:${llmServer.address().port}/openai/v1/chat/completions`
process.env.EMBEDDING_SERVICE_TOKEN = 'test-token'

const app = express()
app.use(express.json())
app.use('/api/ask', askRouter)
const appServer = !skip ? await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) }) : null
const base = appServer ? `http://127.0.0.1:${appServer.address().port}` : ''

// ---------- real Redis ----------
let server = null
let raw = null
if (!skip) {
  server = await startRedisServer()
  raw = createClient({ url: server.url })
  raw.on('error', () => {})
  await raw.connect()
}
const connectCache = async () => {
  await cacheLayer.closeRedisCache()
  process.env.REDIS_URL = server.url
  process.env.REDIS_CONNECT_TIMEOUT = '500'
  return cacheLayer.initRedisCache()
}
const answerKeys = () => raw.keys('memhub:cache:*:ask:*')
const waitForAnswers = (count = 1) => until(async () => (await answerKeys()).length >= count)

const tokenFor = (companyId, userId) => jwt.sign({ userId, companyId, role: 'MEMBER' }, SECRET)
const TOKEN = { member: tokenFor('company-A', 'u-a-member'), admin: tokenFor('company-A', 'u-a-admin'), b: tokenFor('company-B', 'u-b-member') }
const Q = 'How long do I have to request a refund?'
const ask = (token, question = Q) =>
  fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ question }),
  }).then(async (res) => ({ status: res.status, cache: res.headers.get('x-cache'), body: await res.json().catch(() => null) }))

let logs = []
test.beforeEach(async () => {
  if (skip) return
  logs = []
  for (const level of ['log', 'warn', 'error']) mock.method(console, level, (...a) => logs.push(`${level}: ${a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`))
  await server.start() // no-op unless an outage test left it stopped
  await connectCache()
  await until(() => cacheLayer.getRedisStatus().status === 'ok')
  await raw.flushAll()
  db = fresh()
  knowledge.state.versions.clear()
  knowledge.state.leases = []
  knowledge.state.advances = []
  vector.requests = 0
  Object.assign(llm, { calls: 0, mode: 'answer', gate: null, prompts: [] })
  delete process.env.ASK_CACHE_TTL
  clearGraphEnv()
  setDriverForTests(null)
})
test.afterEach(() => mock.restoreAll())
test.after(async () => {
  if (skip) return
  await cacheLayer.closeRedisCache()
  await raw.quit().catch(() => {})
  await server.close()
  setDriverForTests(null)
  clearGraphEnv()
  delete process.env.REDIS_URL
  for (const s of [appServer, vectorServer, llmServer]) { s.closeAllConnections?.(); s.close() }
})

// =====================================================================================================
// 2. /api/ask: hit, miss, expiry, isolation, scopes, errors, authorization, Redis outage
// =====================================================================================================

test('first question is a cache miss (pipeline runs, answer stored); the repeated question is a hit that skips vector search and Groq', { skip }, async () => {
  const first = await ask(TOKEN.member)
  assert.equal(first.status, 200)
  assert.equal(first.cache, 'MISS')
  assert.equal(first.body.grounded, true)
  assert.equal(llm.calls, 1)
  assert.equal(vector.requests, 1)
  assert.ok(await waitForAnswers(1), 'the answer must be stored in Redis')

  const second = await ask(TOKEN.member, `  ${Q.toUpperCase()}  `) // same question, written differently
  assert.equal(second.status, 200)
  assert.equal(second.cache, 'HIT')
  assert.deepEqual(second.body, first.body)
  assert.equal(llm.calls, 1, 'Groq is not called on a hit')
  assert.equal(vector.requests, 1, 'vector search does not run on a hit')

  const other = await ask(TOKEN.member, 'How are refunds paid?') // a different question is a different entry
  assert.equal(other.cache, 'MISS')
  assert.equal(llm.calls, 2)
})

test('the stored answer really carries a TTL; after it expires the question triggers a fresh retrieval', { skip }, async () => {
  process.env.ASK_CACHE_TTL = '1'
  const first = await ask(TOKEN.member)
  assert.equal(first.cache, 'MISS')
  assert.ok(await waitForAnswers(1))
  const [key] = await answerKeys()
  const pttl = await raw.pTTL(key)
  assert.ok(pttl > 0 && pttl <= 1000, `expected a TTL of at most 1 s, got ${pttl} ms`)
  const hit = await ask(TOKEN.member)
  assert.equal(hit.cache, 'HIT')
  assert.equal(llm.calls, 1)

  assert.ok(await until(async () => (await answerKeys()).length === 0, 4000), 'Redis must expire the entry')
  const again = await ask(TOKEN.member)
  assert.equal(again.cache, 'MISS')
  assert.equal(again.status, 200)
  assert.equal(llm.calls, 2, 'Groq ran again')
  assert.equal(vector.requests, 2, 'vector retrieval ran again')
  assert.deepEqual(again.body, first.body)
})

test('different companies use separate entries (and the same question never returns the other company\'s answer)', { skip }, async () => {
  const a = await ask(TOKEN.member)
  const b = await ask(TOKEN.b)
  assert.equal(a.cache, 'MISS')
  assert.equal(b.cache, 'MISS', 'company B must not hit company A\'s entry')
  assert.match(a.body.answer, /14 days/)
  assert.match(b.body.answer, /25 days/)
  assert.ok(await waitForAnswers(2))

  const keys = await answerKeys()
  assert.equal(keys.length, 2)
  assert.equal(keys.filter((k) => k.startsWith('memhub:cache:company-A:ask:')).length, 1)
  assert.equal(keys.filter((k) => k.startsWith('memhub:cache:company-B:ask:')).length, 1)

  const a2 = await ask(TOKEN.member)
  const b2 = await ask(TOKEN.b)
  assert.deepEqual([a2.cache, b2.cache], ['HIT', 'HIT'])
  assert.match(a2.body.answer, /14 days/)
  assert.match(b2.body.answer, /25 days/)
  assert.ok(!JSON.stringify(b2.body).includes('refund'), 'nothing of company A in company B\'s response')
  assert.equal(llm.calls, 2)
})

test('different authorization scopes use separate entries; the role comes from PostgreSQL, so a changed role switches scope at once', { skip }, async () => {
  const member = await ask(TOKEN.member)
  const admin = await ask(TOKEN.admin)
  assert.deepEqual([member.cache, admin.cache], ['MISS', 'MISS'], 'an ADMIN must not be served the MEMBER\'s entry')
  assert.ok(await waitForAnswers(2))
  assert.equal((await answerKeys()).length, 2)

  assert.equal((await ask(TOKEN.member)).cache, 'HIT')
  assert.equal((await ask(TOKEN.admin)).cache, 'HIT')

  // The member is promoted. The token still says MEMBER; PostgreSQL decides.
  db.users.find((u) => u.id === 'u-a-member').role = 'ADMIN'
  assert.equal((await ask(TOKEN.member)).cache, 'HIT', 'now in the ADMIN scope, whose entry exists')
  // A brand-new role scope: nothing cached under it yet.
  db.users.find((u) => u.id === 'u-a-member').role = 'AUDITOR'
  assert.equal((await ask(TOKEN.member)).cache, 'MISS')
  assert.equal(knowledge.state.advances.length, 0, 'a role change never flushes the knowledge-base version')
})

test('Groq errors are never cached: the error is returned as before and the next request runs the pipeline', { skip }, async () => {
  llm.mode = 'error500'
  const failed = await ask(TOKEN.member)
  assert.equal(failed.status, 502)
  assert.equal(failed.body.success, false)
  assert.equal(typeof failed.body.message, 'string')
  assert.equal(typeof failed.body.code, 'string')
  assert.deepEqual(Object.keys(failed.body).sort(), ['code', 'message', 'success'])
  await sleep(100)
  assert.equal((await answerKeys()).length, 0)

  llm.mode = 'answer'
  const ok = await ask(TOKEN.member)
  assert.equal(ok.status, 200)
  assert.equal(ok.cache, 'MISS')
  assert.equal(llm.calls, 2)
  assert.ok(await waitForAnswers(1))
})

test('"not grounded" results are never cached (not indexed, not enough information)', { skip }, async () => {
  llm.mode = 'unanswerable'
  const unanswerable = await ask(TOKEN.member)
  assert.equal(unanswerable.body.grounded, false)
  assert.equal(unanswerable.body.reason, 'not_enough_info')

  db.users.push({ id: 'u-c', companyId: 'company-C', role: 'MEMBER' }) // a company with nothing indexed
  const empty = await ask(tokenFor('company-C', 'u-c'))
  assert.equal(empty.body.reason, 'not_indexed')
  await sleep(100)
  assert.equal((await answerKeys()).length, 0)
})

test('graph retrieval errors are not cached as complete answers; once the graph is back the full answer is built and cached', { skip }, async () => {
  setGraphEnv()
  const driver = makeFakeDriver()
  driver.state.failWith = Object.assign(new Error('neo4j down'), { code: 'ServiceUnavailable' })
  setDriverForTests(driver)

  const degraded = await ask(TOKEN.member)
  assert.equal(degraded.status, 200)
  assert.equal(degraded.body.grounded, true)
  assert.equal(degraded.body.retrieval.graph.status, 'unavailable')
  await sleep(100)
  assert.equal((await answerKeys()).length, 0, 'a vector-only answer must not be cached')

  driver.state.failWith = null // Neo4j recovers
  const complete = await ask(TOKEN.member)
  assert.equal(complete.cache, 'MISS', 'the degraded answer was not served')
  assert.equal(complete.body.retrieval.graph.status, 'ok')
  assert.equal(llm.calls, 2)
  assert.ok(await waitForAnswers(1))
  assert.equal((await ask(TOKEN.member)).cache, 'HIT')
})

test('unauthorized callers never receive a cached answer (no token, bad token, expired token, forged company, removed user, moved user)', { skip }, async () => {
  assert.equal((await ask(TOKEN.member)).cache, 'MISS')
  assert.ok(await waitForAnswers(1))
  const before = await raw.dbSize()
  const llmBefore = llm.calls

  assert.equal((await ask(null)).status, 401)
  assert.equal((await ask(jwt.sign({ userId: 'u-a-member', companyId: 'company-A' }, 'another-secret'))).status, 401)
  assert.equal((await ask(jwt.sign({ userId: 'u-a-member', companyId: 'company-A' }, SECRET, { expiresIn: -10 }))).status, 401)
  assert.equal((await ask('not.a.jwt')).status, 401)
  assert.equal(await raw.dbSize(), before, 'rejected requests do not touch Redis')
  assert.equal(llm.calls, llmBefore)

  // Valid signature, but PostgreSQL does not back the claim: the cache is bypassed, never read.
  const removed = await ask(tokenFor('company-A', 'ghost-user'))
  assert.equal(removed.cache, null, 'a removed user gets no cache involvement')
  const forgedCompany = await ask(tokenFor('company-A', 'u-b-member')) // user of B with a token claiming company A
  assert.equal(forgedCompany.cache, null)
  assert.ok(!JSON.stringify(forgedCompany.body).includes('25 days'), 'and company B\'s data does not appear either')

  db.users.find((u) => u.id === 'u-a-member').companyId = 'company-B' // moved to another company, token still says A
  const moved = await ask(TOKEN.member)
  assert.equal(moved.cache, null)
  assert.equal((await answerKeys()).length, 1, 'bypassed callers also write nothing')
})

test('Redis unavailability does not break answering: Redis killed -> normal 200 answers; Redis back -> caching resumes', { skip }, async () => {
  assert.equal((await ask(TOKEN.member)).cache, 'MISS')
  assert.ok(await waitForAnswers(1))

  await server.stop()
  assert.ok(await until(() => cacheLayer.getRedisStatus().status === 'unavailable', 4000))
  const t0 = Date.now()
  const down = await ask(TOKEN.member)
  assert.equal(down.status, 200)
  assert.equal(down.body.grounded, true)
  assert.equal(down.cache, null, 'no cache header while the cache is unavailable')
  assert.equal(llm.calls, 2, 'the pipeline answered')
  assert.ok(Date.now() - t0 < 3000, 'an outage must not stall the request')

  await server.start()
  assert.ok(await until(() => cacheLayer.getRedisStatus().status === 'ok', 15000), 'the client reconnects by itself')
  assert.equal((await ask(TOKEN.member)).cache, 'MISS', 'the restarted server is empty')
  assert.ok(await waitForAnswers(1))
  assert.equal((await ask(TOKEN.member)).cache, 'HIT')
  assert.equal(llm.calls, 3)
})

test('Redis dying in the MIDDLE of a request: the client still gets its normal answer', { skip }, async () => {
  let release
  llm.gate = new Promise((r) => { release = r })
  const pending = ask(TOKEN.member) // passes the cache check (MISS) and waits inside the LLM call
  assert.ok(await until(() => llm.calls === 1))
  await server.stop()
  assert.ok(await until(() => cacheLayer.getRedisStatus().status === 'unavailable', 4000))
  release()
  const r = await pending
  assert.equal(r.status, 200)
  assert.equal(r.cache, 'MISS')
  assert.equal(r.body.grounded, true)
  assert.ok(!logs.some((l) => l.startsWith('error: Ask error')), 'a failed cache write is not an error of the request')
})

// =====================================================================================================
// 3. Invalidation (the real knowledge-version code, real Redis epoch)
// =====================================================================================================
async function primed() {
  assert.equal((await ask(TOKEN.member)).cache, 'MISS')
  assert.ok(await waitForAnswers(1))
  assert.equal((await ask(TOKEN.member)).cache, 'HIT')
}

test('document upload invalidates: the old answer is unreachable the moment the change settles', { skip }, async () => {
  await primed()
  const change = await beginKnowledgeChange(prisma, 'company-A', 'upload')
  db.docs.push({ id: 'doc-a-new', companyId: 'company-A', originalName: 'new.txt', updatedAt: new Date('2026-10-02T00:00:00Z') })
  change.record(EFFECT.CHANGED)
  const during = await ask(TOKEN.member)
  assert.equal(during.cache, null, 'while the upload runs, the cache is bypassed (nothing read, nothing stored)')
  await change.settle()
  const after = await ask(TOKEN.member)
  assert.equal(after.cache, 'MISS')
  assert.equal(llm.calls, 3, 'one real answer during the upload, one after it')
})

test('document deletion invalidates', { skip }, async () => {
  await primed()
  const change = await beginKnowledgeChange(prisma, 'company-A', 'delete')
  await change.step(async () => { db.docs = db.docs.filter((d) => d.id !== 'doc-a-refund') }, { onError: () => EFFECT.NONE })
  await change.settle()
  const r = await ask(TOKEN.member)
  assert.equal(r.cache, 'MISS')
  assert.equal(r.body.grounded, false, 'the deleted document can no longer be cited')
  assert.equal(r.body.reason, 'not_indexed')
})

test('document reprocessing / indexed chunk changes invalidate (vector write that changes nothing in PostgreSQL)', { skip }, async () => {
  await primed()
  const change = await beginKnowledgeChange(prisma, 'company-A', 'reindex')
  await change.step(async () => 3, { onError: () => EFFECT.NONE }) // ChromaDB rewrote the document's chunks
  await change.settle()
  assert.equal((await ask(TOKEN.member)).cache, 'MISS')
  assert.equal(knowledge.state.advances.length, 1)
})

test('graph updates invalidate: a graph rewrite and a PostgreSQL ingestion record both make the old answer unreachable', { skip }, async () => {
  await primed()
  const change = await beginKnowledgeChange(prisma, 'company-A', 'graph-reprocess')
  change.record(EFFECT.CHANGED)
  await change.settle()
  assert.equal((await ask(TOKEN.member)).cache, 'MISS')
  assert.ok(await waitForAnswers(2))
  assert.equal((await ask(TOKEN.member)).cache, 'HIT')

  // A change made behind the application's back (script / SQL): the fingerprint of GraphIngestion differs.
  db.ingestions.push({ companyId: 'company-A', updatedAt: new Date('2026-10-03T00:00:00Z') })
  assert.equal((await ask(TOKEN.member)).cache, 'MISS')
})

test('a knowledge-base version change on its own (counter advanced) invalidates, for this company only', { skip }, async () => {
  await primed()
  assert.equal((await ask(TOKEN.b)).cache, 'MISS')
  assert.ok(await waitForAnswers(2))
  knowledge.state.versions.set('company-A', 5)
  assert.equal((await ask(TOKEN.member)).cache, 'MISS')
  assert.equal((await ask(TOKEN.b)).cache, 'HIT', 'company B keeps its cache')
})

test('rotating the Redis epoch (invalidateCompanyKnowledge) makes every answer of that company unreachable, and only that company\'s', { skip }, async () => {
  const { invalidateCompanyKnowledge } = await import('../utils/knowledgeVersion.js')
  await primed()
  assert.equal((await ask(TOKEN.b)).cache, 'MISS')
  assert.ok(await waitForAnswers(2))
  assert.equal(await invalidateCompanyKnowledge('company-A'), true)
  assert.equal((await ask(TOKEN.member)).cache, 'MISS')
  assert.equal((await ask(TOKEN.b)).cache, 'HIT')
})

test('failed ingestion: a failure that provably wrote nothing keeps the cache; one with an unknown outcome quarantines it', { skip }, async () => {
  await primed()
  const harmless = await beginKnowledgeChange(prisma, 'company-A', 'upload')
  await assert.rejects(harmless.step(async () => { throw new Error('embedding failed') }, { onError: () => EFFECT.NONE }))
  await harmless.settle()
  assert.equal((await ask(TOKEN.member)).cache, 'HIT', 'nothing changed, so valid entries stay valid')
  assert.equal(knowledge.state.advances.length, 0)

  const unsure = await beginKnowledgeChange(prisma, 'company-A', 'upload')
  await assert.rejects(unsure.step(async () => { throw new Error('timeout') }, { onError: () => EFFECT.UNKNOWN }))
  await unsure.settle()
  assert.equal(knowledge.state.advances.length, 1, 'the version advanced')
  const quarantined = await ask(TOKEN.member)
  assert.equal(quarantined.cache, null, 'cache is off while a late write could still land')
  assert.equal(quarantined.status, 200)
  assert.ok(uncertainGraceSeconds() >= 10)
  await sleep(100)
  assert.equal((await answerKeys()).length, 1, 'nothing new was stored during the quarantine (only the entry of the old version remains)')
})

test('a knowledge change DURING a question: the in-flight answer is stored under the old version and is never served afterwards', { skip }, async () => {
  let release
  llm.gate = new Promise((r) => { release = r })
  const inFlight = ask(TOKEN.member)
  assert.ok(await until(() => llm.calls === 1))

  const change = await beginKnowledgeChange(prisma, 'company-A', 'upload') // an upload lands while the LLM is thinking
  db.docs.push({ id: 'doc-a-late', companyId: 'company-A', originalName: 'late.txt', updatedAt: new Date('2026-10-04T00:00:00Z') })
  change.record(EFFECT.CHANGED)
  await change.settle()
  llm.gate = null
  release()
  const stale = await inFlight
  assert.equal(stale.status, 200)
  assert.ok(await waitForAnswers(1), 'the in-flight answer is stored, under the version it was computed for')

  const next = await ask(TOKEN.member)
  assert.equal(next.cache, 'MISS', 'it is NOT served as the answer of the new knowledge base')
  assert.equal(llm.calls, 2)
  assert.equal(vector.requests, 2, 'fresh retrieval over the new knowledge base')
})

// =====================================================================================================
// 4. Response compatibility: cached == uncached
// =====================================================================================================
test('cached and uncached responses are identical: answer, sources, graph facts, retrieval metadata, status codes', { skip }, async () => {
  setGraphEnv()
  const fact = {
    relId: 'rel-1', rel: 'RESOLVED', fromUid: 'company-A:PERSON:p', fromName: 'Priya Rao', fromType: 'PERSON',
    toUid: 'company-A:ISSUE:i', toName: 'refund backlog', toType: 'ISSUE',
    evidence: 'Priya resolved the refund backlog', documentId: 'doc-a-refund', chunkIndex: 0, confidence: 0.96,
  }
  setDriverForTests(makeFakeDriver((cypher) => {
    if (cypher.includes('RETURN DISTINCT e.uid AS uid') || cypher.includes('normalizedKey IN $keys')) return [{ uid: 'company-A:PERSON:p' }]
    if (cypher.includes('AS fromUid')) return [fact]
    return []
  }))

  const miss = await ask(TOKEN.member)
  assert.equal(miss.status, 200)
  assert.equal(miss.cache, 'MISS')
  assert.ok(await waitForAnswers(1))
  const hit = await ask(TOKEN.member)
  assert.equal(hit.status, 200)
  assert.equal(hit.cache, 'HIT')
  assert.deepEqual(hit.body, miss.body, 'a hit is byte-for-byte what the pipeline produced')
  assert.equal(JSON.stringify(hit.body), JSON.stringify(miss.body), 'same key order too')

  const b = miss.body
  assert.deepEqual(Object.keys(b), ['success', 'grounded', 'answer', 'sources', 'retrieval'])
  assert.equal(b.success, true)
  assert.equal(b.grounded, true)
  assert.match(b.answer, /14 days/)
  assert.equal(b.sources[0].documentName, 'refund-policy.txt')
  assert.equal(b.sources[0].kind, 'chunk')
  assert.ok(Array.isArray(b.sources[0].graphFacts) && b.sources[0].graphFacts.length >= 1, 'graph facts survive caching')
  assert.deepEqual(b.retrieval.vector, { status: 'ok', chunks: 1 })
  assert.equal(b.retrieval.graph.status, 'ok')
  assert.ok(b.retrieval.graph.facts >= 1)

  // ... and equals what an installation WITHOUT Redis answers (apart from the X-Cache header).
  await cacheLayer.closeRedisCache()
  delete process.env.REDIS_URL
  const plain = await ask(TOKEN.member)
  assert.equal(plain.cache, null)
  assert.deepEqual(plain.body, miss.body)
})

test('existing status codes and error structure are unchanged on the cached path', { skip }, async () => {
  await primed()
  const noQuestion = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN.member}` }, body: '{}' })
  assert.equal(noQuestion.status, 400)
  assert.deepEqual(await noQuestion.json(), { success: false, message: 'A question is required' })
  const tooLong = await ask(TOKEN.member, 'x'.repeat(1001))
  assert.equal(tooLong.status, 400)
  assert.deepEqual(tooLong.body, { success: false, message: 'The question is too long (maximum 1000 characters)' })
  const unauth = await ask(null)
  assert.equal(unauth.status, 401)
  assert.equal(unauth.body.success, false)
})

// =====================================================================================================
// 5. Security audit
// =====================================================================================================
test('every key and value in Redis is namespaced by company; the question text is never in a key; no other company\'s data is stored', { skip }, async () => {
  await ask(TOKEN.member)
  await ask(TOKEN.b, 'How many days of paid leave do I get?')
  assert.ok(await waitForAnswers(2))

  const all = await raw.keys('*')
  assert.ok(all.length >= 4, 'two answers + two epochs')
  assert.ok(all.every((k) => k.startsWith('memhub:cache:company-')), 'nothing outside the memhub:cache:<company> namespace')
  for (const key of await answerKeys()) {
    const decoded = decodeURIComponent(key).toLowerCase()
    assert.ok(!decoded.includes('refund') && !decoded.includes('leave') && !decoded.includes('how'), `the question must not appear in the key: ${key}`)
    const company = key.split(':')[2]
    const entry = JSON.parse(await raw.get(key))
    assert.equal(entry.companyId, company, 'the entry belongs to the company in its key')
    assert.ok(entry.response.sources.every((s) => s.documentId === (company === 'company-A' ? 'doc-a-refund' : 'doc-b-leave')))
    assert.ok(!JSON.stringify(entry).includes(SECRET) && !JSON.stringify(entry).includes(GROQ_KEY), 'no credentials in cached values')
    assert.ok(!('token' in entry) && !('userId' in entry), 'no user identity in a cached entry')
  }
})

test('a planted / tampered entry is never served: wrong company, wrong version, wrong shape', { skip }, async () => {
  await primed()
  const [keyA] = await answerKeys()
  const real = JSON.parse(await raw.get(keyA))

  // Company B's answer planted under company A's key.
  const planted = { ...real, companyId: 'company-B', response: { ...real.response, answer: 'PLANTED' } }
  await raw.set(keyA, JSON.stringify(planted), { EX: 60 })
  const r1 = await ask(TOKEN.member)
  assert.equal(r1.cache, 'MISS')
  assert.ok(!JSON.stringify(r1.body).includes('PLANTED'))

  // A non-grounded body under the right key.
  assert.ok(await waitForAnswers(1))
  const [key2] = await answerKeys()
  const entry2 = JSON.parse(await raw.get(key2))
  await raw.set(key2, JSON.stringify({ ...entry2, response: { success: true, grounded: false, answer: 'x', sources: [], retrieval: {} } }), { EX: 60 })
  assert.equal((await ask(TOKEN.member)).cache, 'MISS')

  // Garbage.
  await raw.set(key2, '<<<not json>>>', { EX: 60 })
  const r3 = await ask(TOKEN.member)
  assert.equal(r3.status, 200)
  assert.equal(r3.cache, 'MISS')
})

test('concurrent identical requests: every client gets the same correct answer, exactly ONE entry exists, and the next request is a hit', { skip }, async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => ask(TOKEN.member)))
  assert.ok(results.every((r) => r.status === 200 && r.body.grounded === true))
  assert.ok(results.every((r) => JSON.stringify(r.body) === JSON.stringify(results[0].body)))
  assert.ok(await waitForAnswers(1))
  await sleep(150)
  assert.equal((await answerKeys()).length, 1, 'concurrent writers converge on one key')
  assert.equal((await ask(TOKEN.member)).cache, 'HIT')
  // KNOWN, DOCUMENTED LIMIT: there is no single-flight lock, so a burst of identical cold requests each call Groq once.
  assert.ok(llm.calls >= 1 && llm.calls <= 12)

  // Concurrent requests of two companies and two roles never cross.
  const mixed = await Promise.all([ask(TOKEN.member), ask(TOKEN.b), ask(TOKEN.admin), ask(TOKEN.b), ask(TOKEN.member)])
  assert.ok(mixed[0].body.answer.includes('14 days') && mixed[4].body.answer.includes('14 days') && mixed[2].body.answer.includes('14 days'))
  assert.ok(mixed[1].body.answer.includes('25 days') && mixed[3].body.answer.includes('25 days'))
})

test('sensitive information never reaches the log: no question text, token, secret, API key or Redis URL', { skip }, async () => {
  const secretQuestion = 'What is the salary of Zebediah Quillfeather?'
  await ask(TOKEN.member, secretQuestion)
  assert.ok(await waitForAnswers(1))
  await ask(TOKEN.member, secretQuestion) // hit
  llm.mode = 'error500'
  await ask(TOKEN.member, 'Another distinct question about Quillfeather?') // provider failure
  llm.mode = 'answer'
  await ask(TOKEN.admin, secretQuestion)
  await ask(tokenFor('company-A', 'ghost-user'), secretQuestion) // bypassed caller
  await server.stop()
  await until(() => cacheLayer.getRedisStatus().status === 'unavailable', 4000)
  await ask(TOKEN.member, secretQuestion) // Redis down
  await cacheLayer.checkRedisHealth()

  const text = logs.join('\n')
  assert.ok(logs.length > 0)
  for (const needle of ['Quillfeather', 'Zebediah', 'salary', SECRET, GROQ_KEY, TOKEN.member, TOKEN.admin, process.env.EMBEDDING_SERVICE_TOKEN, server.url, `127.0.0.1:${server.port}`, 'u-a-member', 'u-a-admin']) {
    assert.ok(!text.includes(needle), `the log must not contain ${needle.slice(0, 12)}...`)
  }
})

test('no unhandled promise rejections and no second Redis connection are created by the cache layer', { skip }, async () => {
  const rejections = []
  const onRejection = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  try {
    const before = Number((await raw.info('clients')).match(/connected_clients:(\d+)/)[1])
    await Promise.all(Array.from({ length: 20 }, (_, i) => ask(TOKEN.member, `question number ${i}`)))
    await cacheLayer.initRedisCache() // idempotent
    await cacheLayer.initRedisCache()
    const after = Number((await raw.info('clients')).match(/connected_clients:(\d+)/)[1])
    assert.equal(after, before, 'requests and repeated init() calls must not open new connections')
    // Requests while the server is gone, then a restart: nothing may leak out as an unhandled rejection.
    await server.stop()
    await Promise.all(Array.from({ length: 5 }, () => ask(TOKEN.member)))
    await server.start()
    await sleep(300)
  } finally {
    process.off('unhandledRejection', onRejection)
  }
  assert.deepEqual(rejections, [])
})
