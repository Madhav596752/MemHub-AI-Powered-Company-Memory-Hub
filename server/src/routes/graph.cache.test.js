// Module 9.3: the graph read cache exercised through the REAL Express router, the REAL JWT middleware and the REAL
// graph store code. Fakes: Redis client, Prisma (in memory, filters by companyId like PostgreSQL), Neo4j driver
// (recording). They prove the cache sits in front of the existing Neo4j queries and never replaces them:
//   a hit skips Neo4j; every other situation (miss, Redis trouble, Neo4j trouble) runs the normal query.
//
// Needs: node --experimental-test-module-mocks   (already set in the "test" script)
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import jwt from 'jsonwebtoken'
import { clearGraphEnv, makeFakeDriver, setGraphEnv } from '../test-helpers/fakeNeo4j.js'
import { fakeKnowledgeState } from '../test-helpers/fakeKnowledgeState.js'

process.env.JWT_ACCESS_SECRET = 'unit-test-access-secret'
delete process.env.NLP_SERVICE_TOKEN // reprocess then reports "skipped" instead of calling a service
for (const k of ['REDIS_URL', 'GRAPH_CACHE_TTL', 'GRAPH_CACHE_ENABLED', 'REDIS_CACHE_TTL', 'NEO4J_DATABASE']) delete process.env[k]

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_A2 = '33333333-3333-4333-8333-333333333333'
const UUID_B = '22222222-2222-4222-8222-222222222222'

// ---------- in-memory "PostgreSQL" ----------
const db = {}
function resetDb() {
  db.docs = [
    { id: UUID_A, companyId: 'company-A', originalName: 'a-plan.txt', extractedText: 'Priya fixed it.', updatedAt: new Date('2026-10-01T00:00:00Z') },
    { id: UUID_B, companyId: 'company-B', originalName: 'b-secret.txt', extractedText: 'Secret.', updatedAt: new Date('2026-10-01T00:00:00Z') },
  ]
  db.users = [
    { id: 'admin-company-A', companyId: 'company-A', role: 'ADMIN' },
    { id: 'user-company-A', companyId: 'company-A', role: 'MEMBER' },
    { id: 'user-company-B', companyId: 'company-B', role: 'MEMBER' }, // graphCacheVersion() confirms the caller in PostgreSQL
  ]
}
resetDb()
const aggregate = (rows) => async ({ where }) => {
  const mine = rows().filter((r) => r.companyId === where.companyId)
  const newest = mine.map((r) => r.updatedAt).filter(Boolean).sort((a, b) => b - a)[0] ?? null
  return { _count: { _all: mine.length }, _max: { updatedAt: newest } }
}
const knowledge = fakeKnowledgeState() // Module 9.4: Company.knowledgeVersion + KnowledgeChange leases
mock.module('../prisma.js', {
  defaultExport: {
    ...knowledge.models,
    user: { findUnique: async ({ where }) => db.users.find((u) => u.id === where.id) ?? null },
    document: {
      findMany: async ({ where }) => db.docs.filter((d) => d.companyId === where.companyId).map((d) => ({ id: d.id, originalName: d.originalName })),
      count: async ({ where }) => db.docs.filter((d) => d.companyId === where.companyId).length,
      findFirst: async ({ where }) => db.docs.find((d) => d.id === where.id && d.companyId === where.companyId) ?? null,
      aggregate: aggregate(() => db.docs),
    },
    graphIngestion: {
      groupBy: async () => [],
      count: async () => 0,
      upsert: async () => {}, // deliberately leaves the fingerprint alone: the route's own invalidation is what is tested
      aggregate: aggregate(() => []),
    },
  },
})

const { default: express } = await import('express')
const { default: graphRouter } = await import('./graph.js')
const { setDriverForTests } = await import('../utils/neo4j.js')
const { initRedisCache, closeRedisCache, setRedisClientFactoryForTests } = await import('../utils/redisCache.js')

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
async function noRedis() {
  await closeRedisCache()
  delete process.env.REDIS_URL
  redis = null
}
const graphKeys = () => [...(redis?.store.keys() ?? [])].filter((k) => k.includes(':graph:'))

