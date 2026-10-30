import helmet from 'helmet'
import jwt from 'jsonwebtoken'

// Security headers + proxy trust + startup checks for the auth configuration.
//
// What was inspected before choosing these settings:
//   - the API only returns JSON (no HTML, no express.static, no file downloads/redirects), so a locked-down
//     CSP ("default-src 'none'") cannot break any page; the React app is hosted separately.
//   - tokens travel in the Authorization header / localStorage, there are NO cookies, so CORS stays
//     `cors({ origin: FRONTEND_URL })` without credentials and CSRF does not apply. Nothing about CORS is changed here.
//   - HSTS is only sent in production and WITHOUT includeSubDomains/preload, so it cannot lock other
//     subdomains of the host into HTTPS. (Browsers ignore HSTS on plain http://localhost anyway.)

// TRUST_PROXY: how many reverse-proxy hops sit in front of Express (e.g. 1 for nginx / a single load balancer),
// or an Express "trust proxy" keyword/CIDR list ('loopback', '10.0.0.0/8'). Unset = no proxy (correct for local dev).
// `true` is refused: it would trust any client-supplied X-Forwarded-For and let attackers dodge the rate limits.
export function parseTrustProxy(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || raw.toLowerCase() === 'false') return false
  if (raw.toLowerCase() === 'true') {
    throw new Error('TRUST_PROXY=true is not allowed: set the number of proxy hops (e.g. 1) or a list of trusted proxy addresses')
  }
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10)
  return raw
}

function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Pragma', 'no-cache')
  next()
}

export function applySecurity(app, env = process.env) {
  const production = env.NODE_ENV === 'production'
  const trustProxy = parseTrustProxy(env.TRUST_PROXY)
  if (trustProxy !== false) app.set('trust proxy', trustProxy)

  app.disable('x-powered-by')
  app.use(
    helmet({
      // JSON API: nothing is ever rendered, so forbid everything and forbid framing.
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      strictTransportSecurity: production ? { maxAge: 15552000, includeSubDomains: false, preload: false } : false,
    })
  )
  // Responses of the auth endpoints contain tokens: never let a browser or proxy cache them.
  app.use('/api/auth', noStore)
}

// Returns { errors, warnings } for the auth-related environment. index.js exits on errors.
export function checkAuthConfig(env = process.env) {
  const errors = []
  const warnings = []
  const production = env.NODE_ENV === 'production'

  for (const name of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    const secret = env[name] || ''
    if (secret && secret.length < 32) {
      const text = `${name} is shorter than 32 characters; use a long random value (e.g. 48 random bytes, base64)`
      ;(production ? errors : warnings).push(text)
    }
  }

  for (const name of ['JWT_ACCESS_EXPIRES_IN', 'JWT_REFRESH_EXPIRES_IN']) {
    if (env[name]) {
      try {
        jwt.sign({ check: true }, 'x', { expiresIn: env[name] })
      } catch {
        errors.push(`${name}="${env[name]}" is not a valid duration (examples: 15m, 7d, 3600)`)
      }
    }
  }

  try {
    parseTrustProxy(env.TRUST_PROXY)
  } catch (err) {
    errors.push(err.message)
  }

  if (!(env.REDIS_URL || '').trim()) {
    const text = 'REDIS_URL is not set: rate limits are counted in this process\'s memory. That is only correct when ONE backend instance runs; with several instances each one enforces its own counter.'
    if (production && env.RATE_LIMIT_REQUIRE_REDIS === 'true') errors.push(`${text} (RATE_LIMIT_REQUIRE_REDIS=true)`)
    else if (production) warnings.push(text)
  }

  return { errors, warnings }
}
