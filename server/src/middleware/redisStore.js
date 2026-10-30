// Minimal Redis-backed store for express-rate-limit (fixed window counter).
//
// Why not the `rate-limit-redis` package: it caches the result of a SCRIPT LOAD made at startup; if Redis is
// unreachable at that moment the cached rejection is never retried, so rate limiting would stay switched off
// until the process restarts, even after Redis is back. This store keeps no state besides the connection:
// every call is one atomic EVAL, so it recovers by itself as soon as Redis is reachable again.

// Atomic: count the hit, make sure the key always has an expiry (also heals a key that lost its TTL),
// and return { hits, remaining ttl in ms }.
const INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { hits, ttl }
`

// Never create a negative counter for a key that already expired.
const DECREMENT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('DECR', KEYS[1])
end
return 0
`

export class RedisCounterStore {
  localKeys = false // counters are shared between processes

  constructor({ client, prefix }) {
    this.client = client
    this.prefix = prefix
    this.windowMs = 60_000
  }

  init(options) {
    this.windowMs = options.windowMs
  }

  key(key) {
    return `${this.prefix}${key}`
  }

  async increment(key) {
    const [totalHits, ttl] = await this.client.eval(INCREMENT, { keys: [this.key(key)], arguments: [String(this.windowMs)] })
    return { totalHits: Number(totalHits), resetTime: new Date(Date.now() + Number(ttl)) }
  }

  async decrement(key) {
    await this.client.eval(DECREMENT, { keys: [this.key(key)] })
  }

  async resetKey(key) {
    await this.client.del(this.key(key))
  }
}
