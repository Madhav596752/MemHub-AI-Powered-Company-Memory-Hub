// Authentication tests through the REAL Express auth router, the REAL JWT/bcrypt code and the REAL
// refresh-token service, with an in-memory stand-in for Prisma (same semantics the code relies on:
// conditional updateMany, unique ids, cascade-free). No network, no database.
//
// Covers: login success/failure, register validation, expired access tokens, expired refresh tokens,
// revoked refresh tokens, logout followed by refresh, rotation + replay detection, concurrent refresh,
// isolation between users/sessions, logout-all, and compatibility of the existing response shapes.
//
// The rate limits are set very high here; their behaviour is tested in rateLimit.test.js.
import test, { mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import jwt from 'jsonwebtoken'

process.env.JWT_ACCESS_SECRET = 'unit-test-access-secret-0123456789abcdef'
process.env.JWT_REFRESH_SECRET = 'unit-test-refresh-secret-0123456789abcdef'
process.env.JWT_ACCESS_EXPIRES_IN = '15m'
process.env.JWT_REFRESH_EXPIRES_IN = '7d'
delete process.env.REDIS_URL
for (const name of ['REGISTER', 'LOGIN', 'LOGIN_ACCOUNT', 'REFRESH']) process.env[`RATE_LIMIT_${name}_MAX`] = '100000'

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// ---------- in-memory database ----------
let users
let companies
let tokenRows
let nextId

const matches = (row, where = {}) => Object.entries(where).every(([k, v]) => row[k] === v)
const withCompany = (row, include) => (include?.company ? { ...row, company: companies.find((c) => c.id === row.companyId) } : row)

const fakePrisma = {
  user: {
    findUnique: async ({ where, include }) => {
      const row = users.find((x) => (where.id !== undefined ? x.id === where.id : x.email === where.email))
      return row ? withCompany(row, include) : null
    },
    create: async ({ data, include }) => {
      const row = { id: id(nextId++), createdAt: new Date(), ...data }
      users.push(row)
      return withCompany(row, include)
    },
  },
  company: {
    findUnique: async ({ where }) => companies.find((c) => c.id === where.id) ?? null,
    create: async ({ data }) => {
      const row = { id: id(nextId++), ...data }
      companies.push(row)
      return row
    },
  },
  refreshToken: {
    create: async ({ data }) => {
      if (tokenRows.some((r) => r.id === data.id || r.tokenHash === data.tokenHash)) throw Object.assign(new Error('unique'), { code: 'P2002' })
      const row = { createdAt: new Date(), revokedAt: null, revokeReason: null, ...data }
      tokenRows.push(row)
      return row
    },
    findUnique: async ({ where }) => tokenRows.find((r) => r.id === where.id) ?? null,
    updateMany: async ({ where, data }) => {
      const rows = tokenRows.filter((r) => matches(r, where))
      rows.forEach((r) => Object.assign(r, data))
      return { count: rows.length }
    },
    deleteMany: async ({ where }) => {
      const before = tokenRows.length
      tokenRows = tokenRows.filter((r) => !(where.expiresAt?.lt && r.expiresAt < where.expiresAt.lt))
      return { count: before - tokenRows.length }
    },
  },
  $transaction: async (arg) => arg(fakePrisma),
}
mock.module('../prisma.js', { defaultExport: fakePrisma })

const bcrypt = (await import('bcrypt')).default
const { default: express } = await import('express')
const { default: authRouter } = await import('./auth.js')
const { apiErrorHandler } = await import('../middleware/errorHandler.js')
const { purgeExpiredRefreshTokens } = await import('../utils/refreshTokens.js')

const app = express()
app.use(express.json())
app.use('/api/auth', authRouter)
app.use(apiErrorHandler)
const server = await new Promise((resolve) => {
  const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s))
})
const BASE = `http://127.0.0.1:${server.address().port}`
test.after(() => server.close())

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers }
}
const post = (path, body, headers) => call('POST', path, body, headers)
const bearer = (token) => ({ Authorization: `Bearer ${token}` })

