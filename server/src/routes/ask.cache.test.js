// Module 9.2: the /api/ask response cache, exercised through the REAL Express route, the REAL JWT middleware and
// the REAL RAG pipeline. Fakes: vector service (HTTP), LLM provider (HTTP, counts calls), Redis client, Prisma,
// Neo4j driver. They prove the cache sits in front of the existing pipeline and never replaces it:
//   a hit skips vector search + Groq; every other situation runs the normal pipeline.
//
// Needs: node --experimental-test-module-mocks   (already set in the "test" script)
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import jwt from 'jsonwebtoken'
import { clearGraphEnv, makeFakeDriver, setGraphEnv } from '../test-helpers/fakeNeo4j.js'
import { fakeKnowledgeState } from '../test-helpers/fakeKnowledgeState.js'

process.env.JWT_ACCESS_SECRET = 'unit-test-access-secret'
process.env.GROQ_API_KEY = 'sk-test-not-a-real-key'
process.env.LLM_MODEL = 'test-model'
process.env.RATE_LIMIT_ASK_MAX = '100000'
// IMPORTANT: REDIS_URL must NOT be set while the route is imported, otherwise the rate limiter would try to
// connect to a real Redis. It is set later, just for the cache (which uses its own, fake, connection).
delete process.env.REDIS_URL
for (const k of ['RAG_MIN_SCORE', 'RAG_TOP_K', 'ASK_CACHE_TTL', 'ASK_CACHE_ENABLED', 'REDIS_CACHE_TTL']) delete process.env[k]
clearGraphEnv()

// ---------- in-memory "PostgreSQL" ----------
const db = {
  users: [
    { id: 'user-of-company-A', companyId: 'company-A', role: 'MEMBER' },
    { id: 'user-of-company-B', companyId: 'company-B', role: 'MEMBER' },
  ],
  docs: [
    { id: 'doc-a-refund', companyId: 'company-A', originalName: 'refund-policy.txt', updatedAt: new Date('2026-10-01T00:00:00Z') },
    { id: 'doc-b-other', companyId: 'company-B', originalName: 'other.txt', updatedAt: new Date('2026-10-01T00:00:00Z') },
  ],
}
const aggregate = (rows) => async ({ where }) => {
  const mine = rows().filter((r) => r.companyId === where.companyId)
  const newest = mine.map((r) => r.updatedAt).sort((a, b) => b - a)[0] ?? null
  return { _count: { _all: mine.length }, _max: { updatedAt: newest } }
}
const knowledge = fakeKnowledgeState() // Module 9.4: Company.knowledgeVersion + KnowledgeChange leases
mock.module('../prisma.js', {
  defaultExport: {
    ...knowledge.models,
    user: { findUnique: async ({ where }) => db.users.find((u) => u.id === where.id) ?? null },
    document: {
      findMany: async ({ where }) => db.docs.filter((d) => where.id.in.includes(d.id) && d.companyId === where.companyId).map((d) => ({ id: d.id, originalName: d.originalName })),
      aggregate: aggregate(() => db.docs),
    },
    graphIngestion: { aggregate: aggregate(() => []) },
  },
})

const { default: express } = await import('express')
const { default: askRouter } = await import('./ask.js')
const { initRedisCache, closeRedisCache, setRedisClientFactoryForTests } = await import('../utils/redisCache.js')
const { setDriverForTests } = await import('../utils/neo4j.js')

// ---------- fake Redis ----------
function fakeRedis({ broken = false } = {}) {
  const store = new Map()
  const c = new EventEmitter()
  const boom = async () => { throw new Error('ECONNRESET') }
  Object.assign(c, {
    isOpen: false, isReady: false,
    connect: async () => { c.isOpen = true; c.isReady = true; c.emit('ready') },
    get: broken ? boom : async (key) => (store.has(key) ? store.get(key) : null),
    sendCommand: broken ? boom : async (args) => {
      const [, key, value, ...opts] = args
      if (opts.includes('NX') && store.has(key)) return null
      store.set(key, value)
      return 'OK'
    },
    ping: async () => 'PONG', quit: async () => { c.isOpen = false; c.isReady = false }, disconnect: () => {},
  })
  return { client: c, store }
}
let redis
async function useRedis(options) {
  await closeRedisCache()
  redis = fakeRedis(options)
  setRedisClientFactoryForTests(() => redis.client)
  process.env.REDIS_URL = 'redis://127.0.0.1:6379'
  process.env.REDIS_CONNECT_TIMEOUT = '200'
  await initRedisCache()
}
const answerKeys = () => [...redis.store.keys()].filter((k) => k.includes(':ask:'))
async function waitForStoredAnswer(count = 1) {
  for (let i = 0; i < 100 && answerKeys().length < count; i += 1) await new Promise((r) => setTimeout(r, 10))
}

