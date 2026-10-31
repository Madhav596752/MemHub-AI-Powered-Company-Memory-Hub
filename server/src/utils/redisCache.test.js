// Tests the Redis cache service against a FAKE client. No Redis server or network is used.
// They check the contract the rest of MemHub relies on: nothing here ever throws or hangs, a missing or broken
// Redis just means "cache miss", values survive a JSON round trip, TTLs are applied, and the URL is never logged.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  initRedisCache, closeRedisCache, getRedisStatus, checkRedisHealth, cacheGet, cacheSet, cacheKey,
  setRedisClientFactoryForTests, defaultTtlSeconds, connectTimeoutMs,
} from './redisCache.js'

const SECRET_URL = 'redis://:s3cr3t-password@127.0.0.1:6379'

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

// A minimal stand-in for a node-redis client. `behaviour` lets each test break individual parts.
function fakeClient(behaviour = {}) {
  const store = new Map()
  const calls = { sendCommand: [], get: [] }
  const c = new EventEmitter()
  c.isOpen = false
  c.isReady = false
  c.connect = async () => {
    if (behaviour.connect) return behaviour.connect(c)
    c.isOpen = true
    c.isReady = true
    c.emit('ready')
  }
  c.get = async (key) => {
    calls.get.push(key)
    if (behaviour.get) return behaviour.get(key, store)
    return store.has(key) ? store.get(key) : null
  }
  c.sendCommand = async (args) => {
    calls.sendCommand.push(args)
    if (behaviour.sendCommand) return behaviour.sendCommand(args, store)
    store.set(args[1], args[2])
    return 'OK'
  }
  c.ping = async () => (behaviour.ping ? behaviour.ping() : 'PONG')
  c.quit = async () => { c.isOpen = false; c.isReady = false }
  c.disconnect = () => { c.isOpen = false; c.isReady = false }
  return { client: c, store, calls }
}

let restoreEnv
let optionsSeen
let logs
function useFake(behaviour) {
  const fake = fakeClient(behaviour)
  setRedisClientFactoryForTests((options) => { optionsSeen = options; return fake.client })
  return fake
}

test.beforeEach(() => {
  restoreEnv = withEnv({ REDIS_URL: SECRET_URL, REDIS_CONNECT_TIMEOUT: '100', REDIS_CACHE_TTL: undefined })
  optionsSeen = null
  logs = []
  for (const level of ['log', 'warn', 'error']) mock.method(console, level, (...args) => { logs.push(args.join(' ')) })
})
test.afterEach(async () => {
  await closeRedisCache()
  setRedisClientFactoryForTests(null)
  mock.restoreAll()
  restoreEnv()
})

// ---------- configuration ----------
test('not configured: status is "disabled", nothing is created, every call is a harmless no-op', async () => {
  restoreEnv()
  restoreEnv = withEnv({ REDIS_URL: undefined })
  let created = 0
  setRedisClientFactoryForTests(() => { created++; return fakeClient().client })

  assert.deepEqual(await initRedisCache(), { configured: false, status: 'disabled' })
  assert.deepEqual(getRedisStatus(), { configured: false, status: 'disabled' })
  assert.deepEqual(await checkRedisHealth(), { configured: false, status: 'disabled' })
  assert.equal(await cacheGet('k'), null)
  assert.equal(await cacheSet('k', { a: 1 }), false)
  assert.equal(created, 0)
})

test('a blank REDIS_URL counts as not configured', async () => {
  restoreEnv()
  restoreEnv = withEnv({ REDIS_URL: '   ' })
  assert.equal(getRedisStatus().status, 'disabled')
})

test('REDIS_CONNECT_TIMEOUT and REDIS_CACHE_TTL: defaults, valid values, invalid values fall back', () => {
  restoreEnv()
  restoreEnv = withEnv({ REDIS_CONNECT_TIMEOUT: undefined, REDIS_CACHE_TTL: undefined })
  assert.equal(connectTimeoutMs(), 2000)
  assert.equal(defaultTtlSeconds(), 300)

  process.env.REDIS_CONNECT_TIMEOUT = '750'
  process.env.REDIS_CACHE_TTL = '60'
  assert.equal(connectTimeoutMs(), 750)
  assert.equal(defaultTtlSeconds(), 60)

  for (const bad of ['abc', '0', '-5', '', '99999999999']) {
    process.env.REDIS_CONNECT_TIMEOUT = bad
    process.env.REDIS_CACHE_TTL = bad
    assert.equal(connectTimeoutMs(), 2000, `timeout ${bad}`)
    assert.equal(defaultTtlSeconds(), 300, `ttl ${bad}`)
  }
})

