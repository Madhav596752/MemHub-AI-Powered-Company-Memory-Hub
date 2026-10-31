// Security headers, CORS compatibility, proxy settings, config checks and the error handler,
// using the real middleware modules that index.js uses.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import cors from 'cors'
import { applySecurity, parseTrustProxy, checkAuthConfig } from './security.js'
import { apiNotFound, apiErrorHandler } from './errorHandler.js'

function buildApp(env = {}) {
  const app = express()
  applySecurity(app, env)
  app.use(cors({ origin: 'http://localhost:5173' })) // same call as index.js
  app.use(express.json())
  app.get('/api/health', (req, res) => res.json({ ok: true }))
  app.post('/api/auth/login', (req, res) => res.json({ accessToken: 'x' }))
  app.get('/api/boom', () => { throw new Error('secret=hunter2 at /srv/app/db.js:10') })
  app.get('/api/ip', (req, res) => res.json({ ip: req.ip }))
  app.use('/api', apiNotFound)
  app.use(apiErrorHandler)
  return app
}
async function serve(app) {
  const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)) })
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}

test('security headers are set on API responses', async () => {
  const { base, close } = await serve(buildApp())
  try {
    const res = await fetch(`${base}/api/health`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('x-powered-by'), null)
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none';frame-ancestors 'none'")
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin')
    assert.equal(res.headers.get('x-dns-prefetch-control'), 'off')
    assert.equal(res.headers.get('strict-transport-security'), null, 'no HSTS outside production')
  } finally { close() }
})

test('in production HSTS is sent WITHOUT includeSubDomains or preload', async () => {
  const { base, close } = await serve(buildApp({ NODE_ENV: 'production' }))
  try {
    const hsts = (await fetch(`${base}/api/health`)).headers.get('strict-transport-security')
    assert.match(hsts, /^max-age=\d+$/)
  } finally { close() }
})

test('auth responses (which contain tokens) are never cacheable; other routes are not forced to no-store', async () => {
  const { base, close } = await serve(buildApp())
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(login.headers.get('cache-control'), 'no-store')
    assert.equal(login.headers.get('pragma'), 'no-cache')
    assert.notEqual((await fetch(`${base}/api/health`)).headers.get('cache-control'), 'no-store')
  } finally { close() }
})

test('CORS still works for the frontend origin after adding the headers (preflight with Authorization header)', async () => {
  const { base, close } = await serve(buildApp())
  try {
    const pre = await fetch(`${base}/api/auth/login`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    })
    assert.equal(pre.status, 204)
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    assert.match(pre.headers.get('access-control-allow-headers').toLowerCase(), /authorization/)

    const real = await fetch(`${base}/api/health`, { headers: { Origin: 'http://localhost:5173' } })
    assert.equal(real.headers.get('access-control-allow-origin'), 'http://localhost:5173')
    assert.deepEqual(await real.json(), { ok: true })

    const other = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } })
    assert.notEqual(other.headers.get('access-control-allow-origin'), 'https://evil.example')
  } finally { close() }
})

test('TRUST_PROXY: unset = ignore X-Forwarded-For; a hop count trusts it; `true` is refused', async () => {
  assert.equal(parseTrustProxy(undefined), false)
  assert.equal(parseTrustProxy(''), false)
  assert.equal(parseTrustProxy('false'), false)
  assert.equal(parseTrustProxy('1'), 1)
  assert.equal(parseTrustProxy('loopback'), 'loopback')
  assert.throws(() => parseTrustProxy('true'), /not allowed/)

  const without = await serve(buildApp())
  const withProxy = await serve(buildApp({ TRUST_PROXY: '1' }))
  try {
    const spoof = { headers: { 'X-Forwarded-For': '203.0.113.7' } }
    assert.notEqual((await (await fetch(`${without.base}/api/ip`, spoof)).json()).ip, '203.0.113.7')
    assert.equal((await (await fetch(`${withProxy.base}/api/ip`, spoof)).json()).ip, '203.0.113.7')
  } finally { without.close(); withProxy.close() }
})

test('unknown API routes give a JSON 404; unexpected errors give a generic 500 without stack, paths or secrets', async () => {
  const { base, close } = await serve(buildApp())
  try {
    const missing = await fetch(`${base}/api/nope`)
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), { message: 'Not found' })

    const boom = await fetch(`${base}/api/boom`)
    const text = await boom.text()
    assert.equal(boom.status, 500)
    assert.deepEqual(JSON.parse(text), { message: 'Something went wrong' })
    assert.ok(!/hunter2|db\.js|at \w+|stack/i.test(text))

    const bad = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' })
    assert.equal(bad.status, 400)
    assert.deepEqual(await bad.json(), { message: 'Invalid request body' })

    const big = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a'.repeat(200_000) }) })
    assert.equal(big.status, 413)
    assert.deepEqual(await big.json(), { message: 'Request body is too large' })
  } finally { close() }
})

test('checkAuthConfig: weak secrets, bad durations, TRUST_PROXY=true and in-memory rate limits in production', () => {
  const strong = 'x'.repeat(48)
  const dev = checkAuthConfig({ JWT_ACCESS_SECRET: 'short', JWT_REFRESH_SECRET: strong })
  assert.deepEqual(dev.errors, [])
  assert.equal(dev.warnings.length, 1) // weak secret is only a warning outside production

  const prod = checkAuthConfig({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'short', JWT_REFRESH_SECRET: strong })
  assert.ok(prod.errors.some((e) => e.includes('JWT_ACCESS_SECRET')))
  assert.ok(prod.warnings.some((w) => w.includes('REDIS_URL')))

  const strict = checkAuthConfig({ NODE_ENV: 'production', JWT_ACCESS_SECRET: strong, JWT_REFRESH_SECRET: strong, RATE_LIMIT_REQUIRE_REDIS: 'true' })
  assert.ok(strict.errors.some((e) => e.includes('REDIS_URL')))

  const redis = checkAuthConfig({ NODE_ENV: 'production', JWT_ACCESS_SECRET: strong, JWT_REFRESH_SECRET: strong, REDIS_URL: 'redis://localhost:6379' })
  assert.deepEqual(redis, { errors: [], warnings: [] })

  const bad = checkAuthConfig({ JWT_ACCESS_SECRET: strong, JWT_REFRESH_SECRET: strong, JWT_ACCESS_EXPIRES_IN: 'soon', JWT_REFRESH_EXPIRES_IN: '7d', TRUST_PROXY: 'true' })
  assert.equal(bad.errors.length, 2)
})
