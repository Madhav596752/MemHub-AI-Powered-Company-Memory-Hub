// Rate-limit behaviour through the REAL auth router and the REAL /api/ask router (in-memory store).
// Limits are set very low through the same environment variables that configure production.
// ask.js is reached with an empty body, so no vector service / LLM is needed: the request is answered
// with 400 by the handler, and the limiter (which sits in front of the handler) still counts it.
// The Redis-backed store is tested in rateLimit.redis.test.js (needs REDIS_URL).
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import jwt from 'jsonwebtoken'

process.env.JWT_ACCESS_SECRET = 'unit-test-access-secret-0123456789abcdef'
process.env.JWT_REFRESH_SECRET = 'unit-test-refresh-secret-0123456789abcdef'
delete process.env.REDIS_URL
delete process.env.TRUST_PROXY
Object.assign(process.env, {
  RATE_LIMIT_REGISTER_MAX: '2',
  RATE_LIMIT_LOGIN_MAX: '6',
  RATE_LIMIT_LOGIN_ACCOUNT_MAX: '2',
  RATE_LIMIT_REFRESH_MAX: '3',
  RATE_LIMIT_ASK_MAX: '2',
})

const COMPANY = '00000000-0000-4000-8000-000000000001'
const bcrypt = (await import('bcrypt')).default
const users = [{ id: '00000000-0000-4000-8000-000000000011', companyId: COMPANY, role: 'MEMBER', name: 'Alice', email: 'alice@example.test', password: await bcrypt.hash('correct horse battery', 4) }]
const fakePrisma = {
  user: { findUnique: async ({ where, include }) => { const u = users.find((x) => x.email === where.email || x.id === where.id); return u ? { ...u, ...(include?.company ? { company: { id: COMPANY, name: 'Globex' } } : {}) } : null } },
  company: { findUnique: async () => null },
  refreshToken: { create: async (a) => a.data, findUnique: async () => null, updateMany: async () => ({ count: 0 }) },
  document: { findMany: async () => [] },
  $transaction: async (fn) => fn(fakePrisma),
}
mock.module('../prisma.js', { defaultExport: fakePrisma })

const { default: express } = await import('express')
const { default: authRouter } = await import('../routes/auth.js')
const { default: askRouter } = await import('../routes/ask.js')
const { rateLimitStoreKind } = await import('./rateLimit.js')

const app = express()
app.use(express.json())
app.use('/api/auth', authRouter)
app.use('/api/ask', askRouter)
const server = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)) })
const BASE = `http://127.0.0.1:${server.address().port}`
test.after(() => server.close())

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, body: JSON.parse(text), headers: res.headers, text }
}
const accessFor = (userId) => jwt.sign({ userId, companyId: COMPANY, role: 'MEMBER' }, process.env.JWT_ACCESS_SECRET, { expiresIn: '10m' })
const LOGIN = (email, password) => post('/api/auth/login', { email, password })

test('without REDIS_URL the in-memory store is used (single-instance only)', () => {
  assert.equal(rateLimitStoreKind(), 'memory')
})

test('registration: requests over the limit get 429 + Retry-After + a generic JSON message', async () => {
  assert.equal((await post('/api/auth/register', {})).status, 400)
  assert.equal((await post('/api/auth/register', {})).status, 400)
  const blocked = await post('/api/auth/register', { name: 'x', email: 'x@example.test', password: 'a-fine-password', companyName: 'X' })
  assert.equal(blocked.status, 429)
  assert.deepEqual(blocked.body, { success: false, message: 'Too many requests. Please wait a moment and try again.' })
  assert.ok(Number(blocked.headers.get('retry-after')) > 0)
  assert.ok(blocked.headers.get('ratelimit') || blocked.headers.get('ratelimit-policy'), 'standard RateLimit headers are sent')
  assert.equal(blocked.headers.get('x-ratelimit-limit'), null, 'legacy X-RateLimit-* headers are off')
})