// ---------- connection ----------
test('init connects, reports "ok", passes the URL + timeout to the client, and logs no secret', async () => {
  useFake()
  assert.deepEqual(await initRedisCache(), { configured: true, status: 'ok' })
  assert.equal(optionsSeen.url, SECRET_URL)
  assert.equal(optionsSeen.socket.connectTimeout, 100)
  assert.equal(optionsSeen.disableOfflineQueue, true)
  assert.equal(optionsSeen.socket.reconnectStrategy(0), 100)
  assert.equal(optionsSeen.socket.reconnectStrategy(50), 5000) // capped backoff
  assert.ok(!logs.join('\n').includes('s3cr3t'), 'the password must never be logged')
})

test('init is idempotent: a second call reuses the same client', async () => {
  let created = 0
  setRedisClientFactoryForTests(() => { created++; return fakeClient().client })
  await Promise.all([initRedisCache(), initRedisCache()])
  await initRedisCache()
  assert.equal(created, 1)
})

test('Redis down at startup: init resolves "unavailable" within the timeout and never rejects or throws', async () => {
  const fake = useFake({ connect: () => new Promise(() => {}) }) // never connects, never fails
  const started = Date.now()
  assert.deepEqual(await initRedisCache(), { configured: true, status: 'unavailable' })
  assert.ok(Date.now() - started < 1500, 'init must not wait for a dead Redis')
  assert.equal(await cacheGet('k'), null)
  assert.equal(await cacheSet('k', 1), false)
  assert.equal(fake.calls.get.length + fake.calls.sendCommand.length, 0, 'no command is sent while not ready')
})

test('Redis down at startup: caching resumes by itself once the client becomes ready', async () => {
  const fake = useFake({ connect: () => new Promise(() => {}) })
  await initRedisCache()
  assert.equal(getRedisStatus().status, 'unavailable')

  fake.client.isReady = true // the background reconnect succeeded
  assert.equal(getRedisStatus().status, 'ok')
  assert.equal(await cacheSet('k', { v: 1 }), true)
  assert.deepEqual(await cacheGet('k'), { v: 1 })
})

test('connect() rejecting is handled: no throw, status "unavailable"', async () => {
  useFake({ connect: async () => { throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }) } })
  assert.deepEqual(await initRedisCache(), { configured: true, status: 'unavailable' })
  assert.ok(logs.some((l) => l.includes('ECONNREFUSED')))
})

test('a failing client factory (e.g. malformed REDIS_URL) does not throw', async () => {
  setRedisClientFactoryForTests(() => { throw Object.assign(new TypeError('Invalid URL'), { input: SECRET_URL }) })
  assert.deepEqual(await initRedisCache(), { configured: true, status: 'unavailable' })
  assert.ok(!logs.join('\n').includes('s3cr3t'))
  assert.equal(await cacheGet('k'), null)
})

test('"error" events are handled (an unhandled one would crash the process) and logged once, not per retry', async () => {
  const fake = useFake()
  await initRedisCache()
  assert.ok(fake.client.listenerCount('error') >= 1)
  for (let i = 0; i < 5; i++) fake.client.emit('error', Object.assign(new Error('x'), { code: 'ECONNRESET' }))
  assert.equal(logs.filter((l) => l.includes('ECONNRESET')).length, 1)
})

test('connection lost later: status flips to "unavailable" and calls fall back to a miss', async () => {
  const fake = useFake()
  await initRedisCache()
  assert.equal(await cacheSet('k', { a: 1 }), true)
  fake.client.isReady = false
  assert.equal(getRedisStatus().status, 'unavailable')
  assert.equal(await cacheGet('k'), null)
  assert.equal(await cacheSet('k', { a: 2 }), false)
})

test('close: quits the client, resets state, and a later init starts fresh', async () => {
  let created = 0
  setRedisClientFactoryForTests(() => { created++; return fakeClient().client })
  await initRedisCache()
  await closeRedisCache()
  assert.equal(getRedisStatus().status, 'unavailable')
  await initRedisCache()
  assert.equal(created, 2)
  await closeRedisCache()
  await closeRedisCache() // closing twice is fine
})

// ---------- health ----------
test('checkRedisHealth: PINGs; a failing or hanging PING reports "unavailable" without throwing', async () => {
  const fake = useFake()
  await initRedisCache()
  assert.deepEqual(await checkRedisHealth(), { configured: true, status: 'ok' })

  fake.client.ping = async () => { throw new Error('connection closed') }
  assert.deepEqual(await checkRedisHealth(), { configured: true, status: 'unavailable' })

  fake.client.ping = () => new Promise(() => {})
  const started = Date.now()
  assert.deepEqual(await checkRedisHealth(), { configured: true, status: 'unavailable' })
  assert.ok(Date.now() - started < 1500)
})

// ---------- get / set ----------
test('JSON round trip keeps objects, arrays, strings, numbers, booleans and nesting', async () => {
  useFake()
  await initRedisCache()
  const values = [{ a: 1, nested: { list: [1, 'two', { three: 3 }], ok: true }, text: 'häll\u00f6 \u{1F600}' }, [1, 2, 3], 'plain string', 42, 0, false, '']
  for (const [i, v] of values.entries()) {
    assert.equal(await cacheSet(`k${i}`, v), true)
    assert.deepEqual(await cacheGet(`k${i}`), v)
  }
})

