// Module 9.5: the Redis cache layer (redisCache.js) against a REAL redis-server that this file starts itself
// (see test-helpers/redisServer.js). It proves what fake clients cannot:
//   connection success / refused / wrong password, miss, hit, real TTL expiry, a real "WRONGTYPE" read error, a real
//   "OOM" write error, a paused (slow) server, a killed server (disconnection) and the same server coming back (recovery).
// Skipped automatically when the redis-server binary is not installed.
//
//   npm run test:redis
import test from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from 'redis'
import { SKIP_NO_REDIS_SERVER, freePort, startRedisServer } from '../test-helpers/redisServer.js'

const skip = SKIP_NO_REDIS_SERVER
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 8000, step = 50) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(step)
  }
  return false
}

const unhandled = []
process.on('unhandledRejection', (reason) => unhandled.push(reason))

// Captures console output so tests can assert on what is (not) logged.
function captureLogs() {
  const lines = []
  const originals = {}
  for (const level of ['log', 'warn', 'error']) {
    originals[level] = console[level]
    console[level] = (...args) => lines.push(`${level}: ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`)
  }
  return { lines, restore: () => Object.assign(console, originals) }
}

let cache
let server
let raw // a plain client used only to inspect / sabotage the server

if (!skip) {
  process.env.REDIS_CONNECT_TIMEOUT = '300'
  delete process.env.REDIS_CACHE_TTL
  cache = await import('./redisCache.js')
  server = await startRedisServer()
  raw = createClient({ url: server.url })
  raw.on('error', () => {})
  await raw.connect()
}

async function connectCache(url = server.url) {
  await cache.closeRedisCache()
  process.env.REDIS_URL = url
  return cache.initRedisCache()
}

test.after(async () => {
  if (skip) return
  await cache.closeRedisCache()
  if (raw.isOpen) await raw.quit().catch(() => {})
  await server.close()
  delete process.env.REDIS_URL
})

test('connection success: init reports ok, health check passes, status is ok', { skip }, async () => {
  assert.deepEqual(await connectCache(), { configured: true, status: 'ok' })
  assert.deepEqual(cache.getRedisStatus(), { configured: true, status: 'ok' })
  assert.deepEqual(await cache.checkRedisHealth(), { configured: true, status: 'ok' })
})

test('connection success with a password: works, and the password never appears in the log', { skip }, async () => {
  const secured = await startRedisServer({ password: 'p4ss-W0rd-secret' })
  const logs = captureLogs()
  try {
    assert.deepEqual(await connectCache(secured.url), { configured: true, status: 'ok' })
    const key = cache.cacheKey('company-pw', 'x')
    assert.equal(await cache.cacheSet(key, { ok: true }), true)
    assert.deepEqual(await cache.cacheGet(key), { ok: true })
  } finally {
    logs.restore()
    await cache.closeRedisCache()
    await secured.close()
  }
  assert.ok(!logs.lines.some((l) => l.includes('p4ss-W0rd-secret')), 'the password must never be logged')
})

test('connection failure: nothing listens on the port -> init resolves "unavailable" within the timeout, calls are misses', { skip }, async () => {
  const deadPort = await freePort()
  const logs = captureLogs()
  const started = Date.now()
  let status
  try {
    status = await connectCache(`redis://:topsecret@127.0.0.1:${deadPort}`)
    const elapsed = Date.now() - started
    assert.deepEqual(status, { configured: true, status: 'unavailable' })
    assert.ok(elapsed < 1500, `init must not hang (took ${elapsed} ms)`)

    const key = cache.cacheKey('company-x', 'dead')
    const t0 = Date.now()
    assert.equal(await cache.cacheGet(key), null)
    assert.equal(await cache.cacheSet(key, { a: 1 }), false)
    assert.equal(await cache.cacheGetOrCreateToken(key), null)
    assert.equal(await cache.cacheRotateToken(key), false)
    assert.deepEqual(await cache.checkRedisHealth(), { configured: true, status: 'unavailable' })
    assert.ok(Date.now() - t0 < 500, 'commands must fail fast while Redis is down (no offline queue)')
    await sleep(700) // let several reconnect attempts happen
  } finally {
    logs.restore()
    await cache.closeRedisCache()
  }
  assert.ok(!logs.lines.some((l) => l.includes('topsecret')), 'the URL password must never be logged')
  const errorLines = logs.lines.filter((l) => l.startsWith('error:'))
  assert.ok(errorLines.length <= 3, `repeated identical errors must be logged once, not per retry (got ${errorLines.length})`)
})