const COMPANY = id(1)
const ALICE = id(11)
const BOB = id(12)
const PASSWORD_A = 'correct horse battery'
const PASSWORD_B = 'another long secret'

beforeEach(async () => {
  nextId = 1000
  companies = [{ id: COMPANY, name: 'Globex' }]
  tokenRows = []
  users = [
    { id: ALICE, companyId: COMPANY, role: 'ADMIN', name: 'Alice', email: 'alice@example.test', password: await bcrypt.hash(PASSWORD_A, 4), createdAt: new Date() },
    { id: BOB, companyId: COMPANY, role: 'MEMBER', name: 'Bob', email: 'bob@example.test', password: await bcrypt.hash(PASSWORD_B, 4), createdAt: new Date() },
  ]
})

const login = async (email, password) => {
  const r = await post('/api/auth/login', { email, password })
  assert.equal(r.status, 200, r.text)
  return r.body
}
const refresh = (refreshToken) => post('/api/auth/refresh', { refreshToken })
const rowFor = (token) => tokenRows.find((r) => r.id === jwt.decode(token).jti)

// =====================================================================================
// Login
// =====================================================================================
test('login success returns the SAME response shape as before (accessToken, refreshToken, user without password)', async () => {
  const r = await post('/api/auth/login', { email: ' Alice@Example.test ', password: PASSWORD_A })
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body).sort(), ['accessToken', 'refreshToken', 'user'])
  assert.deepEqual(r.body.user, { id: ALICE, name: 'Alice', email: 'alice@example.test', role: 'ADMIN', companyId: COMPANY, companyName: 'Globex' })
  assert.ok(!r.text.includes('password'))

  // access token payload is unchanged: { userId, companyId, role } + iat/exp
  const access = jwt.verify(r.body.accessToken, process.env.JWT_ACCESS_SECRET)
  assert.deepEqual({ userId: access.userId, companyId: access.companyId, role: access.role }, { userId: ALICE, companyId: COMPANY, role: 'ADMIN' })
  assert.ok(typeof access.exp === 'number')
  // refresh token is signed with the REFRESH secret and still carries userId
  const refreshClaims = jwt.verify(r.body.refreshToken, process.env.JWT_REFRESH_SECRET)
  assert.equal(refreshClaims.userId, ALICE)
  assert.throws(() => jwt.verify(r.body.refreshToken, process.env.JWT_ACCESS_SECRET))
})

test('login failure: wrong password and unknown email give the same 401 and message', async () => {
  const wrong = await post('/api/auth/login', { email: 'alice@example.test', password: 'not the password' })
  const unknown = await post('/api/auth/login', { email: 'nobody@example.test', password: 'whatever long enough' })
  assert.equal(wrong.status, 401)
  assert.equal(unknown.status, 401)
  assert.deepEqual(wrong.body, { message: 'Invalid email or password' })
  assert.deepEqual(unknown.body, wrong.body)
  assert.equal(tokenRows.length, 0, 'a failed login must not create a session')
})

test('login validation: missing, non-string and oversized input is rejected without touching the database', async () => {
  for (const body of [undefined, {}, { email: 'a@b.co' }, { password: 'x' }, { email: 123, password: 'x' }, { email: ['a@b.co'], password: 'x' }, { email: 'a@b.co', password: { $ne: 1 } }]) {
    const r = await post('/api/auth/login', body)
    assert.equal(r.status, 400, JSON.stringify(body))
  }
  const huge = await post('/api/auth/login', { email: 'alice@example.test', password: 'a'.repeat(5000) })
  assert.equal(huge.status, 400)
  assert.equal(tokenRows.length, 0)
})

test('malformed JSON gives a generic 400 and never leaks internals', async () => {
  const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"email": ' })
  const text = await res.text()
  assert.equal(res.status, 400)
  assert.deepEqual(JSON.parse(text), { message: 'Invalid request body' })
  assert.ok(!/at |node_modules|SyntaxError|stack/i.test(text))
})

