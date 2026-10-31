import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import healthRouter from './routes/health.js'
import authRouter from './routes/auth.js'
import documentsRouter from './routes/documents.js'
import searchRouter from './routes/search.js'
import askRouter from './routes/ask.js'
import graphRouter from './routes/graph.js'
import usersRouter from './routes/users.js'
import { applySecurity, checkAuthConfig } from './middleware/security.js'
import { apiNotFound, apiErrorHandler } from './middleware/errorHandler.js'
import { rateLimitStoreKind } from './middleware/rateLimit.js'
import { purgeExpiredRefreshTokens } from './utils/refreshTokens.js'
import { isNeo4jConfigured, ensureGraphSchema } from './utils/neo4j.js'
import { initRedisCache } from './utils/redisCache.js'
import { isCloudinaryConfigured } from './cloudinary.js'

// Fail early with a clear message if the JWT secrets are missing
if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) {
  console.error('Missing JWT_ACCESS_SECRET or JWT_REFRESH_SECRET in server/.env')
  process.exit(1)
}

if (process.env.JWT_ACCESS_SECRET === process.env.JWT_REFRESH_SECRET) {
  console.error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different')
  process.exit(1)
}

// Auth configuration problems (weak secrets in production, invalid durations/TRUST_PROXY) stop the server;
// softer problems (e.g. in-memory rate limiting in production) are only warned about.
{
  const { errors, warnings } = checkAuthConfig()
  warnings.forEach((w) => console.warn(`Warning: ${w}`))
  if (errors.length) {
    errors.forEach((e) => console.error(`Config error: ${e}`))
    process.exit(1)
  }
  console.log(`Rate limiting store: ${rateLimitStoreKind()}`)
}

// Document uploads need Cloudinary. Don't stop the server (login still works), just warn.
if (!isCloudinaryConfigured()) {
  console.warn('Warning: CLOUDINARY_* is not set in server/.env — document uploads will fail')
}

// Question answering needs an LLM key. Don't stop the server, just warn.
if (!process.env.GROQ_API_KEY) {
  console.warn('Warning: GROQ_API_KEY is not set in server/.env — /api/ask will return a "not configured" error')
}

// The Python embedding service rejects calls without the shared secret.
if (!process.env.EMBEDDING_SERVICE_TOKEN) {
  console.warn('Warning: EMBEDDING_SERVICE_TOKEN is not set in server/.env — indexing and search will fail (the embedding service requires the same token)')
}

// Knowledge graph (Neo4j + NLP service) is optional: without it uploads, search and Q&A work as before.
if (!isNeo4jConfigured()) {
  console.warn('Warning: NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD are not all set in server/.env — the knowledge graph and graph retrieval are OFF')
} else if (!process.env.NLP_SERVICE_TOKEN) {
  console.warn('Warning: NLP_SERVICE_TOKEN is not set in server/.env — documents will not be added to the knowledge graph (the NLP service requires the same token)')
}

const app = express()

const PORT = process.env.PORT || 5000
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'

applySecurity(app) // security headers, TRUST_PROXY, no-store on /api/auth (see middleware/security.js)
app.use(cors({ origin: FRONTEND_URL }))
app.use(express.json())

app.use('/api/health', healthRouter)
app.use('/api/auth', authRouter)
app.use('/api/documents', documentsRouter)
app.use('/api/search', searchRouter)
app.use('/api/ask', askRouter)
app.use('/api/graph', graphRouter)
app.use('/api/users', usersRouter)

// Unknown API routes -> JSON 404 (instead of Express's HTML page)
app.use('/api', apiNotFound)

// Last-resort error handler (malformed/too large JSON body, unexpected errors). Never leaks stack traces.
app.use(apiErrorHandler)

// Remove expired refresh-token rows (they are only needed until they expire). Safe to run on every instance.
const PURGE_INTERVAL_MS = 60 * 60 * 1000
const purge = () => purgeExpiredRefreshTokens().catch((err) => console.error('Refresh token cleanup failed:', err?.code || err?.message))
setTimeout(purge, 30 * 1000).unref()
setInterval(purge, PURGE_INTERVAL_MS).unref()

app.listen(PORT, () => {
  console.log(`MemHub API running on http://localhost:${PORT}`)
  // Redis cache (optional). Never blocks or stops the server: if Redis is not configured or unreachable the
  // cache is simply OFF and keeps retrying in the background.
  initRedisCache().then(({ status }) => console.log(`Redis cache: ${status}`))
  // Create the Neo4j constraints/indexes (idempotent). A failure is only logged: the graph then
  // reports "unavailable" and the rest of the app keeps working.
  if (isNeo4jConfigured()) {
    ensureGraphSchema()
      .then((n) => console.log(`Neo4j schema ready (${n} constraints/indexes ensured)`))
      .catch((err) => console.error('Neo4j schema setup failed:', err.code || err.message))
  }
})
