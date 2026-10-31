// Tests the graph read cache (Module 9.3) against a FAKE Redis client and a FAKE Prisma. No Redis server, Neo4j or
// database is used. They check: company isolation in keys and entries, hit/miss behaviour, that only complete
// successful results are stored, and that Redis trouble always ends in the real query.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { initRedisCache, closeRedisCache, setRedisClientFactoryForTests } from './redisCache.js'
import { invalidateCompanyKnowledge } from './askCache.js'
import { fakeKnowledgeState } from '../test-helpers/fakeKnowledgeState.js'
import {
  cachedGraphRead, graphCacheEnabled, graphCacheTtlSeconds, graphCacheVersion,
  isCompleteEntityDetail, isCompleteOverview,
} from './graphCache.js'

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

// Minimal node-redis stand-in: GET, SET key value [EX n] [NX], with a call log.
function fakeRedis(behaviour = {}) {
  const store = new Map()
  const calls = []
  const c = new EventEmitter()
  c.isOpen = false
  c.isReady = false
  c.connect = async () => { c.isOpen = true; c.isReady = true; c.emit('ready') }
  c.get = async (key) => {
    calls.push(['GET', key])
    if (behaviour.get) return behaviour.get(key, store)
    return store.has(key) ? store.get(key) : null
  }
  c.sendCommand = async (args) => {
    calls.push(args)
    if (behaviour.sendCommand) return behaviour.sendCommand(args, store)
    const [, key, value, ...opts] = args
    if (opts.includes('NX') && store.has(key)) return null
    store.set(key, value)
    return 'OK'
  }
  c.ping = async () => 'PONG'
  c.quit = async () => { c.isOpen = false; c.isReady = false }
  c.disconnect = c.quit
  return { client: c, store, calls }
}

function fakePrisma() {
  const state = { docs: [{ id: 'd1', companyId: 'company-A', updatedAt: new Date('2026-10-01T00:00:00Z') }], lookups: 0 }
  const agg = (rows) => async ({ where }) => {
    state.lookups += 1
    const mine = rows().filter((r) => r.companyId === where.companyId)
    const times = mine.map((r) => r.updatedAt).sort((a, b) => b - a)
    return { _count: { _all: mine.length }, _max: { updatedAt: times[0] ?? null } }
  }
  const kb = fakeKnowledgeState() // Module 9.4: Company.knowledgeVersion + KnowledgeChange leases
  state.users = [{ id: 'u-a1', companyId: 'company-A', role: 'MEMBER' }]
  return {
    state,
    kb,
    ...kb.models,
    user: { findUnique: async ({ where }) => state.users.find((u) => u.id === where.id) ?? null },
    document: { aggregate: agg(() => state.docs) },
    graphIngestion: { aggregate: agg(() => []) },
  }
}

// The authenticated caller (req.user): graphCacheVersion() confirms it in PostgreSQL before any cache is used.
const memberA = { userId: 'u-a1', companyId: 'company-A', role: 'MEMBER' }

const uid = (company, n = 'a') => `${company}:PERSON:${n.repeat(32)}`
const overview = (company = 'company-A') => ({
  nodes: [
    { id: uid(company, 'a'), label: 'Priya Rao', type: 'PERSON', degree: 1, documentCount: 1, mentionCount: 1 },
    { id: uid(company, 'b'), label: 'Login issue', type: 'ISSUE', degree: 1, documentCount: 1, mentionCount: 1 },
  ],
  edges: [{ id: 'x', source: uid(company, 'a'), target: uid(company, 'b'), type: 'RESOLVED', confidence: 0.9, supportCount: 1 }],
  stats: { entities: 2, relationships: 1 },
  truncated: false,
})
const detail = (company = 'company-A', id = uid(company, 'a')) => ({
  node: { id, label: 'Priya Rao', type: 'PERSON', documentCount: 1, mentionCount: 1 },
  edges: [{ type: 'RESOLVED', outgoing: true, otherId: uid(company, 'b'), otherLabel: 'Login issue', otherType: 'ISSUE', evidence: 'x', documentId: 'd1', chunkIndex: 0, confidence: 0.9 }],
  mentions: [{ documentId: 'd1', chunkIndex: 0, surfaces: ['Priya'] }],
})