// =====================================================================================
// Register
// =====================================================================================
test('register creates a company admin (role from the client is ignored) and a tracked session', async () => {
  const r = await post('/api/auth/register', { name: 'Cara', email: 'cara@example.test', password: 'a-fine-password', companyName: 'Initech', role: 'ADMIN' })
  assert.equal(r.status, 201)
  assert.deepEqual(Object.keys(r.body).sort(), ['accessToken', 'refreshToken', 'user'])
  assert.equal(r.body.user.role, 'ADMIN') // new company -> admin, by the server's rule
  assert.ok(rowFor(r.body.refreshToken), 'the new session is stored')

  const joined = await post('/api/auth/register', { name: 'Dan', email: 'dan@example.test', password: 'a-fine-password', inviteCode: COMPANY, role: 'ADMIN' })
  assert.equal(joined.status, 201)
  assert.equal(joined.body.user.role, 'MEMBER') // client-sent role ignored
})

test('register password rules: length, bytes, whitespace, common and email-as-password', async () => {
  const base = { name: 'Eve', companyName: 'Initech' }
  const cases = [
    ['short1', 'eve1@example.test'],
    ['        ', 'eve2@example.test'],
    ['password123', 'eve3@example.test'],
    ['Password', 'eve4@example.test'],
    ['é'.repeat(40), 'eve5@example.test'], // 40 chars but 80 bytes: bcrypt would silently truncate
    ['x'.repeat(73), 'eve6@example.test'],
    ['eve7@example.test', 'eve7@example.test'],
  ]
  for (const [password, email] of cases) {
    const r = await post('/api/auth/register', { ...base, email, password })
    assert.equal(r.status, 400, `${password.slice(0, 12)} should be rejected`)
  }
  const nonString = await post('/api/auth/register', { ...base, email: 'eve8@example.test', password: 12345678 })
  assert.equal(nonString.status, 400)
  // 72 ASCII characters = 72 bytes is still fine
  const ok = await post('/api/auth/register', { ...base, email: 'eve9@example.test', password: 'k7#'.repeat(24) })
  assert.equal(ok.status, 201)
})

test('register: duplicate email is 409', async () => {
  const r = await post('/api/auth/register', { name: 'Alice 2', email: 'ALICE@example.test', password: 'a-fine-password', companyName: 'X' })
  assert.equal(r.status, 409)
})

// =====================================================================================
// Access tokens
// =====================================================================================
test('GET /me works with a fresh access token', async () => {
  const { accessToken } = await login('alice@example.test', PASSWORD_A)
  const r = await call('GET', '/api/auth/me', undefined, bearer(accessToken))
  assert.equal(r.status, 200)
  assert.equal(r.body.email, 'alice@example.test')
})