test('wrong password: caching stays off, the app is not stopped, the password is not logged', { skip }, async () => {
  const secured = await startRedisServer({ password: 'right-password-123' })
  const logs = captureLogs()
  try {
    const status = await connectCache(`redis://:wrong-password-456@127.0.0.1:${secured.port}`)
    assert.equal(status.status, 'unavailable')
    assert.equal(await cache.cacheGet(cache.cacheKey('c', 'k')), null)
  } finally {
    logs.restore()
    await cache.closeRedisCache()
    await secured.close()
  }
  assert.ok(!logs.lines.some((l) => l.includes('wrong-password-456') || l.includes('right-password-123')))
})

test('cache miss, then hit: the stored value comes back unchanged', { skip }, async () => {
  await connectCache()
  const key = cache.cacheKey('company-hit', 'ask', 'q1')
  assert.equal(await cache.cacheGet(key), null, 'first read is a miss')
  const value = { answer: 'Refunds within 14 days', sources: [{ documentId: 'd1' }], n: 3, unicode: 'é \u{1F600}' }
  assert.equal(await cache.cacheSet(key, value), true)
  assert.deepEqual(await cache.cacheGet(key), value, 'second read is a hit')
})

test('TTL expiration: the entry exists until its TTL passes, then it is a miss again', { skip }, async () => {
  await connectCache()
  const key = cache.cacheKey('company-ttl', 'short')
  assert.equal(await cache.cacheSet(key, { x: 1 }, { ttlSeconds: 1 }), true)
  const ttl = await raw.pTTL(`memhub:cache:${key}`)
  assert.ok(ttl > 0 && ttl <= 1000, `expected a TTL of at most 1000 ms, got ${ttl}`)
  assert.deepEqual(await cache.cacheGet(key), { x: 1 })
  assert.ok(await until(async () => (await cache.cacheGet(key)) === null, 3000), 'the entry must expire')
  assert.equal(await raw.exists(`memhub:cache:${key}`), 0, 'and really be gone from Redis')
})

test('read failure: a key of the wrong type (WRONGTYPE) and corrupt JSON are misses, never errors', { skip }, async () => {
  await connectCache()
  const wrongType = cache.cacheKey('company-rf', 'list')
  await raw.lPush(`memhub:cache:${wrongType}`, 'x')
  assert.equal(await cache.cacheGet(wrongType), null)

  const corrupt = cache.cacheKey('company-rf', 'corrupt')
  await raw.set(`memhub:cache:${corrupt}`, '{not json')
  assert.equal(await cache.cacheGet(corrupt), null)

  assert.equal(cache.getRedisStatus().status, 'ok', 'a failed read must not mark Redis as down')
  // a write over the wrong-typed key works again (SET replaces any type)
  assert.equal(await cache.cacheSet(wrongType, { fixed: true }), true)
  assert.deepEqual(await cache.cacheGet(wrongType), { fixed: true })
})

test('write failure: Redis out of memory refuses SET -> cacheSet is false, reads still work, nothing throws', { skip }, async () => {
  await connectCache()
  const existing = cache.cacheKey('company-wf', 'existing')
  assert.equal(await cache.cacheSet(existing, { v: 1 }), true)

  await raw.configSet('maxmemory-policy', 'noeviction')
  await raw.configSet('maxmemory', '1')
  try {
    assert.equal(await cache.cacheSet(cache.cacheKey('company-wf', 'new'), { v: 2 }), false, 'a write that Redis rejects is reported as not stored')
    assert.equal(await cache.cacheRotateToken(cache.cacheKey('company-wf', 'epoch')), false)
    assert.deepEqual(await cache.cacheGet(existing), { v: 1 }, 'reads keep working')
  } finally {
    await raw.configSet('maxmemory', '0')
  }
  assert.equal(await cache.cacheSet(cache.cacheKey('company-wf', 'new'), { v: 2 }), true, 'writes work again once memory is available')
})