test('keys are namespaced under memhub:cache: and the value is stored as JSON text', async () => {
  const fake = useFake()
  await initRedisCache()
  await cacheSet('company-1:ask:abc', { answer: 'x' })
  assert.deepEqual([...fake.store.keys()], ['memhub:cache:company-1:ask:abc'])
  assert.equal(fake.store.get('memhub:cache:company-1:ask:abc'), '{"answer":"x"}')
  assert.equal(await cacheGet('other-company:ask:abc'), null)
})

test('a miss returns null', async () => {
  useFake()
  await initRedisCache()
  assert.equal(await cacheGet('missing'), null)
})

test('TTL: default 300 s, REDIS_CACHE_TTL overrides it, a per-call ttlSeconds wins, invalid ones fall back', async () => {
  const fake = useFake()
  await initRedisCache()
  const ttlOfLast = () => fake.calls.sendCommand.at(-1)

  await cacheSet('a', 1)
  assert.deepEqual(ttlOfLast(), ['SET', 'memhub:cache:a', '1', 'EX', '300'])

  process.env.REDIS_CACHE_TTL = '45'
  await cacheSet('b', 1)
  assert.equal(ttlOfLast()[4], '45')

  await cacheSet('c', 1, { ttlSeconds: 10 })
  assert.equal(ttlOfLast()[4], '10')

  for (const bad of [0, -1, 1.5, NaN, '10', 99999999999, null]) {
    await cacheSet('d', 1, { ttlSeconds: bad })
    assert.equal(ttlOfLast()[4], '45', `ttlSeconds ${String(bad)}`)
  }
  for (const call of fake.calls.sendCommand) assert.equal(call[3], 'EX', 'every write carries an expiry')
})

test('values that cannot be stored are refused (false) instead of throwing, and nothing is sent', async () => {
  const fake = useFake()
  await initRedisCache()
  const circular = {}
  circular.self = circular
  for (const bad of [undefined, null, circular, 10n, () => {}, Symbol('x')]) {
    assert.equal(await cacheSet('k', bad), false)
  }
  assert.equal(fake.calls.sendCommand.length, 0)
})

test('invalid keys are refused without touching Redis', async () => {
  const fake = useFake()
  await initRedisCache()
  for (const bad of ['', undefined, null, 42, {}, 'x'.repeat(513)]) {
    assert.equal(await cacheGet(bad), null)
    assert.equal(await cacheSet(bad, 1), false)
  }
  assert.equal(fake.calls.get.length + fake.calls.sendCommand.length, 0)
})

test('Redis errors on GET / SET are swallowed: miss / false, no throw', async () => {
  useFake({
    get: async () => { throw new Error('READONLY') },
    sendCommand: async () => { throw new Error('OOM command not allowed') },
  })
  await initRedisCache()
  assert.equal(await cacheGet('k'), null)
  assert.equal(await cacheSet('k', { a: 1 }), false)
})

test('a SET reply other than OK counts as not stored', async () => {
  useFake({ sendCommand: async () => null })
  await initRedisCache()
  assert.equal(await cacheSet('k', 1), false)
})

test('corrupt (non-JSON) cached text is treated as a miss, not an error', async () => {
  useFake({ get: async () => '{not json' })
  await initRedisCache()
  assert.equal(await cacheGet('k'), null)
})

test('a hanging command times out after REDIS_CONNECT_TIMEOUT and a late failure is not an unhandled rejection', async () => {
  let rejectLate
  useFake({
    get: () => new Promise((_, reject) => { rejectLate = reject }),
    sendCommand: () => new Promise(() => {}),
  })
  await initRedisCache()
  const unhandled = []
  const onUnhandled = (err) => unhandled.push(err)
  process.on('unhandledRejection', onUnhandled)
  try {
    const started = Date.now()
    assert.equal(await cacheGet('k'), null)
    assert.ok(Date.now() - started < 1500)
    assert.equal(await cacheSet('k', 1), false)
    rejectLate(new Error('late failure'))
    await new Promise((r) => setTimeout(r, 30))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

// ---------- cacheKey ----------
test('cacheKey joins parts and keeps tenants apart even with separators inside a part', () => {
  assert.equal(cacheKey('company-1', 'ask', 'abc'), 'company-1:ask:abc')
  assert.equal(cacheKey(7, 'x'), '7:x')
  assert.notEqual(cacheKey('a:b', 'c'), cacheKey('a', 'b:c'))
  assert.equal(cacheKey('a:b', 'c'), 'a%3Ab:c')
})

test('cacheKey refuses a missing part (a key without a companyId would be shared by every tenant)', () => {
  assert.throws(() => cacheKey(), TypeError)
  assert.throws(() => cacheKey(undefined, 'ask'), TypeError)
  assert.throws(() => cacheKey(null, 'ask'), TypeError)
  assert.throws(() => cacheKey('', 'ask'), TypeError)
})