// ---------- app ----------
const app = express()
app.use(express.json())
app.use('/api/graph', graphRouter)
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const sign = (userId, companyId, role = 'MEMBER') => jwt.sign({ userId, companyId, role }, process.env.JWT_ACCESS_SECRET, { algorithm: 'HS256' })
const tokenA = sign('user-company-A', 'company-A')
const tokenB = sign('user-company-B', 'company-B')
const adminA = sign('admin-company-A', 'company-A', 'ADMIN')
const get = async (path, tok) => {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${tok}` } })
  return { status: res.status, cache: res.headers.get('x-cache'), body: await res.json() }
}

// ---------- fake Neo4j ----------
const uidOf = (company, n) => `${company}:PERSON:${n.repeat(32)}`
const person = (company) => uidOf(company, 'a')
const issue = (company) => uidOf(company, 'b')
const OVERVIEW = (company) => (cypher, params) => {
  const c = params?.companyId ?? company
  if (cypher.includes('AS mentionCount') && cypher.includes('LIMIT $limit')) return [
    { id: person(c), label: 'Priya Rao', type: 'PERSON', degree: 1, documentCount: 1, mentionCount: 1 },
    { id: issue(c), label: 'Login issue', type: 'ISSUE', degree: 1, documentCount: 1, mentionCount: 1 },
  ]
  if (cypher.includes('count(DISTINCT e) AS entities')) return [{ entities: 2 }]
  if (cypher.includes('count(r) AS relationships')) return [{ relationships: 1 }]
  if (cypher.includes('a.uid AS source')) return [{ source: person(c), target: issue(c), type: 'RESOLVED', confidence: 0.9 }]
  return []
}
let fake
function useGraph(handler = OVERVIEW('company-A')) {
  setGraphEnv()
  fake = makeFakeDriver(handler)
  setDriverForTests(fake)
}
const neo4jStatements = () => fake.state.calls.length

test.beforeEach(async () => {
  resetDb()
  knowledge.state.leases.length = 0
  knowledge.state.versions.clear()
  for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {})
  await useRedis()
  useGraph()
})
test.afterEach(async () => {
  await closeRedisCache()
  setRedisClientFactoryForTests(null)
  mock.restoreAll()
  delete process.env.GRAPH_CACHE_ENABLED
  delete process.env.GRAPH_CACHE_TTL
})
test.after(() => { server.closeAllConnections?.(); server.close(); setDriverForTests(null); clearGraphEnv(); delete process.env.REDIS_URL })

// ---------- GET /api/graph ----------

test('overview: first request runs Neo4j (MISS), the identical second one is answered from Redis (HIT) with the same body', async () => {
  const first = await get('/api/graph', tokenA)
  const statements = neo4jStatements()
  assert.equal(first.status, 200)
  assert.equal(first.cache, 'MISS')
  assert.ok(statements > 0)
  assert.equal(graphKeys().length, 1)
  assert.match(graphKeys()[0], /^memhub:cache:company-A:graph:overview:v1:/)

  const second = await get('/api/graph', tokenA)
  assert.equal(second.status, 200)
  assert.equal(second.cache, 'HIT')
  assert.equal(neo4jStatements(), statements, 'a hit must not query Neo4j')
  assert.deepEqual(second.body, first.body)
  assert.deepEqual(second.body.documents, [{ id: UUID_A, name: 'a-plan.txt' }])
})

test('overview: limit and documentId are part of the key', async () => {
  // A second document, so that "only UUID_A" really is a different query from "all documents".
  db.docs.push({ id: UUID_A2, companyId: 'company-A', originalName: 'second.txt', extractedText: 'x', updatedAt: new Date('2026-10-02T00:00:00Z') })
  await get('/api/graph', tokenA)
  assert.equal((await get('/api/graph?limit=10', tokenA)).cache, 'MISS')
  assert.equal((await get(`/api/graph?documentId=${UUID_A}`, tokenA)).cache, 'MISS')
  assert.equal((await get('/api/graph?limit=10', tokenA)).cache, 'HIT')
  assert.equal(graphKeys().length, 3)
})

test('overview: strict company isolation - company B never receives company A\'s cached graph', async () => {
  const a = await get('/api/graph', tokenA)
  assert.equal(a.cache, 'MISS')
  const statementsAfterA = neo4jStatements()

  useGraph(OVERVIEW('company-B')) // same code path, company B's own Neo4j data
  const b = await get('/api/graph', tokenB)
  assert.equal(b.cache, 'MISS', 'a different company is a different key')
  assert.ok(neo4jStatements() > 0, 'B ran its own query')
  assert.ok(fake.state.calls.every((c) => c.params.companyId === 'company-B'))
  assert.ok(b.body.nodes.every((n) => n.id.startsWith('company-B:')))
  assert.ok(!JSON.stringify(b.body).includes('company-A'))
  assert.ok(statementsAfterA > 0)

  const keys = graphKeys()
  assert.equal(keys.length, 2)
  assert.ok(keys.some((k) => k.includes(':company-A:graph:')) && keys.some((k) => k.includes(':company-B:graph:')))
  // each company keeps hitting its own entry
  assert.equal((await get('/api/graph', tokenA)).body.nodes[0].id.startsWith('company-A:'), true)
  assert.equal((await get('/api/graph', tokenB)).body.nodes[0].id.startsWith('company-B:'), true)
})

test('overview: a client-supplied companyId cannot select another company\'s cache entry', async () => {
  await get('/api/graph', tokenA)
  const res = await get('/api/graph?companyId=company-A', tokenB) // B asks for A's company id
  assert.equal(res.cache, 'MISS')
  assert.ok(!JSON.stringify(res.body).includes('a-plan.txt'))
})

test('overview: uploading a document (PostgreSQL fingerprint changes) invalidates by itself, even without a Redis rotation', async () => {
  await get('/api/graph', tokenA)
  assert.equal((await get('/api/graph', tokenA)).cache, 'HIT')
  db.docs.push({ id: UUID_A2, companyId: 'company-A', originalName: 'new.txt', extractedText: 'x', updatedAt: new Date('2026-10-02T00:00:00Z') })
  const after = await get('/api/graph', tokenA)
  assert.equal(after.cache, 'MISS')
  assert.equal(after.body.documents.length, 2)
})

test('overview: deleting a document makes the previous cached graph unreachable', async () => {
  db.docs.push({ id: UUID_A2, companyId: 'company-A', originalName: 'second.txt', extractedText: 'x', updatedAt: new Date('2026-10-02T00:00:00Z') })
  await get('/api/graph', tokenA)
  assert.equal((await get('/api/graph', tokenA)).cache, 'HIT')
  db.docs = db.docs.filter((d) => d.id !== UUID_A2)
  const after = await get('/api/graph', tokenA)
  assert.equal(after.cache, 'MISS')
  assert.deepEqual(after.body.documents.map((d) => d.id), [UUID_A])
})

test('mutation: reprocess is never cached; a run that changed nothing (skipped) does NOT advance the version, so valid cache entries stay', async () => {
  await get('/api/graph', tokenA)
  assert.equal((await get('/api/graph', tokenA)).cache, 'HIT')
  const keysBefore = new Set(graphKeys())
  const versionBefore = knowledge.counter('company-A')

  // NLP is not configured in this file, so the run is "skipped": nothing was written to Neo4j (Module 9.4).
  const res = await fetch(`${base}/api/graph/documents/${UUID_A}/reprocess`, { method: 'POST', headers: { Authorization: `Bearer ${adminA}` } })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).graph.status, 'skipped')
  assert.equal(res.headers.get('x-cache'), null)
  assert.deepEqual(graphKeys().filter((k) => !keysBefore.has(k)), [], 'the mutation stored nothing')

  assert.equal(knowledge.counter('company-A'), versionBefore, 'a skipped run must not advance the version')
  assert.equal(knowledge.state.leases.length, 0, 'the in-flight lease is released')
  assert.equal((await get('/api/graph', tokenA)).cache, 'HIT', 'nothing changed, so the cached graph is still valid')
})

test('overview: failures are never cached - a Neo4j outage returns the same 503 as before and a later success is stored normally', async () => {
  fake.state.failWith = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:7687'), { code: 'ServiceUnavailable' })
  const down = await get('/api/graph', tokenA)
  assert.equal(down.status, 503)
  assert.equal(down.body.code, 'GRAPH_UNAVAILABLE')
  assert.equal(down.cache, null) // the error path never marks a response as cached
  assert.equal(graphKeys().length, 0)

  fake.state.failWith = null
  assert.equal((await get('/api/graph', tokenA)).cache, 'MISS')
  assert.equal((await get('/api/graph', tokenA)).cache, 'HIT')
})

test('overview: an incomplete Neo4j result (edge to a node that was not returned) is served but not cached', async () => {
  useGraph((cypher, params) => {
    const rows = OVERVIEW('company-A')(cypher, params)
    return cypher.includes('a.uid AS source') ? [{ ...rows[0], target: uidOf('company-A', 'z') }] : rows
  })
  const first = await get('/api/graph', tokenA)
  assert.equal(first.status, 200)
  assert.equal(graphKeys().length, 0)
  assert.equal((await get('/api/graph', tokenA)).cache, 'MISS')
})

test('overview: a company without documents gets an empty graph, Neo4j is not queried and nothing is cached', async () => {
  const res = await get('/api/graph', sign('user-company-C', 'company-C'))
  assert.equal(res.status, 200)
  assert.deepEqual([res.body.nodes, res.body.edges], [[], []])
  assert.equal(neo4jStatements(), 0)
  assert.equal(graphKeys().length, 0)
})

test('overview: Neo4j not configured -> enabled=false, no cache involved', async () => {
  clearGraphEnv(); setDriverForTests(null)
  const res = await get('/api/graph', tokenA)
  assert.equal(res.status, 200)
  assert.equal(res.body.enabled, false)
  assert.equal(res.cache, null)
  assert.equal(redis.store.size, 0)
})

test('rejected requests (bad documentId / unknown document) do not touch the cache', async () => {
  assert.equal((await get('/api/graph?documentId=not-a-uuid', tokenA)).status, 400)
  assert.equal((await get(`/api/graph?documentId=${UUID_B}`, tokenA)).status, 404)
  assert.equal(redis.store.size, 0)
  assert.equal(neo4jStatements(), 0)
})

test('the configured TTL is applied to stored graph entries', async () => {
  process.env.GRAPH_CACHE_TTL = '45'
  const sets = []
  const original = redis.client.sendCommand
  redis.client.sendCommand = async (args) => { sets.push(args); return original(args) }
  await get('/api/graph', tokenA)
  const entry = sets.find((a) => String(a[1]).includes(':graph:'))
  assert.deepEqual(entry.slice(3), ['EX', '45'])
})

// ---------- Redis problems -> normal Neo4j execution ----------

test('Redis failing on every command: the endpoint answers normally from Neo4j, every time', async () => {
  await useRedis({ broken: true })
  const first = await get('/api/graph', tokenA)
  const afterFirst = neo4jStatements()
  const second = await get('/api/graph', tokenA)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(first.body.nodes[0].label, 'Priya Rao')
  assert.deepEqual(second.body, first.body)
  assert.ok(neo4jStatements() > afterFirst, 'no cache -> Neo4j runs again')
})

test('Redis not configured: behaviour is exactly the uncached one (no X-Cache header, Neo4j every time)', async () => {
  await noRedis()
  const a = await get('/api/graph', tokenA)
  const afterFirst = neo4jStatements()
  const b = await get('/api/graph', tokenA)
  assert.equal(a.status, 200)
  assert.equal(a.cache, null)
  assert.equal(b.cache, null)
  assert.ok(neo4jStatements() > afterFirst)
})

test('GRAPH_CACHE_ENABLED=false switches the graph cache off while Redis stays connected', async () => {
  process.env.GRAPH_CACHE_ENABLED = 'false'
  await get('/api/graph', tokenA)
  const afterFirst = neo4jStatements()
  const second = await get('/api/graph', tokenA)
  assert.equal(second.cache, null)
  assert.ok(neo4jStatements() > afterFirst)
  assert.equal(graphKeys().length, 0)
})

// ---------- GET /api/graph/nodes/:id ----------

const NODE = person('company-A')
const nodeHandler = (cypher) => {
  if (cypher.includes('RETURN e.uid AS id')) return [{ id: NODE, label: 'Priya Rao', type: 'PERSON', documentCount: 1, mentionCount: 2 }]
  if (cypher.includes('AS otherId')) return [
    { type: 'RESOLVED', outgoing: true, otherId: issue('company-A'), otherLabel: 'Login issue', otherType: 'ISSUE', evidence: 'Priya resolved the login issue', documentId: UUID_A, chunkIndex: 3, confidence: 0.96 },
    { type: 'RESOLVED', outgoing: true, otherId: issue('company-A'), otherLabel: 'LEAK', otherType: 'ISSUE', evidence: 'FOREIGN-EVIDENCE', documentId: UUID_B, chunkIndex: 0, confidence: 0.9 },
  ]
  if (cypher.includes('AS surfaces')) return [{ documentId: UUID_A, chunkIndex: 3, surfaces: ['Priya'] }, { documentId: UUID_B, chunkIndex: 0, surfaces: ['Priya'] }]
  return []
}
const node = (tok = tokenA, id = NODE) => get(`/api/graph/nodes/${encodeURIComponent(id)}`, tok)

test('node: MISS then HIT; a hit skips Neo4j and the document-ownership filter still runs on it', async () => {
  useGraph(nodeHandler)
  const first = await node()
  const statements = neo4jStatements()
  assert.equal(first.status, 200)
  assert.equal(first.cache, 'MISS')
  assert.match(graphKeys()[0], /^memhub:cache:company-A:graph:entity:v1:/)

  const second = await node()
  assert.equal(second.cache, 'HIT')
  assert.equal(neo4jStatements(), statements)
  assert.deepEqual(second.body, first.body)
  for (const body of [first.body, second.body]) {
    assert.equal(body.relationships.length, 1)
    assert.equal(body.relationships[0].documentName, 'a-plan.txt')
    assert.ok(!JSON.stringify(body).includes('FOREIGN-EVIDENCE') && !JSON.stringify(body).includes('b-secret'))
  }
})

test('node: another company\'s id is "not found" without touching Redis or Neo4j; company A\'s cached node is not reachable by B', async () => {
  useGraph(nodeHandler)
  await node()
  const before = graphKeys().length
  const statements = neo4jStatements()
  const foreign = await node(tokenB, NODE)
  assert.equal(foreign.status, 404)
  assert.equal(foreign.cache, null)
  assert.equal(neo4jStatements(), statements)
  assert.equal(graphKeys().length, before)
})

test('node: "not found" (nothing returned by Neo4j) is not cached', async () => {
  useGraph(() => [])
  const a = await node()
  const b = await node()
  assert.equal(a.status, 404)
  assert.equal(b.status, 404)
  assert.equal(graphKeys().length, 0)
})

test('node: a Redis failure still returns the node from Neo4j', async () => {
  await useRedis({ broken: true })
  useGraph(nodeHandler)
  const res = await node()
  assert.equal(res.status, 200)
  assert.equal(res.body.node.label, 'Priya Rao')
})

// ---------- never cached ----------

test('status is a live health check and is never cached', async () => {
  const a = await get('/api/graph/status', tokenA)
  const afterFirst = neo4jStatements()
  const b = await get('/api/graph/status', tokenA)
  assert.equal(a.status, 200)
  assert.equal(b.cache, null)
  assert.ok(neo4jStatements() > afterFirst, 'the health probe ran again')
  assert.equal(graphKeys().length, 0)
})
