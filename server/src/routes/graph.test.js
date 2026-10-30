// GET /api/graph, /api/graph/status, /api/graph/nodes/:id and POST /api/graph/documents/:id/reprocess
// through the REAL Express router and the REAL JWT middleware, with an in-memory stand-in for Prisma
// (same companyId filtering as PostgreSQL) and a recording fake Neo4j driver.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { clearGraphEnv, makeFakeDriver, setGraphEnv } from '../test-helpers/fakeNeo4j.js'

process.env.JWT_ACCESS_SECRET = 'unit-test-access-secret'
delete process.env.NLP_SERVICE_TOKEN // reprocess then reports "skipped" instead of calling a service

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const DOCS = [
  { id: UUID_A, companyId: 'company-A', originalName: 'a-plan.txt', extractedText: 'Priya fixed it.' },
  { id: UUID_B, companyId: 'company-B', originalName: 'b-secret.txt', extractedText: 'Secret.' },
]
// Users known to the database: reprocess is admin-only and re-checks the caller's role here.
const USERS = [
  { id: 'admin-company-A', companyId: 'company-A', role: 'ADMIN' },
  { id: 'user-company-A', companyId: 'company-A', role: 'MEMBER' },
  { id: 'admin-company-B', companyId: 'company-B', role: 'ADMIN' },
]
mock.module('../prisma.js', {
  defaultExport: {
    user: { findUnique: async ({ where }) => USERS.find((u) => u.id === where.id) ?? null },
    document: {
      findMany: async ({ where }) => DOCS.filter((d) => d.companyId === where.companyId).map((d) => ({ id: d.id, originalName: d.originalName })),
      count: async ({ where }) => DOCS.filter((d) => d.companyId === where.companyId).length,
      findFirst: async ({ where }) => DOCS.find((d) => d.id === where.id && d.companyId === where.companyId) ?? null,
    },
    graphIngestion: {
      groupBy: async ({ where }) => (where.companyId === 'company-A' ? [{ status: 'processed', _count: { _all: 1 } }] : []),
      upsert: async () => {},
      count: async ({ where }) => (where.companyId === 'company-A' && where.status === 'processed' && where.relationshipCount === 0 ? 1 : 0),
    },
  },
})

const { default: express } = await import('express')
const { default: graphRouter } = await import('./graph.js')
const { setDriverForTests } = await import('../utils/neo4j.js')
const { entityIdentity } = await import('../utils/graphIdentity.js')

const app = express()
app.use(express.json())
app.use('/api/graph', graphRouter)
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const token = (companyId) => jwt.sign({ userId: `user-${companyId}`, companyId, role: 'MEMBER' }, process.env.JWT_ACCESS_SECRET, { algorithm: 'HS256' })
const tokenA = token('company-A')
const tokenB = token('company-B')
const adminA = jwt.sign({ userId: 'admin-company-A', companyId: 'company-A', role: 'ADMIN' }, process.env.JWT_ACCESS_SECRET, { algorithm: 'HS256' })
const get = async (path, tok, headers = {}) => {
  const res = await fetch(base + path, { headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers } })
  return { status: res.status, body: await res.json() }
}

let fake
function useGraph(handler) {
  setGraphEnv()
  fake = makeFakeDriver(handler)
  setDriverForTests(fake)
}
const OVERVIEW = (cypher) => {
  if (cypher.includes('AS mentionCount')) return [{ id: 'company-A:PERSON:' + 'a'.repeat(32), label: 'Priya Rao', type: 'PERSON', degree: 1, documentCount: 1, mentionCount: 1 }]
  if (cypher.includes('count(DISTINCT e) AS entities')) return [{ entities: 1 }]
  if (cypher.includes('count(r) AS relationships')) return [{ relationships: 0 }]
  return []
}
test.after(() => { server.closeAllConnections?.(); server.close(); setDriverForTests(null); clearGraphEnv() })

