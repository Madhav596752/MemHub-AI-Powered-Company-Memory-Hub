// Module 9.5: the knowledge-graph read cache (graphCache.js) on a REAL Redis server started by this file.
// Neo4j is not needed: `compute` is a counting stand-in for getGraphOverview() / getEntityDetail().
//
//   npm run test:redis        (skipped when the redis-server binary is not installed)
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from 'redis'
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

let cache, graph, versions, server, raw
const kb = fakeKnowledgeState()
let db
const freshDb = () => ({
  users: [
    { id: 'u-a', companyId: 'company-A', role: 'MEMBER' },
    { id: 'u-b', companyId: 'company-B', role: 'MEMBER' },
  ],
  docs: [{ companyId: 'company-A', updatedAt: new Date('2026-10-01T00:00:00Z') }, { companyId: 'company-B', updatedAt: new Date('2026-10-01T00:00:00Z') }],
})
const aggregate = (rows) => async ({ where }) => {
  const mine = rows().filter((r) => r.companyId === where.companyId)
  return { _count: { _all: mine.length }, _max: { updatedAt: mine.map((r) => r.updatedAt).sort((a, b) => b - a)[0] ?? null } }
}
const prisma = {
  ...kb.models,
  user: { findUnique: async ({ where }) => db.users.find((u) => u.id === where.id) ?? null },
  document: { aggregate: aggregate(() => db.docs) },
  graphIngestion: { aggregate: aggregate(() => []) },
}

if (!skip) {
  process.env.REDIS_CONNECT_TIMEOUT = '400'
  for (const k of ['GRAPH_CACHE_ENABLED', 'GRAPH_CACHE_TTL', 'REDIS_CACHE_TTL']) delete process.env[k]
  cache = await import('./redisCache.js')
  graph = await import('./graphCache.js')
  versions = await import('./knowledgeVersion.js')
  server = await startRedisServer()
  raw = createClient({ url: server.url })
  raw.on('error', () => {})
  await raw.connect()
}

const overviewFor = (companyId, n = 2) => {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `${companyId}:PERSON:p${i}`, label: `Person ${i}`, type: 'PERSON' }))
  return { nodes, edges: n > 1 ? [{ source: nodes[0].id, target: nodes[1].id, type: 'WORKED_WITH' }] : [], stats: { entities: n, relationships: n > 1 ? 1 : 0 }, truncated: false }
}
let computeCalls = 0
const read = async ({ companyId = 'company-A', userId = 'u-a', params = { limit: 80 }, compute } = {}) => {
  const user = { userId, companyId }
  const version = await graph.graphCacheVersion(prisma, companyId, user)
  return graph.cachedGraphRead({
    companyId, kb: version, kind: 'overview', params,
    compute: compute ?? (async () => { computeCalls += 1; return overviewFor(companyId) }),
  })
}
const graphKeys = () => raw.keys('memhub:cache:*:graph:*')

test.beforeEach(async () => {
  if (skip) return
  for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {})
  await server.start()
  await cache.closeRedisCache()
  process.env.REDIS_URL = server.url
  await cache.initRedisCache()
  await until(() => cache.getRedisStatus().status === 'ok')
  await raw.flushAll()
  db = freshDb()
  kb.state.versions.clear()
  kb.state.leases = []
  kb.state.advances = []
  computeCalls = 0
  delete process.env.GRAPH_CACHE_TTL
})
test.afterEach(() => mock.restoreAll())
test.after(async () => {
  if (skip) return
  await cache.closeRedisCache()
  await raw.quit().catch(() => {})
  await server.close()
  delete process.env.REDIS_URL
})

test('graph read: first read is a MISS (Neo4j query runs, result stored), the second is a HIT without the query', { skip }, async () => {
  const first = await read()
  assert.equal(first.cache, 'MISS')
  const second = await read()
  assert.equal(second.cache, 'HIT')
  assert.deepEqual(second.value, first.value)
  assert.equal(computeCalls, 1)
  const [key] = await graphKeys()
  assert.ok(key.startsWith('memhub:cache:company-A:graph:overview:'))
})

test('graph read: TTL is applied and, once it passes, the query runs again', { skip }, async () => {
  process.env.GRAPH_CACHE_TTL = '1'
  await read()
  const [key] = await graphKeys()
  const pttl = await raw.pTTL(key)
  assert.ok(pttl > 0 && pttl <= 1000, `ttl ${pttl}`)
  assert.equal((await read()).cache, 'HIT')
  assert.ok(await until(async () => (await graphKeys()).length === 0, 4000))
  assert.equal((await read()).cache, 'MISS')
  assert.equal(computeCalls, 2)
})