test('slow Redis: a paused server makes a command give up after REDIS_CONNECT_TIMEOUT (300 ms) with a miss', { skip }, async () => {
  await connectCache()
  const key = cache.cacheKey('company-slow', 'k')
  await cache.cacheSet(key, { v: 1 })
  await raw.sendCommand(['CLIENT', 'PAUSE', '1200', 'ALL'])
  const t0 = Date.now()
  assert.equal(await cache.cacheGet(key), null)
  const elapsed = Date.now() - t0
  assert.ok(elapsed >= 250 && elapsed < 900, `expected about 300 ms, took ${elapsed} ms`)
  assert.equal(await cache.cacheSet(key, { v: 2 }), false)
  await sleep(1300) // the pause ends; the late replies must not surface as unhandled rejections
  // A command that timed out on OUR side was still sent: Redis may execute it once the pause ends. So the old OR the new
  // value is there, never anything else, and the cache keeps working. (Safe for the answer cache: its keys carry the
  // knowledge-base version, so a late write can only ever land under the key of the data it was computed from.)
  assert.ok([1, 2].includes((await cache.cacheGet(key))?.v))
  assert.equal(cache.getRedisStatus().status, 'ok')
})

test('Redis disconnection and recovery: killed server -> unavailable and fast misses; same server back -> ok again, caching resumes', { skip }, async () => {
  const own = await startRedisServer()
  const logs = captureLogs()
  try {
    assert.equal((await connectCache(own.url)).status, 'ok')
    const key = cache.cacheKey('company-recover', 'k')
    assert.equal(await cache.cacheSet(key, { before: true }), true)

    await own.stop() // crash
    assert.ok(await until(() => cache.getRedisStatus().status === 'unavailable', 3000), 'the loss of the connection must be noticed')

    const t0 = Date.now()
    assert.equal(await cache.cacheGet(key), null)
    assert.equal(await cache.cacheSet(key, { during: true }), false)
    assert.equal(await cache.cacheGetOrCreateToken(cache.cacheKey('company-recover', 'epoch')), null, 'no version can be built while Redis is down')
    assert.deepEqual(await cache.checkRedisHealth(), { configured: true, status: 'unavailable' })
    assert.ok(Date.now() - t0 < 600, 'while Redis is down every call answers at once')

    await own.start() // the server comes back (empty: persistence is off)
    assert.ok(await until(() => cache.getRedisStatus().status === 'ok', 12000), 'the client must reconnect by itself')
    assert.deepEqual(await cache.checkRedisHealth(), { configured: true, status: 'ok' })
    assert.equal(await cache.cacheGet(key), null, 'data of the crashed server is gone: a plain miss')
    assert.equal(await cache.cacheSet(key, { after: true }), true)
    assert.deepEqual(await cache.cacheGet(key), { after: true })
  } finally {
    logs.restore()
    await cache.closeRedisCache()
    await own.close()
  }
  const lost = logs.lines.filter((l) => l.includes('connection lost'))
  assert.equal(lost.length, 1, 'the outage is logged once, not once per reconnect attempt')
  assert.ok(logs.lines.some((l) => l.includes('Redis cache connected')), 'recovery is logged')
})

test('a token that vanishes (eviction / FLUSHALL) is replaced by a NEW value, never an old one', { skip }, async () => {
  await connectCache()
  const key = cache.cacheKey('company-token', 'kb-epoch')
  const first = await cache.cacheGetOrCreateToken(key)
  assert.ok(first)
  assert.equal(await cache.cacheGetOrCreateToken(key), first, 'stable while nothing changes')
  await raw.del(`memhub:cache:${key}`)
  const second = await cache.cacheGetOrCreateToken(key)
  assert.ok(second && second !== first)
  assert.equal(await cache.cacheRotateToken(key), true)
  const third = await cache.cacheGetOrCreateToken(key)
  assert.ok(third !== second && third !== first)
  assert.equal(await raw.ttl(`memhub:cache:${key}`), -1, 'tokens have no expiry (so they are not lost by TTL)')
})

test('concurrent creators of the same token agree on ONE value (SET NX)', { skip }, async () => {
  await connectCache()
  const key = cache.cacheKey('company-race', 'kb-epoch')
  const seen = await Promise.all(Array.from({ length: 25 }, () => cache.cacheGetOrCreateToken(key)))
  assert.equal(new Set(seen).size, 1)
  assert.ok(seen[0])
})

test('no unhandled promise rejections happened anywhere in this file', { skip }, async () => {
  await sleep(100)
  assert.deepEqual(unhandled, [])
})
