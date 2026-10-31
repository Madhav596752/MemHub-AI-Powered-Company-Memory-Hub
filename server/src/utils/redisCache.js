// Redis cache service (Phase 9, Module 9.1): a small, reusable connection + JSON get/set layer.
//
// Configuration comes from the environment only (all optional):
//   REDIS_URL               redis://[:password@]host:port  (or rediss:// for TLS). Not set -> caching is OFF.
//   REDIS_CONNECT_TIMEOUT   milliseconds to wait for a connection attempt (default 2000, 100-60000).
//                           Also the longest any single cache command (GET / SET / PING) may take.
//   REDIS_CACHE_TTL         default lifetime of a cached value in SECONDS (default 300, 1 - 2592000).
//
// Redis is an optimisation, never a dependency. Every function here NEVER throws and never waits longer than
// REDIS_CONNECT_TIMEOUT: when Redis is not configured, down, slow or returns garbage, cacheGet() answers
// "miss" (null) and cacheSet() answers false, so callers simply do the real work. The client reconnects by
// itself (exponential backoff, max 5 s) and caching resumes as soon as Redis is back.
//
// This module has its own connection. The rate limiter (middleware/rateLimit.js) keeps its own, so a problem
// on one side can never affect the other.
//
// Logging: the URL is never written to the log (it may contain a password) and repeated identical errors
// (one per reconnect attempt) are logged once, then at most once per minute, until the connection is ready again.
//
// Multi-tenancy: this layer does not know about companies. Callers MUST put the companyId in every key; use
// cacheKey(companyId, ...) so parts can never collide or be confused with each other.
//
// Module 9.2 adds two small "token" helpers (cacheGetOrCreateToken / cacheRotateToken). A token is an opaque
// random string stored WITHOUT an expiry. They exist so a caller can invalidate a whole family of cached values
// at once (put the token in the keys, rotate it, and every old key becomes unreachable and expires by itself).

import { randomUUID } from 'node:crypto'

const KEY_PREFIX = 'memhub:cache:'
const MAX_KEY_LENGTH = 512
const DEFAULT_CONNECT_TIMEOUT_MS = 2000
const DEFAULT_TTL_SECONDS = 300
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60

const env = (name) => (process.env[name] || '').trim()

function readInt(raw, fallback, { min, max }) {
  const value = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

export const connectTimeoutMs = () => readInt(env('REDIS_CONNECT_TIMEOUT'), DEFAULT_CONNECT_TIMEOUT_MS, { min: 100, max: 60_000 })
export const defaultTtlSeconds = () => readInt(env('REDIS_CACHE_TTL'), DEFAULT_TTL_SECONDS, { min: 1, max: MAX_TTL_SECONDS })

export function isRedisConfigured() {
  return Boolean(env('REDIS_URL'))
}

// ---------- state ----------
let client = null
let initPromise = null
let clientFactory = null // tests only

// Each distinct message is logged once, then again at most once per LOG_REPEAT_MS, and the memory is cleared whenever
// the connection becomes ready (so the NEXT outage is logged again). A plain "same as the previous line" check is not
// enough: during an outage the client alternates 'error' and 'reconnecting' on every retry, which would log two lines
// per attempt for as long as Redis is down.
const LOG_REPEAT_MS = 60_000
const MAX_LOGGED_IDS = 100
const logged = new Map() // id -> time it was last logged

function logOnce(id, level, ...args) {
  const now = Date.now()
  const last = logged.get(id)
  if (last !== undefined && now - last < LOG_REPEAT_MS) return
  if (logged.size >= MAX_LOGGED_IDS) logged.clear() // ids can contain error text: never let the map grow without bound
  logged.set(id, now)
  console[level](...args)
}

const readyClient = () => (client && client.isReady ? client : null)

// { configured, status: 'disabled' | 'ok' | 'unavailable' }  (same shape as checkNeo4jHealth). Instant, never throws.
export function getRedisStatus() {
  if (!isRedisConfigured()) return { configured: false, status: 'disabled' }
  return { configured: true, status: readyClient() ? 'ok' : 'unavailable' }
}

// Rejects after `ms`. The original promise gets a no-op catch so that a failure arriving AFTER the timeout
// does not turn into an unhandled rejection (which would crash the process). The timer is deliberately NOT
// unref'd: it is short, always cleared, and an awaiting caller must get its answer even when nothing else
// keeps the process alive.
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Redis command timed out')), ms)
  })
  promise.catch(() => {})
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function describe(err) {
  return err?.code || err?.message || 'unknown error'
}