test('graph read: companies and query parameters have separate entries', { skip }, async () => {
  const a = await read()
  const b = await read({ companyId: 'company-B', userId: 'u-b' })
  assert.deepEqual([a.cache, b.cache], ['MISS', 'MISS'])
  assert.ok(a.value.nodes.every((n) => n.id.startsWith('company-A:')))
  assert.ok(b.value.nodes.every((n) => n.id.startsWith('company-B:')))
  assert.equal((await read({ params: { limit: 10 } })).cache, 'MISS', 'another limit is another entry')
  assert.equal((await read()).cache, 'HIT')
  assert.equal((await read({ companyId: 'company-B', userId: 'u-b' })).value.nodes[0].id.startsWith('company-B:'), true)
})

test('graph read: a caller PostgreSQL does not confirm (removed, moved, forged) gets no cache', { skip }, async () => {
  await read()
  assert.equal((await read({ userId: 'ghost' })).cache, 'BYPASS')
  assert.equal((await read({ userId: 'u-b' })).cache, 'BYPASS', 'a user of company B claiming company A')
  db.users.find((u) => u.id === 'u-a').companyId = 'company-B'
  assert.equal((await read()).cache, 'BYPASS')
})

test('graph read: errors and incomplete results are never cached', { skip }, async () => {
  await assert.rejects(read({ compute: async () => { throw Object.assign(new Error('neo4j down'), { code: 'GRAPH_UNAVAILABLE' }) } }), /neo4j down/)
  assert.equal((await graphKeys()).length, 0)

  const incomplete = overviewFor('company-A')
  incomplete.edges.push({ source: 'company-A:PERSON:p0', target: 'company-A:PERSON:not-returned', type: 'X' })
  assert.equal((await read({ compute: async () => incomplete })).cache, 'MISS')
  const foreign = overviewFor('company-A')
  foreign.nodes.push({ id: 'company-B:PERSON:leak', label: 'Leak', type: 'PERSON' })
  foreign.stats.entities = 3
  assert.equal((await read({ compute: async () => foreign })).cache, 'MISS')
  assert.equal((await read({ compute: async () => ({ nodes: [], edges: [], stats: { entities: 0, relationships: 0 }, truncated: false }) })).cache, 'MISS')
  assert.equal((await graphKeys()).length, 0, 'nothing incomplete, foreign or empty was stored')
})

test('graph read: upload / delete / reprocess / version change invalidate; failed ingestion that wrote nothing does not', { skip }, async () => {
  await read()
  assert.equal((await read()).cache, 'HIT')

  const none = await versions.beginKnowledgeChange(prisma, 'company-A', 'graph-reprocess')
  none.record(versions.EFFECT.NONE)
  await none.settle()
  assert.equal((await read()).cache, 'HIT', 'a reprocess that failed before writing keeps the cache')

  const change = await versions.beginKnowledgeChange(prisma, 'company-A', 'graph-reprocess')
  assert.equal((await read()).cache, 'BYPASS', 'bypassed while the change runs')
  change.record(versions.EFFECT.CHANGED)
  await change.settle()
  assert.equal((await read()).cache, 'MISS')
  assert.equal((await read()).cache, 'HIT')

  db.docs.push({ companyId: 'company-A', updatedAt: new Date('2026-10-05T00:00:00Z') }) // upload
  assert.equal((await read()).cache, 'MISS')
  // delete: like DELETE /api/documents/:id, the row goes inside a knowledge change that advances the version
  // (removing the row alone would return PostgreSQL to the exact state that was cached before the upload).
  const del = await versions.beginKnowledgeChange(prisma, 'company-A', 'delete')
  await del.step(async () => { db.docs.pop() }, { onError: () => versions.EFFECT.NONE })
  await del.settle()
  assert.equal((await read()).cache, 'MISS')
  kb.state.versions.set('company-A', 99)
  assert.equal((await read()).cache, 'MISS')
  assert.equal((await read({ companyId: 'company-B', userId: 'u-b' })).cache, 'MISS')
  assert.equal((await read({ companyId: 'company-B', userId: 'u-b' })).cache, 'HIT', 'company B is unaffected by company A\'s changes')
})

test('graph read: Redis killed -> reads still work (BYPASS); Redis back -> caching resumes', { skip }, async () => {
  await read()
  await server.stop()
  assert.ok(await until(() => cache.getRedisStatus().status === 'unavailable', 4000))
  const down = await read()
  assert.equal(down.cache, 'BYPASS')
  assert.ok(down.value.nodes.length > 0, 'the real query still answers')
  await server.start()
  assert.ok(await until(() => cache.getRedisStatus().status === 'ok', 15000))
  assert.equal((await read()).cache, 'MISS')
  assert.equal((await read()).cache, 'HIT')
})

test('graph read: Redis out of memory (writes refused) -> result returned, nothing stored, no error', { skip }, async () => {
  await raw.configSet('maxmemory-policy', 'noeviction')
  await raw.configSet('maxmemory', '1')
  try {
    const r = await read()
    assert.ok(r.value.nodes.length > 0)
    assert.equal((await graphKeys()).length, 0)
  } finally {
    await raw.configSet('maxmemory', '0')
  }
})