// ---------- fake vector service + fake LLM ----------
const CHUNK = { companyId: 'company-A', documentId: 'doc-a-refund', documentName: 'refund-policy.txt', chunkIndex: 0, startChar: 0, endChar: 96,
  text: 'Customers can request a refund within 14 days of purchase. Refunds are paid within five business days.' }
const vector = { requests: 0 }
const vectorServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    vector.requests += 1
    const body = raw ? JSON.parse(raw) : {}
    const results = body.companyId === 'company-A' ? [{ text: CHUNK.text, distance: 0.1, metadata: { ...CHUNK } }] : []
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ results }))
  })
})
await new Promise((r) => vectorServer.listen(0, '127.0.0.1', r))

const llm = { calls: 0, mode: 'answer' }
const llmServer = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    llm.calls += 1
    const send = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)) }
    if (llm.mode === 'error500') return send(500, { error: { type: 'api_error', message: 'boom' } })
    const content = llm.mode === 'unanswerable'
      ? { answerable: false, answer: '', citations: [] }
      : { answerable: true, answer: 'Refunds can be requested within 14 days of purchase [1].', citations: [1] }
    send(200, { choices: [{ message: { content: JSON.stringify(content) } }] })
  })
})
await new Promise((r) => llmServer.listen(0, '127.0.0.1', r))
process.env.EMBEDDING_SERVICE_URL = `http://127.0.0.1:${vectorServer.address().port}`
process.env.LLM_API_URL = `http://127.0.0.1:${llmServer.address().port}/openai/v1/chat/completions`
process.env.EMBEDDING_SERVICE_TOKEN = 'test-token'