test('every graph endpoint requires authentication', async () => {
  useGraph(OVERVIEW)
  for (const path of ['/api/graph', '/api/graph/status', `/api/graph/nodes/company-A:PERSON:${'a'.repeat(32)}`]) {
    assert.equal((await get(path)).status, 401, path)
    assert.equal((await get(path, 'not-a-token')).status, 401, path)
  }
  const res = await fetch(`${base}/api/graph/documents/${UUID_A}/reprocess`, { method: 'POST' })
  assert.equal(res.status, 401)
  assert.equal(fake.state.calls.length, 0, 'unauthenticated requests never reach Neo4j')
})

test('overview: company comes from the JWT; a client-supplied companyId (query or header) is ignored', async () => {
  useGraph(OVERVIEW)
  const { status, body } = await get('/api/graph?companyId=company-B&limit=10', tokenA, { 'x-company-id': 'company-B' })
  assert.equal(status, 200)
  assert.equal(body.enabled, true)
  assert.equal(body.nodes[0].label, 'Priya Rao')
  assert.ok(fake.state.calls.length > 0)
  assert.ok(fake.state.calls.every((c) => c.params.companyId === 'company-A'))
  // only company A's PostgreSQL documents are allowed to contribute
  assert.ok(fake.state.calls.every((c) => c.params.docIds.join() === UUID_A))
})

test('overview: documentId narrows the graph to one OWN document and lists the company\'s documents', async () => {
  useGraph(OVERVIEW)
  const { status, body } = await get(`/api/graph?documentId=${UUID_A}`, tokenA)
  assert.equal(status, 200)
  assert.deepEqual(body.documents, [{ id: UUID_A, name: 'a-plan.txt' }])
  assert.ok(fake.state.calls.length > 0 && fake.state.calls.every((c) => c.params.docIds.join() === UUID_A))
})

test('overview: another company\'s documentId is "not found" and Neo4j is never queried; junk is rejected', async () => {
  useGraph(OVERVIEW)
  assert.equal((await get(`/api/graph?documentId=${UUID_B}`, tokenA)).status, 404)
  assert.equal((await get('/api/graph?documentId=not-a-uuid', tokenA)).status, 400)
  assert.equal((await get(`/api/graph?documentId=${UUID_A}&documentId=${UUID_B}`, tokenA)).status, 400)
  assert.equal(fake.state.calls.length, 0)
})

test('company B sees only its own documents\' scope', async () => {
  useGraph(OVERVIEW)
  await get('/api/graph', tokenB)
  assert.ok(fake.state.calls.every((c) => c.params.companyId === 'company-B' && c.params.docIds.join() === UUID_B))
})

test('a company without documents gets an empty graph and Neo4j is not queried', async () => {
  useGraph(OVERVIEW)
  const { status, body } = await get('/api/graph', token('company-C'))
  assert.equal(status, 200)
  assert.deepEqual([body.nodes, body.edges, body.stats], [[], [], { entities: 0, relationships: 0 }])
  assert.equal(fake.state.calls.length, 0)
})

test('limit is validated', async () => {
  useGraph(OVERVIEW)
  for (const bad of ['0', '201', 'abc', '1.5']) assert.equal((await get(`/api/graph?limit=${bad}`, tokenA)).status, 400, bad)
})

test('Neo4j not configured: enabled=false, 200, empty', async () => {
  clearGraphEnv(); setDriverForTests(null)
  const { status, body } = await get('/api/graph', tokenA)
  assert.equal(status, 200)
  assert.deepEqual([body.enabled, body.nodes], [false, []])
})

test('Neo4j down: 503 with a safe message', async () => {
  useGraph(OVERVIEW)
  fake.state.failWith = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:7687'), { code: 'ServiceUnavailable' })
  const { status, body } = await get('/api/graph', tokenA)
  assert.equal(status, 503)
  assert.equal(body.code, 'GRAPH_UNAVAILABLE')
  assert.doesNotMatch(JSON.stringify(body), /10\.1\.2\.3/)
})

