import crypto from 'node:crypto'
import { rateLimit, ipKeyGenerator } from 'express-rate-limit'
import { RedisCounterStore } from './redisStore.js'

// Rate limiting for the authentication endpoints and /api/ask.
//
// STORE
//   REDIS_URL set      -> counters live in Redis, shared by every backend instance (use this in production
//                         whenever more than one instance, or a restarting process, serves traffic).
//   REDIS_URL not set  -> counters live in this process's memory. Correct for ONE instance only: with N
//                         instances the effective limit is N x the configured one, and a restart resets it.
//   If Redis is unreachable at request time the limiter FAILS OPEN (the request is allowed, the error is
//   logged) so a Redis outage cannot lock everybody out of the app.
//
// POLICY (all optional; window in seconds). Defaults in brackets:
//   RATE_LIMIT_REGISTER_WINDOW_SECONDS [3600]  RATE_LIMIT_REGISTER_MAX [10]       per IP
//   RATE_LIMIT_LOGIN_WINDOW_SECONDS    [900]   RATE_LIMIT_LOGIN_MAX    [20]       FAILED logins per IP
//   RATE_LIMIT_LOGIN_ACCOUNT_MAX       [5]     (same window)                      FAILED logins per IP + email
//   RATE_LIMIT_REFRESH_WINDOW_SECONDS  [900]   RATE_LIMIT_REFRESH_MAX  [100]      per IP (refresh and logout)
//   RATE_LIMIT_ASK_WINDOW_SECONDS      [60]    RATE_LIMIT_ASK_MAX      [20]       per signed-in user
// The window is read once at startup; the max is read on every request.
// Behind a reverse proxy set TRUST_PROXY (see middleware/security.js), otherwise every client shares the proxy's IP.

const MESSAGE = 'Too many requests. Please wait a moment and try again.'

function readInt(name, fallback, { min = 1, max = 1_000_000 } = {}) {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

const POLICIES = {
  register: { env: 'REGISTER', windowSeconds: 3600, max: 10 },
  login: { env: 'LOGIN', windowSeconds: 900, max: 20 },
  refresh: { env: 'REFRESH', windowSeconds: 900, max: 100 },
  ask: { env: 'ASK', windowSeconds: 60, max: 20 },
}

// ---------- store ----------
const redisUrl = (process.env.REDIS_URL || '').trim()
let redisClient = null

if (redisUrl) {
  const { createClient } = await import('redis')
  redisClient = createClient({
    url: redisUrl,
    // No offline queue: while Redis is unreachable a command fails at once (the limiter then fails open)
    // instead of waiting, so requests are never stalled by a Redis outage. The client reconnects by itself.
    disableOfflineQueue: true,
    socket: { connectTimeout: 2000, reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 5000) },
  })
  // Never print the URL: it may contain a password.
  redisClient.on('error', (err) => console.error('Redis (rate limiting) error:', err?.code || err?.message))
  redisClient.connect().catch((err) => console.error('Redis (rate limiting) connect failed:', err?.code || err?.message))
}

export function rateLimitStoreKind() {
  return redisClient ? 'redis' : 'memory'
}

export async function closeRateLimitStore() {
  if (redisClient?.isOpen) await redisClient.quit()
}

function makeStore(name) {
  if (!redisClient) return undefined // express-rate-limit's default MemoryStore (one per limiter)
  return new RedisCounterStore({ client: redisClient, prefix: `memhub:rl:${name}:` })
}

// ---------- factory ----------
function createLimiter({ name, policy, key, skipSuccessfulRequests = false, maxEnv, defaultMax }) {
  const p = POLICIES[policy]
  return rateLimit({
    windowMs: readInt(`RATE_LIMIT_${p.env}_WINDOW_SECONDS`, p.windowSeconds, { max: 86400 * 7 }) * 1000,
    limit: () => readInt(maxEnv || `RATE_LIMIT_${p.env}_MAX`, defaultMax ?? p.max),
    keyGenerator: key,
    skipSuccessfulRequests, // only responses with status < 400 are "successful"
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true,
    store: makeStore(name),
    handler: (req, res) => res.status(429).json({ success: false, message: MESSAGE }),
  })
}

const byIp = (req) => ipKeyGenerator(req.ip)

const byIpAndEmail = (req) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : ''
  const digest = crypto.createHash('sha256').update(email).digest('hex').slice(0, 32)
  return `${ipKeyGenerator(req.ip)}|${digest}`
}

// Used only AFTER requireAuth, so req.user is set; falls back to the IP.
const byUser = (req) => req.user?.userId || ipKeyGenerator(req.ip)

export const registerLimiter = createLimiter({ name: 'register', policy: 'register', key: byIp })

// Two layers, both counting only FAILED logins (a successful login never uses up the allowance):
//   per IP            - stops one machine from trying many accounts
//   per IP + email    - stops one machine from hammering one account
export const loginLimiter = createLimiter({ name: 'login-ip', policy: 'login', key: byIp, skipSuccessfulRequests: true })
export const loginAccountLimiter = createLimiter({
  name: 'login-account', policy: 'login', key: byIpAndEmail, skipSuccessfulRequests: true,
  maxEnv: 'RATE_LIMIT_LOGIN_ACCOUNT_MAX', defaultMax: 5,
})

export const refreshLimiter = createLimiter({ name: 'refresh', policy: 'refresh', key: byIp })
export const logoutLimiter = createLimiter({ name: 'logout', policy: 'refresh', key: byIp })
export const askLimiter = createLimiter({ name: 'ask', policy: 'ask', key: byUser })
