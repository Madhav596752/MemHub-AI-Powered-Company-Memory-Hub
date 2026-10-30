// Redis-backed rate limiting. SKIPPED unless REDIS_URL is set, e.g.
//   REDIS_URL=redis://127.0.0.1:6379 npm run test:redis
// Two copies of rateLimit.js are loaded (?instance=a / ?instance=b), each with its own Redis connection and
// its own limiter objects, to stand in for two backend processes behind a load balancer.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'
import express from 'express'

const REDIS_URL = process.env.REDIS_URL
const skip = REDIS_URL ? false : 'REDIS_URL is not set'

Object.assign(process.env, {
  RATE_LIMIT_ASK_MAX: '2',
  RATE_LIMIT_ASK_WINDOW_SECONDS: '2',
  RATE_LIMIT_LOGIN_MAX: '2',
  RATE_LIMIT_LOGIN_WINDOW_SECONDS: '2', // short window: the per-IP key (127.0.0.1) must not outlive this run
  RATE_LIMIT_LOGIN_ACCOUNT_MAX: '2',
})

let a, b, redis
const servers = []
async function serve(app) {
  const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)) })
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}
const run = crypto.randomUUID().slice(0, 8) // keeps runs independent of each other

if (!skip) {
  a = await import('./rateLimit.js?instance=a')
  b = await import('./rateLimit.js?instance=b')
  const { createClient } = await import('redis')
  redis = createClient({ url: REDIS_URL })
  await redis.connect()
}

function appFor(instance, userId) {
  const app = express()
  app.use(express.json())
  app.use((req, res, next) => { req.user = { userId: userId(req) }; next() })
  app.post('/ask', instance.askLimiter, (req, res) => res.json({ ok: true }))
  app.post('/login', instance.loginLimiter, instance.loginAccountLimiter, (req, res) => res.status(req.body?.ok ? 200 : 401).json({}))
  return app
}
const post = async (base, path, body = {}) => (await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status

test.after(async () => {
  servers.forEach((s) => s.close())
  if (!skip) {
    await Promise.all([a.closeRateLimitStore(), b.closeRateLimitStore(), redis.quit()])
  }
})

test('the store is Redis', { skip }, () => {
  assert.equal(a.rateLimitStoreKind(), 'redis')
  assert.equal(b.rateLimitStoreKind(), 'redis')
})

test('two instances share ONE counter per user (the limit is not multiplied by the number of instances)', { skip }, async () => {
  const user = `user-${run}`
  const one = await serve(appFor(a, () => user))
  const two = await serve(appFor(b, () => user))
  assert.equal(await post(one, '/ask'), 200) // instance A
  assert.equal(await post(two, '/ask'), 200) // instance B
  assert.equal(await post(one, '/ask'), 429) // limit of 2 already used up across both
  assert.equal(await post(two, '/ask'), 429)
  assert.equal(await post(two, '/ask'), 429)

  const other = await serve(appFor(b, () => `other-${run}`))
  assert.equal(await post(other, '/ask'), 200, 'another user has their own counter')
})

test('counters expire with the window and keys carry a TTL', { skip }, async () => {
  const user = `ttl-${run}`
  const base = await serve(appFor(a, () => user))
  await post(base, '/ask')
  const ttl = await redis.pTTL(`memhub:rl:ask:${user}`)
  assert.ok(ttl > 0 && ttl <= 2000, `ttl ${ttl}`)
  await post(base, '/ask')
  assert.equal(await post(base, '/ask'), 429)
  await new Promise((r) => setTimeout(r, 2300))
  assert.equal(await post(base, '/ask'), 200, 'allowed again after the window')
})

test('login: only failures count (successes are decremented) and e-mail addresses are never stored in Redis keys', { skip }, async () => {
  // the per-IP counter is shared by every run on this machine: start from a clean slate
  const stale = await redis.keys('memhub:rl:login-*')
  if (stale.length) await redis.del(stale)
  const email = `Victim.${run}@Example.test`
  const base = await serve(appFor(b, () => 'n/a'))
  for (let i = 0; i < 5; i++) assert.equal(await post(base, '/login', { email, ok: true }), 200, `success ${i + 1}`)
  assert.equal(await post(base, '/login', { email }), 401)
  assert.equal(await post(base, '/login', { email }), 401)
  assert.equal(await post(base, '/login', { email }), 429)

  const keys = await redis.keys('memhub:rl:login-account:*')
  assert.ok(keys.length >= 1)
  assert.ok(keys.every((k) => !k.toLowerCase().includes(run)), 'no plaintext e-mail in any key')
})