// ---------- connection ----------
async function start() {
  const timeoutMs = connectTimeoutMs()
  const options = {
    url: env('REDIS_URL'),
    // No offline queue: while Redis is unreachable a command fails at once instead of waiting, so a Redis
    // outage can never stall a request. The client keeps reconnecting in the background.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: timeoutMs,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 5000),
    },
  }

  let created
  try {
    created = clientFactory ? clientFactory(options) : (await import('redis')).createClient(options)
  } catch (err) {
    // e.g. a malformed REDIS_URL, or the package is missing. Caching stays off, the app keeps running.
    console.error('Redis cache setup failed:', err?.code || err?.name || 'unknown error')
    return
  }

  // An 'error' event with no listener would crash the process, so this handler is mandatory.
  created.on('error', (err) => logOnce(`error:${describe(err)}`, 'error', 'Redis cache error:', describe(err)))
  created.on('ready', () => {
    logged.clear()
    console.log('Redis cache connected')
  })
  created.on('reconnecting', () => logOnce('reconnecting', 'warn', 'Redis cache connection lost, reconnecting...'))
  client = created

  // connect() only settles once the connection is ready; while Redis is down it keeps retrying in the
  // background. So wait for it, but never longer than the connect timeout (plus a little slack).
  const connecting = created.connect().catch((err) => logOnce(`connect:${describe(err)}`, 'error', 'Redis cache connect failed:', describe(err)))
  let timer
  const giveUp = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs + 250)
  })
  await Promise.race([connecting, giveUp])
  clearTimeout(timer)
}

// Starts the connection (once). Never rejects and never takes longer than ~REDIS_CONNECT_TIMEOUT: resolves
// with the current status, which may be 'unavailable' while the client keeps retrying in the background.
export function initRedisCache() {
  if (!isRedisConfigured()) return Promise.resolve(getRedisStatus())
  if (!initPromise) {
    initPromise = start().catch((err) => console.error('Redis cache setup failed:', describe(err))).then(getRedisStatus)
  }
  return initPromise
}

export async function closeRedisCache() {
  const current = client
  client = null
  initPromise = null
  logged.clear()
  if (!current) return
  try {
    if (current.isOpen) await withTimeout(current.quit(), connectTimeoutMs())
  } catch {
    try { current.disconnect?.() } catch { /* already closed */ }
  }
}

// Like getRedisStatus(), but also PINGs a connected client, so a half-dead connection is reported as
// 'unavailable'. Never throws.
export async function checkRedisHealth() {
  const status = getRedisStatus()
  if (status.status !== 'ok') return status
  try {
    await withTimeout(client.ping(), connectTimeoutMs())
    return status
  } catch (err) {
    logOnce(`health:${describe(err)}`, 'error', 'Redis health check failed:', describe(err))
    return { configured: true, status: 'unavailable' }
  }
}

// ---------- keys ----------
// cacheKey(companyId, 'ask', questionHash) -> 'company-1:ask:3f2a...'. Each part is URL-encoded, so a part
// containing ':' cannot be mistaken for two parts. An empty part is a programming error and throws, so a
// missing companyId can never silently produce a key shared by every tenant.
export function cacheKey(...parts) {
  if (!parts.length || parts.some((p) => p === undefined || p === null || String(p) === '')) {
    throw new TypeError('cacheKey() needs one or more non-empty parts (include the companyId)')
  }
  return parts.map((p) => encodeURIComponent(String(p))).join(':')
}