test('expired, tampered, wrong-secret and alg=none access tokens are rejected with the same generic 401', async () => {
  const claims = { userId: ALICE, companyId: COMPANY, role: 'ADMIN' }
  const expired = jwt.sign(claims, process.env.JWT_ACCESS_SECRET, { expiresIn: -10 })
  const wrongSecret = jwt.sign(claims, 'some-other-secret', { expiresIn: '5m' })
  const refreshAsAccess = jwt.sign({ userId: ALICE }, process.env.JWT_REFRESH_SECRET, { expiresIn: '5m' })
  const valid = jwt.sign(claims, process.env.JWT_ACCESS_SECRET, { expiresIn: '5m' })
  const tampered = valid.slice(0, -3) + (valid.endsWith('AAA') ? 'BBB' : 'AAA')
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`

  for (const token of [expired, wrongSecret, refreshAsAccess, tampered, none]) {
    const r = await call('GET', '/api/auth/me', undefined, bearer(token))
    assert.equal(r.status, 401)
    assert.deepEqual(r.body, { success: false, message: 'Invalid or expired token' })
  }
  assert.equal((await call('GET', '/api/auth/me')).status, 401)
})

// =====================================================================================
// Refresh: rotation, expiry, revocation, replay
// =====================================================================================
test('refresh returns a new access token AND a new refresh token; the stored value is a hash, never the token', async () => {
  const first = await login('alice@example.test', PASSWORD_A)
  const r = await refresh(first.refreshToken)
  assert.equal(r.status, 200)
  assert.deepEqual(Object.keys(r.body).sort(), ['accessToken', 'refreshToken'])
  assert.notEqual(r.body.refreshToken, first.refreshToken)
  const access = jwt.verify(r.body.accessToken, process.env.JWT_ACCESS_SECRET)
  assert.equal(access.userId, ALICE)
  assert.equal(access.role, 'ADMIN')

  // no plaintext refresh token anywhere in the database
  const dump = JSON.stringify(tokenRows)
  assert.ok(!dump.includes(first.refreshToken) && !dump.includes(r.body.refreshToken))
  for (const row of tokenRows) assert.match(row.tokenHash, /^[0-9a-f]{64}$/)

  // the new refresh token keeps working (chain of rotations), and keeps the original absolute expiry
  const again = await refresh(r.body.refreshToken)
  assert.equal(again.status, 200)
  assert.equal(jwt.decode(again.body.refreshToken).exp, jwt.decode(first.refreshToken).exp)
  assert.equal(new Set(tokenRows.map((x) => x.familyId)).size, 1, 'all rotations belong to one session')
})

test('refresh picks up a changed role (role is read fresh from the database)', async () => {
  const first = await login('bob@example.test', PASSWORD_B)
  users.find((u) => u.id === BOB).role = 'ADMIN'
  const r = await refresh(first.refreshToken)
  assert.equal(jwt.decode(r.body.accessToken).role, 'ADMIN')
})

test('refresh validation: missing/non-string token -> 400, garbage/oversized/other-secret token -> 401', async () => {
  for (const body of [undefined, {}, { refreshToken: 5 }, { refreshToken: '' }, { refreshToken: { a: 1 } }]) {
    assert.equal((await post('/api/auth/refresh', body)).status, 400)
  }
  const accessToken = jwt.sign({ userId: ALICE, jti: id(1), fam: id(2) }, process.env.JWT_ACCESS_SECRET, { expiresIn: '5m' })
  for (const token of ['not-a-jwt', 'a'.repeat(5000), accessToken]) {
    const r = await refresh(token)
    assert.equal(r.status, 401)
    assert.deepEqual(r.body, { message: 'Invalid or expired refresh token' })
  }
})

test('an expired refresh token (JWT exp in the past) is rejected', async () => {
  const { refreshToken } = await login('alice@example.test', PASSWORD_A)
  const row = rowFor(refreshToken)
  const expired = jwt.sign({ userId: ALICE, jti: row.id, fam: row.familyId, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_REFRESH_SECRET)
  const r = await refresh(expired)
  assert.equal(r.status, 401)
  assert.deepEqual(r.body, { message: 'Invalid or expired refresh token' })
})

test('a refresh token whose DATABASE row has expired is rejected even if the JWT itself still verifies', async () => {
  const { refreshToken } = await login('alice@example.test', PASSWORD_A)
  rowFor(refreshToken).expiresAt = new Date(Date.now() - 1000)
  assert.equal((await refresh(refreshToken)).status, 401)
})

test('legacy refresh tokens (issued before sessions existed: no jti/fam) are rejected', async () => {
  const legacy = jwt.sign({ userId: ALICE }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' })
  const r = await refresh(legacy)
  assert.equal(r.status, 401)
  assert.equal(tokenRows.length, 0)
})

test('a validly signed refresh token that has no database row is rejected (unknown session)', async () => {
  const forged = jwt.sign({ userId: ALICE, jti: id(77), fam: id(78) }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' })
  assert.equal((await refresh(forged)).status, 401)
})

test('a token with the right ids but a different signature payload (hash mismatch) is rejected', async () => {
  const { refreshToken } = await login('alice@example.test', PASSWORD_A)
  const row = rowFor(refreshToken)
  // same jti/fam/exp but signed again later => different token string => different hash
  const sibling = jwt.sign({ userId: ALICE, jti: row.id, fam: row.familyId, exp: jwt.decode(refreshToken).exp, extra: 1 }, process.env.JWT_REFRESH_SECRET)
  assert.equal((await refresh(sibling)).status, 401)
  assert.equal((await refresh(refreshToken)).status, 200, 'the genuine token is unaffected')
})

test('replay of a rotated token right after rotation is rejected but does NOT kill the session (benign race)', async () => {
  const first = await login('alice@example.test', PASSWORD_A)
  const second = await refresh(first.refreshToken)
  assert.equal(second.status, 200)

  const replay = await refresh(first.refreshToken)
  assert.equal(replay.status, 401)
  assert.equal((await refresh(second.body.refreshToken)).status, 200, 'the legitimate newest token still works')
})

test('replay of a rotated token AFTER the grace period revokes the whole session (theft detected)', async () => {
  const first = await login('alice@example.test', PASSWORD_A)
  const second = await refresh(first.refreshToken)
  const third = await refresh(second.body.refreshToken)
  assert.equal(third.status, 200)

  // pretend the first token was rotated a minute ago
  rowFor(first.refreshToken).revokedAt = new Date(Date.now() - 60_000)
  const replay = await refresh(first.refreshToken)
  assert.equal(replay.status, 401)

  // the attacker's replay also signed the legitimate holder out of THAT session
  assert.equal((await refresh(third.body.refreshToken)).status, 401)
  assert.ok(tokenRows.every((r) => r.revokedAt), 'every token of the session is revoked')
  assert.ok(tokenRows.some((r) => r.revokeReason === 'reuse-detected'))
})

test('two simultaneous refreshes with the same token: exactly one wins, the session survives', async () => {
  const { refreshToken } = await login('alice@example.test', PASSWORD_A)
  const results = await Promise.all([refresh(refreshToken), refresh(refreshToken), refresh(refreshToken)])
  const statuses = results.map((r) => r.status).sort()
  assert.deepEqual(statuses, [200, 401, 401])
  const winner = results.find((r) => r.status === 200)
  assert.equal((await refresh(winner.body.refreshToken)).status, 200)
  assert.equal(tokenRows.filter((r) => !r.revokedAt).length, 1, 'only one live token per session')
})

test('refresh for a user that no longer exists is rejected', async () => {
  const { refreshToken } = await login('bob@example.test', PASSWORD_B)
  users = users.filter((u) => u.id !== BOB)
  assert.equal((await refresh(refreshToken)).status, 401)
})

// =====================================================================================
// Logout
// =====================================================================================
test('logout revokes the session; refresh afterwards fails (revoked refresh token)', async () => {
  const { refreshToken } = await login('alice@example.test', PASSWORD_A)
  const out = await post('/api/auth/logout', { refreshToken })
  assert.equal(out.status, 200)
  assert.deepEqual(out.body, { success: true })

  const r = await refresh(refreshToken)
  assert.equal(r.status, 401)
  assert.deepEqual(r.body, { message: 'Invalid or expired refresh token' })
})

test('logout after rotation also kills the NEWEST token of that session', async () => {
  const first = await login('alice@example.test', PASSWORD_A)
  const second = await refresh(first.refreshToken)
  assert.equal((await post('/api/auth/logout', { refreshToken: second.body.refreshToken })).status, 200)
  assert.equal((await refresh(second.body.refreshToken)).status, 401)
  assert.equal((await refresh(first.refreshToken)).status, 401)
  // and logging out with an OLD (already rotated) token of the session works too
  const a = await login('alice@example.test', PASSWORD_A)
  const b = await refresh(a.refreshToken)
  await post('/api/auth/logout', { refreshToken: a.refreshToken })
  assert.equal((await refresh(b.body.refreshToken)).status, 401)
})

test('logout works without an access token, is idempotent, and never errors for unknown or expired tokens', async () => {
  const { refreshToken } = await login('alice@example.test', PASSWORD_A)
  assert.equal((await post('/api/auth/logout', { refreshToken })).status, 200)
  assert.equal((await post('/api/auth/logout', { refreshToken })).status, 200)
  assert.equal((await post('/api/auth/logout', { refreshToken: 'garbage' })).status, 200)
  assert.equal((await post('/api/auth/logout', { refreshToken: 'a'.repeat(5000) })).status, 200)
  assert.equal((await post('/api/auth/logout', {})).status, 400)
  assert.equal((await post('/api/auth/logout', { refreshToken: 42 })).status, 400)

  // an expired token still revokes its session
  const fresh = await login('alice@example.test', PASSWORD_A)
  const row = rowFor(fresh.refreshToken)
  const expired = jwt.sign({ userId: ALICE, jti: row.id, fam: row.familyId, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_REFRESH_SECRET)
  assert.equal((await post('/api/auth/logout', { refreshToken: expired })).status, 200)
  assert.equal((await refresh(fresh.refreshToken)).status, 401)
})

test('logout only revokes ITS session: the same user\'s other devices and other users keep working', async () => {
  const aliceLaptop = await login('alice@example.test', PASSWORD_A)
  const alicePhone = await login('alice@example.test', PASSWORD_A)
  const bob = await login('bob@example.test', PASSWORD_B)

  assert.equal((await post('/api/auth/logout', { refreshToken: aliceLaptop.refreshToken })).status, 200)

  assert.equal((await refresh(aliceLaptop.refreshToken)).status, 401)
  assert.equal((await refresh(alicePhone.refreshToken)).status, 200)
  assert.equal((await refresh(bob.refreshToken)).status, 200)
})

test('a token of user A cannot be used to log out user B (the session id is bound to the user id)', async () => {
  const alice = await login('alice@example.test', PASSWORD_A)
  const bob = await login('bob@example.test', PASSWORD_B)
  const bobRow = rowFor(bob.refreshToken)
  // a token signed by us for Alice but claiming Bob's session id
  const crossed = jwt.sign({ userId: ALICE, jti: id(5), fam: bobRow.familyId }, process.env.JWT_REFRESH_SECRET, { expiresIn: '1h' })
  await post('/api/auth/logout', { refreshToken: crossed })
  assert.equal((await refresh(bob.refreshToken)).status, 200)
  assert.equal((await refresh(alice.refreshToken)).status, 200)
})

test('logout-all signs out every session of the caller and nobody else', async () => {
  const a1 = await login('alice@example.test', PASSWORD_A)
  const a2 = await login('alice@example.test', PASSWORD_A)
  const bob = await login('bob@example.test', PASSWORD_B)

  assert.equal((await post('/api/auth/logout-all', {})).status, 401, 'needs an access token')
  assert.equal((await post('/api/auth/logout-all', {}, bearer(a1.accessToken))).status, 200)

  assert.equal((await refresh(a1.refreshToken)).status, 401)
  assert.equal((await refresh(a2.refreshToken)).status, 401)
  assert.equal((await refresh(bob.refreshToken)).status, 200)
})

test('the access token issued before logout keeps working until it expires (documented limitation of stateless access tokens)', async () => {
  const { accessToken, refreshToken } = await login('alice@example.test', PASSWORD_A)
  await post('/api/auth/logout', { refreshToken })
  assert.equal((await call('GET', '/api/auth/me', undefined, bearer(accessToken))).status, 200)
  assert.equal((await refresh(refreshToken)).status, 401)
})

// =====================================================================================
// Housekeeping + error handling
// =====================================================================================
test('purge removes only expired refresh-token rows', async () => {
  const a = await login('alice@example.test', PASSWORD_A)
  const b = await login('bob@example.test', PASSWORD_B)
  rowFor(a.refreshToken).expiresAt = new Date(Date.now() - 1000)
  assert.equal(await purgeExpiredRefreshTokens(), 1)
  assert.equal(tokenRows.length, 1)
  assert.equal(tokenRows[0].id, jwt.decode(b.refreshToken).jti)
})

test('a database failure gives a generic 500 with no internals', async () => {
  const original = fakePrisma.user.findUnique
  fakePrisma.user.findUnique = async () => { throw new Error('connection to db.internal:5432 failed: password=hunter2') }
  try {
    const r = await post('/api/auth/login', { email: 'alice@example.test', password: PASSWORD_A })
    assert.equal(r.status, 500)
    assert.deepEqual(r.body, { message: 'Something went wrong' })
    assert.ok(!/hunter2|db\.internal|stack/i.test(r.text))
  } finally {
    fakePrisma.user.findUnique = original
  }
})