test('login: successful logins never use up the allowance', async () => {
  for (let i = 0; i < 8; i++) {
    const r = await LOGIN('alice@example.test', 'correct horse battery')
    assert.equal(r.status, 200, `login ${i + 1}`)
  }
})

test('login: per-account limit blocks repeated failures for ONE email, other emails are unaffected, and the blocked account cannot log in either', async () => {
  assert.equal((await LOGIN('alice@example.test', 'wrong password 1')).status, 401)
  assert.equal((await LOGIN('alice@example.test', 'wrong password 2')).status, 401)
  const blocked = await LOGIN('alice@example.test', 'wrong password 3')
  assert.equal(blocked.status, 429)
  assert.ok(Number(blocked.headers.get('retry-after')) > 0)
  // even the right password is refused while blocked (otherwise the limit would not slow guessing down)
  assert.equal((await LOGIN('alice@example.test', 'correct horse battery')).status, 429)
  // email matching is case/space-insensitive, so changing the casing does not dodge the limit
  assert.equal((await LOGIN('  ALICE@example.test ', 'wrong password 4')).status, 429)
  // a different account from the same IP is still allowed
  assert.equal((await LOGIN('bob@example.test', 'wrong password')).status, 401)
})

test('login: once the per-IP allowance of failures is used up, even a never-seen email is blocked', async () => {
  // The previous test left this IP at its maximum (6 failed hits: 2 + 3 blocked + 1). A brand-new email has a
  // fresh per-account counter, so a 429 here can only come from the per-IP limiter.
  const r = await LOGIN('never-seen-before@example.test', 'nope nope nope')
  assert.equal(r.status, 429)
  assert.ok(Number(r.headers.get('retry-after')) > 0)
  // a correct login from the same IP is refused too while the IP is blocked
  assert.equal((await LOGIN('alice@example.test', 'correct horse battery')).status, 429)
})

test('refresh endpoint is limited', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await post('/api/auth/refresh', { refreshToken: 'garbage' })).status, 401)
  const blocked = await post('/api/auth/refresh', { refreshToken: 'garbage' })
  assert.equal(blocked.status, 429)
  assert.ok(Number(blocked.headers.get('retry-after')) > 0)
})

test('logout endpoint is limited, and a spoofed X-Forwarded-For does not dodge the limit (TRUST_PROXY unset)', async () => {
  for (let i = 1; i <= 3; i++) assert.equal((await post('/api/auth/logout', { refreshToken: 'garbage' }, { 'X-Forwarded-For': `203.0.113.${i}` })).status, 200)
  const blocked = await post('/api/auth/logout', { refreshToken: 'garbage' }, { 'X-Forwarded-For': '198.51.100.99' })
  assert.equal(blocked.status, 429)
})

test('/api/ask: limited per signed-in user; other users and unauthenticated requests are not affected by it', async () => {
  const a = accessFor('user-a')
  const b = accessFor('user-b')
  const ask = (token) => post('/api/ask', {}, token ? { Authorization: `Bearer ${token}` } : {})

  assert.equal((await ask(a)).status, 400) // handler reached: "A question is required"
  assert.equal((await ask(a)).status, 400)
  const blocked = await ask(a)
  assert.equal(blocked.status, 429)
  assert.deepEqual(blocked.body, { success: false, message: 'Too many requests. Please wait a moment and try again.' })

  assert.equal((await ask(b)).status, 400, 'another user has their own allowance')
  assert.equal((await ask(null)).status, 401, 'authentication is still checked first')
})

test('the maximum is configurable at runtime through the environment', async () => {
  const a = accessFor('user-a')
  process.env.RATE_LIMIT_ASK_MAX = '10'
  try {
    const r = await post('/api/ask', {}, { Authorization: `Bearer ${a}` })
    assert.equal(r.status, 400, 'user-a was blocked at max=2, and is allowed again at max=10')
  } finally {
    process.env.RATE_LIMIT_ASK_MAX = '2'
  }
})