function fullKey(key) {
  if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH) return null
  return `${KEY_PREFIX}${key}`
}

// ---------- JSON get / set ----------
// cacheGet(key) -> the cached value, or null on a miss, when Redis is unavailable, or when the stored text
// is not valid JSON. (null cannot be told apart from a miss, which is why null is never stored.)
export async function cacheGet(key) {
  const c = readyClient()
  const k = fullKey(key)
  if (!c || !k) return null
  try {
    const raw = await withTimeout(c.get(k), connectTimeoutMs())
    return raw === null || raw === undefined ? null : JSON.parse(raw)
  } catch (err) {
    logOnce(`get:${describe(err)}`, 'error', 'Redis cache read failed:', describe(err))
    return null
  }
}

// cacheSet(key, value, { ttlSeconds }) -> true when stored, false when not (Redis unavailable, value not
// JSON-serialisable, or value undefined/null). ttlSeconds defaults to REDIS_CACHE_TTL.
export async function cacheSet(key, value, { ttlSeconds } = {}) {
  const c = readyClient()
  const k = fullKey(key)
  if (!c || !k || value === undefined || value === null) return false

  let json
  try {
    json = JSON.stringify(value) // throws on circular structures and BigInt
  } catch {
    return false
  }
  if (typeof json !== 'string') return false // e.g. a function

  const ttl = Number.isInteger(ttlSeconds) && ttlSeconds >= 1 && ttlSeconds <= MAX_TTL_SECONDS ? ttlSeconds : defaultTtlSeconds()
  try {
    // A raw "SET key value EX ttl" keeps the expiry independent of how a given client version spells the
    // SET options: a value without a TTL must never be written by accident.
    const reply = await withTimeout(c.sendCommand(['SET', k, json, 'EX', String(ttl)]), connectTimeoutMs())
    return reply === 'OK'
  } catch (err) {
    logOnce(`set:${describe(err)}`, 'error', 'Redis cache write failed:', describe(err))
    return false
  }
}

// ---------- tokens (for bulk invalidation) ----------
// cacheGetOrCreateToken(key) -> the token stored at `key`, creating a random one first if there is none yet.
// Returns null when Redis is unavailable (so the caller must treat it as "do not use the cache"). A token that
// disappears (eviction, FLUSHALL) is replaced by a NEW random value, never by a value seen before, so keys built
// from an older token can never become reachable again. SET ... NX makes concurrent creators agree on one value.
export async function cacheGetOrCreateToken(key) {
  const c = readyClient()
  const k = fullKey(key)
  if (!c || !k) return null
  try {
    const existing = await withTimeout(c.get(k), connectTimeoutMs())
    if (typeof existing === 'string' && existing) return existing
    await withTimeout(c.sendCommand(['SET', k, randomUUID(), 'NX']), connectTimeoutMs())
    const settled = await withTimeout(c.get(k), connectTimeoutMs())
    return typeof settled === 'string' && settled ? settled : null
  } catch (err) {
    logOnce(`token-get:${describe(err)}`, 'error', 'Redis cache token read failed:', describe(err))
    return null
  }
}

// cacheRotateToken(key) -> true when a fresh random token was stored (everything keyed by the old one is now
// unreachable), false when Redis is unavailable. Never throws.
export async function cacheRotateToken(key) {
  const c = readyClient()
  const k = fullKey(key)
  if (!c || !k) return false
  try {
    const reply = await withTimeout(c.sendCommand(['SET', k, randomUUID()]), connectTimeoutMs())
    return reply === 'OK'
  } catch (err) {
    logOnce(`token-set:${describe(err)}`, 'error', 'Redis cache token write failed:', describe(err))
    return false
  }
}

// Tests only: replace the Redis client factory (pass null to restore). Call closeRedisCache() to reset state.
export function setRedisClientFactoryForTests(factory) {
  clientFactory = factory
}
