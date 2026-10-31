// Tests the /api/ask response cache (Module 9.2) against a FAKE Redis client and a FAKE Prisma. No Redis server,
// database or network is used. They check the security rules: company isolation, scope separation, no cache
// before the caller is confirmed, only complete grounded answers stored, safe behaviour when Redis fails.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { initRedisCache, closeRedisCache, setRedisClientFactoryForTests } from './redisCache.js'
import { fakeKnowledgeState } from '../test-helpers/fakeKnowledgeState.js'
import {
  prepareAskCache, invalidateCompanyKnowledge, normalizeQuestion, isCacheableAskResponse, askCacheTtlSeconds,
  askScopeHash, retrievalConfigHash, knowledgeBaseVersion,
} from './askCache.js'

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

// In-memory Prisma: users, documents, graph rows, knowledge-version state. Aggregates behave like PostgreSQL's count / max.
function fakePrisma(initial = {}) {
  const state = {
    users: initial.users ?? [{ id: 'u-a1', companyId: 'company-A', role: 'MEMBER' }],
    docs: initial.docs ?? [{ id: 'd1', companyId: 'company-A', updatedAt: new Date('2026-10-01T00:00:00Z') }],
    graph: initial.graph ?? [],
    userLookups: 0,
    failUser: false,
  }
  const agg = (rows) => async ({ where }) => {
    const mine = rows.call().filter((r) => r.companyId === where.companyId)
    const times = mine.map((r) => r.updatedAt).filter(Boolean).sort((a, b) => b - a)
    return { _count: { _all: mine.length }, _max: { updatedAt: times[0] ?? null } }
  }
  const kb = fakeKnowledgeState() // Module 9.4: Company.knowledgeVersion + KnowledgeChange leases
  return {
    state,
    kb,
    ...kb.models,
    user: {
      findUnique: async ({ where }) => {
        state.userLookups += 1
        if (state.failUser) throw new Error('db down')
        return state.users.find((u) => u.id === where.id) ?? null
      },
    },
    document: { aggregate: agg({ call: () => state.docs }) },
    graphIngestion: { aggregate: agg({ call: () => state.graph }) },
  }
}

const CONFIG = { topK: 5, minScore: 0.25, maxContextChars: 6000, graph: { enabled: false, maxFacts: 8, maxContextChars: 1500, evidenceChars: 500 }, model: 'test-model' }
const memberA = { userId: 'u-a1', companyId: 'company-A', role: 'MEMBER' }

const GOOD = () => ({
  success: true, grounded: true, answer: 'Refunds within 14 days [1].',
  sources: [{ ref: 1, kind: 'chunk', documentId: 'd1', documentName: 'refund.txt', chunkIndex: 0, text: 'Refund within 14 days.', startChar: 0, endChar: 22, score: 0.9 }],
  retrieval: { vector: { status: 'ok', chunks: 1 }, graph: { status: 'disabled', facts: 0 } },
})

