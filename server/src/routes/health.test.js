// GET /api/health keeps its original fields and adds the Redis status. Redis being off or down must never
// change the HTTP status, and nothing sensitive (the URL) may appear in the response.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { healthHandler } from './health.js'
import { initRedisCache, closeRedisCache, setRedisClientFactoryForTests } from '../utils/redisCache.js'
import { EventEmitter } from 'node:events'

const SECRET_URL = 'redis://:s3cr3t-password@127.0.0.1:6379'

function call() {
  const res = { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
  return healthHandler({}, res).then(() => res)
}

function fakeClient({ ready = true, ping } = {}) {
  const c = new EventEmitter()
  c.isOpen = ready
  c.isReady = ready
  c.connect = async () => { if (!ready) return new Promise(() => {}); c.emit('ready') }
  c.ping = ping || (async () => 'PONG')
  c.quit = async () => { c.isOpen = false; c.isReady = false }
  return c
}

const saved = { url: process.env.REDIS_URL, timeout: process.env.REDIS_CONNECT_TIMEOUT }
test.beforeEach(() => {
  process.env.REDIS_CONNECT_TIMEOUT = '100'
  for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {})
})
test.afterEach(async () => {
  await closeRedisCache()
  setRedisClientFactoryForTests(null)
  mock.restoreAll()
  for (const [name, value] of [['REDIS_URL', saved.url], ['REDIS_CONNECT_TIMEOUT', saved.timeout]]) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test('health: Redis not configured -> 200, original fields kept, redis "disabled"', async () => {
  delete process.env.REDIS_URL
  const res = await call()
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body, { status: 'ok', message: 'MemHub API is running', redis: { configured: false, status: 'disabled' } })
})

test('health: Redis connected -> redis "ok"', async () => {
  process.env.REDIS_URL = SECRET_URL
  setRedisClientFactoryForTests(() => fakeClient())
  await initRedisCache()
  const res = await call()
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.redis, { configured: true, status: 'ok' })
})

test('health: Redis unreachable -> still 200 and status "ok" for the API, redis "unavailable"', async () => {
  process.env.REDIS_URL = SECRET_URL
  setRedisClientFactoryForTests(() => fakeClient({ ready: false }))
  await initRedisCache()
  const res = await call()
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.status, 'ok')
  assert.deepEqual(res.body.redis, { configured: true, status: 'unavailable' })
})

test('health: a connection that dies (PING fails) is reported "unavailable", not thrown', async () => {
  process.env.REDIS_URL = SECRET_URL
  setRedisClientFactoryForTests(() => fakeClient({ ping: async () => { throw new Error('closed') } }))
  await initRedisCache()
  const res = await call()
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.redis, { configured: true, status: 'unavailable' })
})

test('health: the response never contains the Redis URL or password', async () => {
  process.env.REDIS_URL = SECRET_URL
  setRedisClientFactoryForTests(() => fakeClient())
  await initRedisCache()
  const res = await call()
  assert.ok(!JSON.stringify(res.body).includes('s3cr3t'))
  assert.ok(!JSON.stringify(res.body).includes('127.0.0.1'))
})