test('node: another company\'s node id is "not found" and never reaches Neo4j', async () => {
  useGraph(() => [])
  const foreign = entityIdentity('company-B', { type: 'PROJECT', text: 'Project X' }, UUID_B).uid
  const { status } = await get(`/api/graph/nodes/${encodeURIComponent(foreign)}`, tokenA)
  assert.equal(status, 404)
  assert.equal(fake.state.calls.length, 0)
  for (const junk of ['abc', encodeURIComponent("company-A:PROJECT:x' DETACH DELETE n //")]) assert.equal((await get(`/api/graph/nodes/${junk}`, tokenA)).status, 404)
})

test('node: own node returns relationships with evidence and document names; foreign-document rows are dropped', async () => {
  const mine = entityIdentity('company-A', { type: 'PERSON', text: 'Priya Rao' }, UUID_A).uid
  useGraph((cypher) => {
    if (cypher.includes('RETURN e.uid AS id')) return [{ id: mine, label: 'Priya Rao', type: 'PERSON', documentCount: 1, mentionCount: 2 }]
    if (cypher.includes('AS otherId')) return [
      { type: 'RESOLVED', outgoing: true, otherId: 'o1', otherLabel: 'login issue', otherType: 'ISSUE', evidence: 'Priya resolved the login issue', documentId: UUID_A, chunkIndex: 3, confidence: 0.96 },
      { type: 'RESOLVED', outgoing: true, otherId: 'o2', otherLabel: 'LEAK', otherType: 'ISSUE', evidence: 'FOREIGN-EVIDENCE', documentId: UUID_B, chunkIndex: 0, confidence: 0.9 },
    ]
    if (cypher.includes('AS surfaces')) return [{ documentId: UUID_A, chunkIndex: 3, surfaces: ['Priya'] }, { documentId: UUID_B, chunkIndex: 0, surfaces: ['Priya'] }]
    return []
  })
  const { status, body } = await get(`/api/graph/nodes/${encodeURIComponent(mine)}`, tokenA)
  assert.equal(status, 200)
  assert.equal(body.relationships.length, 1)
  assert.deepEqual([body.relationships[0].documentName, body.relationships[0].direction, body.relationships[0].chunkIndex], ['a-plan.txt', 'out', 3])
  assert.equal(body.mentions.length, 1)
  assert.ok(!JSON.stringify(body).includes('FOREIGN-EVIDENCE') && !JSON.stringify(body).includes('b-secret'))
  assert.ok(fake.state.calls.every((c) => c.params.companyId === 'company-A'))
})

test('status: counts only the company\'s own documents', async () => {
  useGraph(() => [])
  const a = await get('/api/graph/status', tokenA)
  assert.deepEqual([a.body.enabled, a.body.connected, a.body.documents], [true, true, { total: 1, processed: 1, failed: 0, skipped: 0, notProcessed: 0, processedWithoutRelationships: 1 }])
  const b = await get('/api/graph/status', tokenB)
  assert.deepEqual(b.body.documents, { total: 1, processed: 0, failed: 0, skipped: 0, notProcessed: 1, processedWithoutRelationships: 0 })
})

test('reprocess: own document ok, another company\'s document "not found", bad id rejected', async () => {
  useGraph(() => [])
  const post = async (id, tok) => {
    const res = await fetch(`${base}/api/graph/documents/${id}/reprocess`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` } })
    return { status: res.status, body: await res.json() }
  }
  const own = await post(UUID_A, adminA)
  assert.equal(own.status, 200)
  assert.equal(own.body.graph.status, 'skipped') // NLP service not configured in this test
  assert.equal((await post(UUID_B, adminA)).status, 404)
  assert.equal((await post('not-a-uuid', adminA)).status, 400)
})