const app = express()
app.use(express.json())
app.use('/api/ask', askRouter)
const appServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${appServer.address().port}`

const tokenFor = (companyId, userId = `user-of-${companyId}`) => jwt.sign({ userId, companyId, role: 'MEMBER' }, process.env.JWT_ACCESS_SECRET)
const tokenA = tokenFor('company-A')
const ask = (token, question = 'How long do I have to request a refund?') =>
  fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ question }),
  }).then(async (res) => ({ status: res.status, cache: res.headers.get('x-cache'), body: await res.json().catch(() => null) }))

test.beforeEach(async () => {
  for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {})
  await useRedis()
  vector.requests = 0
  llm.calls = 0
  llm.mode = 'answer'
  db.docs[0].updatedAt = new Date('2026-10-01T00:00:00Z')
  clearGraphEnv()
  setDriverForTests(null)
})
test.afterEach(() => mock.restoreAll())
test.after(async () => {
  await closeRedisCache()
  setRedisClientFactoryForTests(null)
  setDriverForTests(null)
  clearGraphEnv()
  for (const s of [appServer, vectorServer, llmServer]) { s.closeAllConnections?.(); s.close() }
})

// ---------- hit / miss ----------
test('miss runs the pipeline and stores; the identical question is then a hit that skips vector search and Groq', async () => {
  const first = await ask(tokenA)
  assert.equal(first.status, 200)
  assert.equal(first.cache, 'MISS')
  assert.equal(first.body.grounded, true)
  assert.equal(llm.calls, 1)
  const vectorCalls = vector.requests
  await waitForStoredAnswer()

  const second = await ask(tokenA, '  HOW long do I have to request a REFUND?? ')
  assert.equal(second.status, 200)
  assert.equal(second.cache, 'HIT')
  assert.deepEqual(second.body, first.body, 'the cached response is exactly what the pipeline produced')
  assert.equal(llm.calls, 1, 'Groq must not be called on a hit')
  assert.equal(vector.requests, vectorCalls, 'vector search must not run on a hit')
})

test('the response contract is unchanged on a hit: answer, sources (with graph fields), retrieval metadata, no extra body fields', async () => {
  await ask(tokenA)
  await waitForStoredAnswer()
  const { body } = await ask(tokenA)
  assert.deepEqual(Object.keys(body).sort(), ['answer', 'grounded', 'retrieval', 'sources', 'success'])
  assert.deepEqual(body.retrieval, { vector: { status: 'ok', chunks: 1 }, graph: { status: 'disabled', facts: 0 } })
  assert.equal(body.sources[0].documentName, 'refund-policy.txt')
  assert.equal(body.sources[0].kind, 'chunk')
  assert.match(body.answer, /14 days/)
})

// ---------- isolation and authorization ----------
test('company B asking the same question never receives company A\'s cached answer', async () => {
  await ask(tokenA)
  await waitForStoredAnswer()
  const b = await ask(tokenFor('company-B'))
  assert.equal(b.status, 200)
  assert.equal(b.cache, 'MISS')
  assert.equal(b.body.grounded, false)
  assert.ok(!JSON.stringify(b.body).includes('14 days'))
  assert.ok(answerKeys().every((k) => k.startsWith('memhub:cache:company-A:')), 'a not-grounded answer of B is not stored either')
})

test('no token / bad token: 401 and nothing is read or written in Redis', async () => {
  await ask(tokenA)
  await waitForStoredAnswer()
  const before = new Map(redis.store)
  assert.equal((await ask(null)).status, 401)
  assert.equal((await ask(jwt.sign({ userId: 'x', companyId: 'company-A' }, 'wrong-secret'))).status, 401)
  assert.deepEqual([...redis.store], [...before])
  assert.equal(llm.calls, 1)
})

test('a valid token whose user PostgreSQL no longer confirms is never served from the cache', async () => {
  await ask(tokenA)
  await waitForStoredAnswer()
  const ghost = await ask(tokenFor('company-A', 'removed-user'))
  assert.equal(ghost.status, 200) // behaviour of the route before Module 9.2 is unchanged
  assert.equal(ghost.cache, null, 'no cache involvement at all')
  assert.equal(llm.calls, 2, 'the pipeline ran instead of the cache')
})

// ---------- what is never cached ----------
test('a Groq error is returned as before and is not cached; the next request runs the pipeline again', async () => {
  llm.mode = 'error500'
  const failed = await ask(tokenA)
  assert.equal(failed.status, 502)
  assert.equal(failed.body.success, false)
  assert.equal(failed.cache, 'MISS')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(answerKeys().length, 0)

  llm.mode = 'answer'
  const ok = await ask(tokenA)
  assert.equal(ok.status, 200)
  assert.equal(ok.cache, 'MISS')
  assert.equal(llm.calls, 2)
})

test('"not enough information" answers are not cached', async () => {
  llm.mode = 'unanswerable'
  const r = await ask(tokenA)
  assert.equal(r.body.grounded, false)
  assert.equal(r.body.reason, 'not_enough_info')
  await new Promise((r2) => setTimeout(r2, 50))
  assert.equal(answerKeys().length, 0)
  await ask(tokenA)
  assert.equal(llm.calls, 2)
})

test('an answer built while the graph was unavailable (incomplete retrieval) is returned but not cached', async () => {
  setGraphEnv()
  const driver = makeFakeDriver()
  driver.state.failWith = Object.assign(new Error('neo4j down'), { code: 'ServiceUnavailable' })
  setDriverForTests(driver)

  const r = await ask(tokenA)
  assert.equal(r.status, 200)
  assert.equal(r.body.grounded, true)
  assert.equal(r.body.retrieval.graph.status, 'unavailable')
  await new Promise((r2) => setTimeout(r2, 50))
  assert.equal(answerKeys().length, 0)
  await ask(tokenA)
  assert.equal(llm.calls, 2, 'once Neo4j is back the question is answered with the graph, not from a vector-only cache entry')
})

// ---------- freshness ----------
test('changing the company\'s documents makes earlier cached answers unreachable', async () => {
  await ask(tokenA)
  await waitForStoredAnswer()
  db.docs[0].updatedAt = new Date('2026-10-05T00:00:00Z') // e.g. the document was replaced
  const r = await ask(tokenA)
  assert.equal(r.cache, 'MISS')
  assert.equal(llm.calls, 2)
})

// ---------- Redis failure / switches ----------
test('if Redis fails, the question is answered by the normal pipeline', async () => {
  await useRedis({ broken: true })
  const r = await ask(tokenA)
  assert.equal(r.status, 200)
  assert.equal(r.body.grounded, true)
  assert.equal(llm.calls, 1)
  const again = await ask(tokenA)
  assert.equal(again.status, 200)
  assert.equal(llm.calls, 2)
})

test('Redis not configured: no cache, no header, same answers as before', async () => {
  await closeRedisCache()
  delete process.env.REDIS_URL
  const r = await ask(tokenA)
  assert.equal(r.status, 200)
  assert.equal(r.cache, null)
  assert.equal(r.body.grounded, true)
})

test('ASK_CACHE_ENABLED=false turns only the answer cache off', async () => {
  process.env.ASK_CACHE_ENABLED = 'false'
  try {
    const r = await ask(tokenA)
    assert.equal(r.status, 200)
    assert.equal(r.cache, null)
    assert.equal(answerKeys().length, 0)
  } finally {
    delete process.env.ASK_CACHE_ENABLED
  }
})
