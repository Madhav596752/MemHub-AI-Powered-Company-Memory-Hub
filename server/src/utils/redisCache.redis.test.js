// Redis cache against a REAL Redis server. SKIPPED unless REDIS_URL is set, e.g.
//   REDIS_URL=redis://127.0.0.1:6379 npm run test:redis
import test from 'node:test'
import assert from 'node:assert/strict'

const skip = process.env.REDIS_URL ? false : 'REDIS_URL is not set'
let cache
let raw
const run = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` // keeps runs independent

if (!skip) {
  cache = await import('./redisCache.js')
  const { createClient } = await import('redis')
  raw = createClient({ url: process.env.REDIS_URL })
  await raw.connect()
}

test.after(async () => {
  if (skip) return
  const keys = await raw.keys(`memhub:cache:${run}:*`)
  if (keys.length) await raw.del(keys)
  await Promise.all([cache.closeRedisCache(), raw.quit()])
})

test('real Redis: init reports "ok" and the health check passes', { skip }, async () => {
  assert.deepEqual(await cache.initRedisCache(), { configured: true, status: 'ok' })
  assert.deepEqual(await cache.checkRedisHealth(), { configured: true, status: 'ok' })
})

test('real Redis: JSON round trip, namespaced key, and the default TTL is really applied', { skip }, async () => {
  const key = cache.cacheKey(run, 'roundtrip')
  const value = { a: 1, list: [1, 2, 3], text: 'hello \u{1F600}' }
  assert.equal(await cache.cacheSet(key, value), true)
  assert.deepEqual(await cache.cacheGet(key), value)

  const ttl = await raw.ttl(`memhub:cache:${key}`)
  assert.ok(ttl > 0 && ttl <= cache.defaultTtlSeconds(), `expected a TTL in (0, ${cache.defaultTtlSeconds()}], got ${ttl}`)
})

test('real Redis: a per-call ttlSeconds is applied and the entry expires', { skip }, async () => {
  const key = cache.cacheKey(run, 'short')
  assert.equal(await cache.cacheSet(key, { x: 1 }, { ttlSeconds: 1 }), true)
  assert.ok((await raw.ttl(`memhub:cache:${key}`)) <= 1)
  await new Promise((r) => setTimeout(r, 1300))
  assert.equal(await cache.cacheGet(key), null)
})

test('real Redis: a miss is null', { skip }, async () => {
  assert.equal(await cache.cacheGet(cache.cacheKey(run, 'nope')), null)
})