let restoreEnv
let fake
let prisma
test.beforeEach(async () => {
  restoreEnv = withEnv({
    REDIS_URL: 'redis://127.0.0.1:6379', REDIS_CONNECT_TIMEOUT: '100', REDIS_CACHE_TTL: undefined,
    GRAPH_CACHE_TTL: undefined, GRAPH_CACHE_ENABLED: undefined, NEO4J_DATABASE: undefined, NEO4J_URI: undefined,
  })
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

const graphKeys = () => [...fake.store.keys()].filter((k) => k.includes(':graph:'))
const counter = (value) => { const f = async () => { f.calls += 1; return value }; f.calls = 0; return f }
const read = (over = {}) => cachedGraphRead({
  companyId: 'company-A', kb: 'epoch.fp', kind: 'overview', params: { limit: 80, docIds: ['d1'] }, compute: counter(overview()), ...over,
})

// ---------- configuration ----------

test('enabled by default; GRAPH_CACHE_ENABLED=false/0/off/no switches only this cache off', () => {
  assert.equal(graphCacheEnabled(), true)
  for (const v of ['false', '0', 'off', 'no', 'FALSE']) {
    const restore = withEnv({ GRAPH_CACHE_ENABLED: v })
    assert.equal(graphCacheEnabled(), false, v)
    restore()
  }
})

test('TTL: GRAPH_CACHE_TTL, else REDIS_CACHE_TTL, else 300; invalid values fall back', () => {
  assert.equal(graphCacheTtlSeconds(), 300)
  let restore = withEnv({ REDIS_CACHE_TTL: '90' })
  assert.equal(graphCacheTtlSeconds(), 90)
  restore()
  restore = withEnv({ REDIS_CACHE_TTL: '90', GRAPH_CACHE_TTL: '45' })
  assert.equal(graphCacheTtlSeconds(), 45)
  restore()
  for (const bad of ['0', '-5', 'abc', '', '99999999999']) {
    restore = withEnv({ GRAPH_CACHE_TTL: bad })
    assert.equal(graphCacheTtlSeconds(), 300, bad)
    restore()
  }
})

test('the configured TTL is the EX value of the stored entry', async () => {
  const restore = withEnv({ GRAPH_CACHE_TTL: '45' })
  await read()
  restore()
  const set = fake.calls.find((c) => Array.isArray(c) && c[0] === 'SET' && String(c[1]).includes(':graph:'))
  assert.deepEqual(set.slice(3), ['EX', '45'])
})

// ---------- hit / miss ----------

test('first read computes and stores (MISS), second identical read is served from Redis (HIT) without compute', async () => {
  const compute = counter(overview())
  const a = await read({ compute })
  const b = await read({ compute })
  assert.equal(a.cache, 'MISS')
  assert.equal(b.cache, 'HIT')
  assert.equal(compute.calls, 1)
  assert.deepEqual(b.value, a.value)
  assert.equal(graphKeys().length, 1)
})

test('the key starts with the company id and holds kind, schema version, kb version, config hash and params hash', async () => {
  await read()
  const [key] = graphKeys()
  assert.match(key, /^memhub:cache:company-A:graph:overview:v1:epoch\.fp:[0-9a-f]{32}:[0-9a-f]{32}$/)
  assert.doesNotMatch(key, /d1|80/) // parameters are hashed, never written in clear
})

test('different company -> different key and a separate compute (no sharing)', async () => {
  const computeA = counter(overview('company-A'))
  const computeB = counter(overview('company-B'))
  await read({ compute: computeA })
  const b = await read({ companyId: 'company-B', compute: computeB })
  assert.equal(b.cache, 'MISS')
  assert.equal(computeB.calls, 1)
  const keys = graphKeys()
  assert.equal(keys.length, 2)
  assert.ok(keys.some((k) => k.includes(':company-A:graph:')) && keys.some((k) => k.includes(':company-B:graph:')))
})

test('each query parameter is part of the key: limit, document ids, kind', async () => {
  const compute = counter(overview())
  await read({ compute })
  assert.equal((await read({ compute, params: { limit: 10, docIds: ['d1'] } })).cache, 'MISS')
  assert.equal((await read({ compute, params: { limit: 80, docIds: ['d1', 'd2'] } })).cache, 'MISS')
  assert.equal((await read({ compute })).cache, 'HIT')
  // key order inside params does not matter
  assert.equal((await read({ compute, params: { docIds: ['d1'], limit: 80 } })).cache, 'HIT')
  assert.equal(compute.calls, 3)
})

test('a different knowledge-base version is a different key (this is how uploads / deletes / reprocess invalidate)', async () => {
  const compute = counter(overview())
  await read({ compute })
  assert.equal((await read({ compute, kb: 'epoch2.fp' })).cache, 'MISS')
  assert.equal(compute.calls, 2)
})

test('the retrieval configuration is part of the key: Neo4j database and server', async () => {
  const compute = counter(overview())
  await read({ compute })
  let restore = withEnv({ NEO4J_DATABASE: 'other-db' })
  assert.equal((await read({ compute })).cache, 'MISS')
  restore()
  restore = withEnv({ NEO4J_URI: 'bolt://other-host:7687' })
  assert.equal((await read({ compute })).cache, 'MISS')
  restore()
  assert.equal((await read({ compute })).cache, 'HIT')
  assert.ok(graphKeys().every((k) => !k.includes('other-host') && !k.includes('other-db')), 'configuration is hashed, never in clear')
})

// ---------- invalidation through the Module 9.2 version ----------

test('invalidateCompanyKnowledge() makes the next graph version differ, so cached graphs are not served again', async () => {
  const kb1 = await graphCacheVersion(prisma, 'company-A', memberA)
  await read({ kb: kb1 })
  assert.equal((await read({ kb: kb1 })).cache, 'HIT')
  assert.equal(await invalidateCompanyKnowledge('company-A'), true)
  const kb2 = await graphCacheVersion(prisma, 'company-A', memberA)
  assert.notEqual(kb1, kb2)
  assert.equal((await read({ kb: kb2 })).cache, 'MISS')
})

test('graphCacheVersion: null (and no PostgreSQL query) when Redis is off, the cache is off, or the company id is missing', async () => {
  let restore = withEnv({ GRAPH_CACHE_ENABLED: 'false' })
  assert.equal(await graphCacheVersion(prisma, 'company-A', memberA), null)
  restore()
  assert.equal(await graphCacheVersion(prisma, '', memberA), null)
  assert.equal(prisma.state.lookups, 0)
  await closeRedisCache()
  restore = withEnv({ REDIS_URL: undefined })
  assert.equal(await graphCacheVersion(prisma, 'company-A', memberA), null)
  restore()
  assert.equal(prisma.state.lookups, 0)
})

test('graphCacheVersion: a PostgreSQL failure means "no cache", never an error', async () => {
  const broken = { ...prisma, document: { aggregate: async () => { throw new Error('db down') } } }
  assert.equal(await graphCacheVersion(broken, 'company-A', memberA), null)
})

// ---------- only complete, successful results ----------

test('a failing query propagates its error unchanged and nothing is stored', async () => {
  const boom = Object.assign(new Error('graph down'), { code: 'GRAPH_UNAVAILABLE' })
  await assert.rejects(read({ compute: async () => { throw boom } }), (e) => e === boom)
  assert.equal(graphKeys().length, 0)
})

test('incomplete or inconsistent overviews are returned but never stored', async () => {
  const company = 'company-A'
  const base = overview(company)
  const bad = {
    'empty graph': { nodes: [], edges: [], stats: { entities: 0, relationships: 0 }, truncated: false },
    'edge to a node that was not returned': { ...base, edges: [{ ...base.edges[0], target: uid(company, 'c') }] },
    'truncated flag contradicts totals': { ...base, truncated: true },
    'fewer entities than nodes': { ...base, stats: { entities: 1, relationships: 1 } },
    'node of another company': { ...base, nodes: [{ ...base.nodes[0], id: uid('company-B', 'a') }, base.nodes[1]] },
    'missing stats': { nodes: base.nodes, edges: base.edges, truncated: false },
    'not an object': 'nope',
  }
  for (const [label, value] of Object.entries(bad)) {
    const result = await read({ compute: async () => value })
    assert.equal(result.cache, 'MISS', label)
    assert.deepEqual(result.value, value, label)
    assert.equal(graphKeys().length, 0, label)
  }
})

test('a truncated overview whose numbers add up is cached (limit is part of the key)', async () => {
  const value = { ...overview(), stats: { entities: 50, relationships: 10 }, truncated: true }
  await read({ compute: async () => value })
  assert.equal(graphKeys().length, 1)
})

test('entity detail: null (not found) and incomplete detail are never stored; a complete one is', async () => {
  const id = uid('company-A', 'a')
  const params = { uid: id, docIds: ['d1'], edgeLimit: 40, mentionLimit: 20 }
  const run = (compute) => cachedGraphRead({ companyId: 'company-A', kb: 'epoch.fp', kind: 'entity', params, compute })

  assert.equal((await run(async () => null)).cache, 'MISS')
  assert.equal((await run(async () => ({ ...detail(), node: { ...detail().node, id: uid('company-A', 'z') } }))).cache, 'MISS') // another node
  assert.equal((await run(async () => ({ ...detail(), edges: [{ ...detail().edges[0], otherId: uid('company-B', 'b') }] }))).cache, 'MISS') // foreign neighbour
  assert.equal((await run(async () => ({ ...detail(), mentions: null }))).cache, 'MISS')
  assert.equal(graphKeys().length, 0)

  const compute = counter(detail())
  assert.equal((await run(compute)).cache, 'MISS')
  assert.equal((await run(compute)).cache, 'HIT')
  assert.equal(compute.calls, 1)
  assert.match(graphKeys()[0], /:company-A:graph:entity:v1:/)
})

test('the completeness checks themselves', () => {
  assert.equal(isCompleteOverview(overview(), { companyId: 'company-A' }), true)
  assert.equal(isCompleteOverview(overview('company-B'), { companyId: 'company-A' }), false)
  assert.equal(isCompleteEntityDetail(detail(), { companyId: 'company-A', params: { uid: uid('company-A', 'a') } }), true)
  assert.equal(isCompleteEntityDetail(detail(), { companyId: 'company-A', params: { uid: uid('company-A', 'q') } }), false)
})

// ---------- defence in depth on read ----------

test('an entry planted under the key but belonging to another company / version / params is rejected and the real query runs', async () => {
  const compute = counter(overview())
  await read({ compute })
  const [key] = graphKeys()
  const good = JSON.parse(fake.store.get(key))

  for (const [label, tampered] of Object.entries({
    'other company in the entry': { ...good, companyId: 'company-B' },
    'other kb version': { ...good, kb: 'old.fp' },
    'other params': { ...good, params: 'f'.repeat(32) },
    'other schema version': { ...good, v: 99 },
    'foreign nodes inside the value': { ...good, value: overview('company-B') },
    'inconsistent value': { ...good, value: { ...good.value, truncated: true } },
  })) {
    fake.store.set(key, JSON.stringify(tampered))
    const before = compute.calls
    const result = await read({ compute })
    assert.equal(result.cache, 'MISS', label)
    assert.equal(compute.calls, before + 1, label)
  }
})

test('an entry that is not valid JSON is treated as a miss', async () => {
  const compute = counter(overview())
  await read({ compute })
  fake.store.set(graphKeys()[0], '{not json')
  assert.equal((await read({ compute })).cache, 'MISS')
  assert.equal(compute.calls, 2)
})

test('a result larger than the entry limit is returned but not stored', async () => {
  const big = overview()
  big.nodes[0].label = 'x'.repeat(1024 * 1024 + 1)
  const result = await read({ compute: async () => big })
  assert.equal(result.cache, 'MISS')
  assert.equal(graphKeys().length, 0)
})

// ---------- Redis problems -> the real query ----------

test('no kb version (null) -> BYPASS: compute runs, Redis is not touched', async () => {
  const compute = counter(overview())
  const result = await read({ kb: null, compute })
  assert.equal(result.cache, 'BYPASS')
  assert.equal(compute.calls, 1)
  assert.equal(fake.calls.length, 0)
})

test('cache switched off -> BYPASS', async () => {
  const restore = withEnv({ GRAPH_CACHE_ENABLED: 'false' })
  const result = await read()
  restore()
  assert.equal(result.cache, 'BYPASS')
  assert.equal(fake.calls.length, 0)
})

test('Redis not configured -> BYPASS', async () => {
  await closeRedisCache()
  const restore = withEnv({ REDIS_URL: undefined })
  const compute = counter(overview())
  const result = await read({ compute })
  restore()
  assert.equal(result.cache, 'BYPASS')
  assert.equal(compute.calls, 1)
})

test('unknown kind -> BYPASS (never cached)', async () => {
  const result = await read({ kind: 'mutation' })
  assert.equal(result.cache, 'BYPASS')
  assert.equal(graphKeys().length, 0)
})

test('Redis commands failing (read and write) -> the real query still runs and its result is returned', async () => {
  await closeRedisCache()
  const boom = async () => { throw new Error('ECONNRESET') }
  fake = fakeRedis({ get: boom, sendCommand: boom })
  setRedisClientFactoryForTests(() => fake.client)
  await initRedisCache()
  const compute = counter(overview())
  const result = await read({ compute })
  assert.equal(result.cache, 'MISS')
  assert.equal(compute.calls, 1)
  assert.deepEqual(result.value, overview())
})

test('Redis answering slowly is bounded by REDIS_CONNECT_TIMEOUT, then the real query runs', async () => {
  await closeRedisCache()
  fake = fakeRedis({ get: () => new Promise(() => {}), sendCommand: () => new Promise(() => {}) })
  setRedisClientFactoryForTests(() => fake.client)
  await initRedisCache()
  const compute = counter(overview())
  const started = Date.now()
  const result = await read({ compute })
  assert.equal(compute.calls, 1)
  assert.equal(result.cache, 'MISS')
  assert.ok(Date.now() - started < 2000)
})