let restoreEnv
let fake
let prisma
test.beforeEach(async () => {
  restoreEnv = withEnv({ REDIS_URL: 'redis://127.0.0.1:6379', REDIS_CONNECT_TIMEOUT: '100', REDIS_CACHE_TTL: undefined, ASK_CACHE_TTL: undefined, ASK_CACHE_ENABLED: undefined })
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

const prep = (over = {}) => prepareAskCache({ prisma, user: memberA, question: 'What is our refund policy?', config: CONFIG, ...over })

// ---------- hit / miss ----------
test('miss, then store, then hit: the stored body comes back unchanged', async () => {
  const first = await prep()
  assert.equal(await first.lookup(), null)
  assert.equal(await first.store(GOOD()), true)

  const second = await prep()
  assert.deepEqual(await second.lookup(), GOOD())
})

test('the same question written differently (case, spaces, trailing ?) hits the same entry', async () => {
  await (await prep()).store(GOOD())
  for (const q of ['  WHAT is our   Refund policy??', 'what is our refund policy', 'What is our refund policy?\n']) {
    assert.deepEqual(await (await prep({ question: q })).lookup(), GOOD(), q)
  }
  assert.equal(await (await prep({ question: 'What is our shipping policy?' })).lookup(), null)
})

test('normalizeQuestion folds look-alikes and whitespace but keeps different words different', () => {
  assert.equal(normalizeQuestion('ＷＨＡＴ  is\tIT?!'), 'what is it')
  assert.equal(normalizeQuestion('???'), '')
  assert.notEqual(normalizeQuestion('refund policy'), normalizeQuestion('refund policies'))
})

// ---------- key layout ----------
test('the key starts with the company, carries version/scope/config/question hashes, and never contains the question', async () => {
  await (await prep({ question: 'What is the secret acquisition plan?' })).store(GOOD())
  const [key] = [...fake.store.keys()].filter((k) => k.includes(':ask:'))
  assert.match(key, /^memhub:cache:company-A:ask:v1:\d+\.[0-9a-f-]{36}\.[0-9a-f]{16}:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]{64}$/)
  assert.ok(!/secret|acquisition/i.test(key), 'question text must not appear in the key')
})

// ---------- isolation ----------
test('another company never sees a company\'s entry, even for the identical question', async () => {
  prisma.state.users.push({ id: 'u-b1', companyId: 'company-B', role: 'MEMBER' })
  prisma.state.docs.push({ id: 'd-b', companyId: 'company-B', updatedAt: new Date('2026-10-01T00:00:00Z') })
  await (await prep()).store(GOOD())

  const b = await prep({ user: { userId: 'u-b1', companyId: 'company-B', role: 'MEMBER' } })
  assert.equal(await b.lookup(), null)
  assert.ok([...fake.store.keys()].filter((k) => k.includes(':ask:')).every((k) => k.startsWith('memhub:cache:company-A:')))
})

test('an entry planted under company B\'s key but belonging to company A is rejected', async () => {
  prisma.state.users.push({ id: 'u-b1', companyId: 'company-B', role: 'MEMBER' })
  await (await prep()).store(GOOD())
  const [aKey, aValue] = [...fake.store.entries()].find(([k]) => k.includes(':ask:'))

  const b = await prep({ user: { userId: 'u-b1', companyId: 'company-B', role: 'MEMBER' } })
  // find the key B would use by letting B store something, then overwrite it with A's entry
  await b.store(GOOD())
  const bKey = [...fake.store.keys()].find((k) => k.includes(':ask:') && k.startsWith('memhub:cache:company-B:'))
  assert.notEqual(bKey, aKey)
  fake.store.set(bKey, aValue)
  assert.equal(await b.lookup(), null)
})

test('different authorization scopes (roles) never share an entry; the role comes from PostgreSQL, not the token', async () => {
  prisma.state.users.push({ id: 'u-a2', companyId: 'company-A', role: 'ADMIN' })
  await (await prep()).store(GOOD())

  const admin = await prep({ user: { userId: 'u-a2', companyId: 'company-A', role: 'ADMIN' } })
  assert.equal(await admin.lookup(), null)

  // token says ADMIN, database says MEMBER -> treated as MEMBER and shares the MEMBER entry
  const lying = await prep({ user: { userId: 'u-a1', companyId: 'company-A', role: 'ADMIN' } })
  assert.deepEqual(await lying.lookup(), GOOD())
  assert.notEqual(askScopeHash({ role: 'ADMIN' }), askScopeHash({ role: 'MEMBER' }))
})

// ---------- authorization first ----------
test('a caller that PostgreSQL does not confirm gets no cache handle, so nothing is read from Redis', async () => {
  await (await prep()).store(GOOD())
  fake.calls.length = 0

  const ghost = await prep({ user: { userId: 'ghost', companyId: 'company-A', role: 'MEMBER' } })
  const moved = await prep({ user: { userId: 'u-a1', companyId: 'company-B', role: 'MEMBER' } })
  assert.equal(ghost, null)
  assert.equal(moved, null)
  assert.deepEqual(fake.calls, [], 'Redis must not be touched before the caller is confirmed')
})

test('a database failure during the check bypasses the cache instead of failing', async () => {
  prisma.state.failUser = true
  assert.equal(await prep(), null)
})

// ---------- configuration changes ----------
test('different retrieval configuration (topK, graph on/off, model) means a different entry', async () => {
  await (await prep()).store(GOOD())
  for (const config of [
    { ...CONFIG, topK: 6 },
    { ...CONFIG, minScore: 0.3 },
    { ...CONFIG, model: 'other-model' },
    { ...CONFIG, graph: { ...CONFIG.graph, enabled: true } },
    { ...CONFIG, graph: { ...CONFIG.graph, maxFacts: 9 } },
  ]) {
    assert.equal(await (await prep({ config })).lookup(), null, JSON.stringify(config))
  }
  assert.equal(retrievalConfigHash({ a: 1, b: 2 }), retrievalConfigHash({ b: 2, a: 1 }), 'key order must not matter')
})

// ---------- knowledge-base version ----------
test('uploading, deleting or changing a document changes the version, so old entries are not served', async () => {
  await (await prep()).store(GOOD())
  assert.ok(await (await prep()).lookup())

  prisma.state.docs.push({ id: 'd2', companyId: 'company-A', updatedAt: new Date('2026-10-02T00:00:00Z') }) // upload
  assert.equal(await (await prep()).lookup(), null)

  await (await prep()).store(GOOD())
  assert.ok(await (await prep()).lookup())
  prisma.state.docs.shift() // delete an older document: count and newest timestamp both differ from the stored state
  assert.equal(await (await prep()).lookup(), null)

  await (await prep()).store(GOOD())
  prisma.state.graph.push({ companyId: 'company-A', updatedAt: new Date('2026-10-03T00:00:00Z') }) // graph reprocessed
  assert.equal(await (await prep()).lookup(), null)
})

test('invalidateCompanyKnowledge makes every entry of that company unreachable, and only that company', async () => {
  prisma.state.users.push({ id: 'u-b1', companyId: 'company-B', role: 'MEMBER' })
  const userB = { userId: 'u-b1', companyId: 'company-B', role: 'MEMBER' }
  await (await prep()).store(GOOD())
  await (await prep({ user: userB })).store(GOOD())

  assert.equal(await invalidateCompanyKnowledge('company-A'), true)
  assert.equal(await (await prep()).lookup(), null)
  assert.deepEqual(await (await prep({ user: userB })).lookup(), GOOD())
})

test('a lost epoch is replaced by a NEW token, never by an old one', async () => {
  const v1 = await knowledgeBaseVersion(prisma, 'company-A')
  fake.store.clear() // eviction / FLUSHALL
  const v2 = await knowledgeBaseVersion(prisma, 'company-A')
  assert.notEqual(v1, v2)
  assert.equal(await knowledgeBaseVersion(prisma, 'company-A'), v2, 'stable once created')
})

// ---------- what may be stored ----------
test('only complete, grounded, successful answers are stored', async () => {
  const h = await prep()
  const bad = [
    { success: true, grounded: false, reason: 'not_enough_info', answer: 'no', sources: [], retrieval: GOOD().retrieval },
    { success: false, message: 'Authentication required' },
    { success: false, message: 'The AI provider failed', code: 'LLM_FAILED' },
    { ...GOOD(), retrieval: { vector: { status: 'ok', chunks: 1 }, graph: { status: 'unavailable', facts: 0 } } }, // incomplete retrieval
    { ...GOOD(), retrieval: { vector: { status: 'failed' }, graph: { status: 'ok', facts: 0 } } },
    { ...GOOD(), sources: [] },
    { ...GOOD(), answer: '  ' },
    { ...GOOD(), retrieval: undefined },
    null,
  ]
  for (const body of bad) {
    assert.equal(isCacheableAskResponse(body), false)
    assert.equal(await h.store(body), false)
  }
  assert.equal([...fake.store.keys()].filter((k) => k.includes(':ask:')).length, 0)

  assert.equal(await h.store({ ...GOOD(), retrieval: { vector: { status: 'ok', chunks: 1 }, graph: { status: 'ok', facts: 2 } } }), true)
})

test('a corrupted or hand-edited entry is a miss, not an answer', async () => {
  const h = await prep()
  await h.store(GOOD())
  const key = [...fake.store.keys()].find((k) => k.includes(':ask:'))
  const entry = JSON.parse(fake.store.get(key))

  for (const tampered of [
    { ...entry, response: { ...entry.response, grounded: false } },
    { ...entry, scope: 'f'.repeat(32) },
    { ...entry, kb: 'other' },
    { ...entry, v: 99 },
    { ...entry, response: 'oops' },
  ]) {
    fake.store.set(key, JSON.stringify(tampered))
    assert.equal(await h.lookup(), null)
  }
  fake.store.set(key, 'not json')
  assert.equal(await h.lookup(), null)
})

// ---------- TTL ----------
test('ASK_CACHE_TTL sets the expiry; invalid or missing falls back to REDIS_CACHE_TTL', async () => {
  process.env.ASK_CACHE_TTL = '42'
  await (await prep()).store(GOOD())
  const set = fake.calls.find((c) => c[0] === 'SET' && String(c[1]).includes(':ask:'))
  assert.deepEqual(set.slice(3), ['EX', '42'])

  process.env.REDIS_CACHE_TTL = '90'
  for (const bad of [undefined, '', 'abc', '0', '-1', '99999999999']) {
    if (bad === undefined) delete process.env.ASK_CACHE_TTL
    else process.env.ASK_CACHE_TTL = bad
    assert.equal(askCacheTtlSeconds(), 90, String(bad))
  }
})

// ---------- Redis trouble / switches ----------
test('ASK_CACHE_ENABLED=false (or Redis not configured) means no handle and no Redis traffic', async () => {
  fake.calls.length = 0
  process.env.ASK_CACHE_ENABLED = 'false'
  assert.equal(await prep(), null)

  delete process.env.ASK_CACHE_ENABLED
  process.env.REDIS_URL = ''
  assert.equal(await prep(), null)
  assert.deepEqual(fake.calls, [])
})

test('Redis failing on every command never throws: lookup is a miss, store is false, invalidate is false', async () => {
  const boom = async () => { throw new Error('ECONNRESET') }
  await closeRedisCache()
  const broken = fakeRedis({ get: boom, sendCommand: boom })
  setRedisClientFactoryForTests(() => broken.client)
  await initRedisCache()

  // the version needs the epoch token from Redis -> no handle -> the route runs the normal pipeline
  assert.equal(await prep(), null)
  assert.equal(await invalidateCompanyKnowledge('company-A'), false)
})

test('Redis that works for the version but fails on the answer: lookup misses, store returns false', async () => {
  await closeRedisCache()
  const flaky = fakeRedis({
    get: async (key, store) => { if (key.includes(':ask:')) throw new Error('timeout'); return store.get(key) ?? null },
    sendCommand: async (args, store) => {
      if (String(args[1]).includes(':ask:')) throw new Error('timeout')
      store.set(args[1], args[2]); return 'OK'
    },
  })
  setRedisClientFactoryForTests(() => flaky.client)
  await initRedisCache()

  const h = await prep()
  assert.ok(h)
  assert.equal(await h.lookup(), null)
  assert.equal(await h.store(GOOD()), false)
})
