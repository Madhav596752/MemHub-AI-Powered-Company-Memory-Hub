// Neo4j connection for the knowledge graph (official neo4j-driver, Bolt).
//
// Configuration comes from the environment only: NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD and
// optionally NEO4J_DATABASE. If they are not all set, the graph feature is simply OFF: uploads,
// vector search and /api/ask keep working exactly as before.
//
// Query parameters are never written to the log (they can contain document text).
import neo4j from 'neo4j-driver'
import { RELATION_TYPES } from './graphIdentity.js'

// status: 503 = graph not configured / unreachable, 502 = rejected or failed, 422 = too much data.
// message is safe to show to a user; details only go to the server log.
export class GraphError extends Error {
  constructor(message, status = 503, code = 'GRAPH_UNAVAILABLE') {
    super(message)
    this.name = 'GraphError'
    this.status = status
    this.code = code
  }
}

const env = (name) => (process.env[name] || '').trim()

export function isNeo4jConfigured() {
  return Boolean(env('NEO4J_URI') && env('NEO4J_USERNAME') && env('NEO4J_PASSWORD'))
}

let driver = null

export function getDriver() {
  if (!isNeo4jConfigured()) {
    throw new GraphError('The knowledge graph is not configured on the server.', 503, 'GRAPH_NOT_CONFIGURED')
  }
  if (!driver) {
    driver = neo4j.driver(env('NEO4J_URI'), neo4j.auth.basic(env('NEO4J_USERNAME'), env('NEO4J_PASSWORD')), {
      connectionTimeout: 5000,
      connectionAcquisitionTimeout: 5000,
      maxTransactionRetryTime: 10000,
    })
  }
  return driver
}

// Tests only: swap in a fake driver (pass null to reset).
export function setDriverForTests(fake) {
  driver = fake
}

export async function closeDriver() {
  if (driver) await driver.close().catch(() => {})
  driver = null
}

export const int = (n) => neo4j.int(n)

// Neo4j integers -> plain JS numbers, recursively.
export function toNative(value) {
  if (neo4j.isInt(value)) return value.toNumber()
  if (Array.isArray(value)) return value.map(toNative)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toNative(v)]))
  return value
}

export function rows(result) {
  return result.records.map((rec) => Object.fromEntries(rec.keys.map((k) => [k, toNative(rec.get(k))])))
}

function toGraphError(err) {
  if (err instanceof GraphError) return err
  const code = err?.code || ''
  console.error('Neo4j error:', code, err?.message)
  if (code === 'ServiceUnavailable' || code === 'SessionExpired' || /ECONNREFUSED|ENOTFOUND|timed out|Could not perform discovery/i.test(err?.message || '')) {
    return new GraphError('The knowledge graph database is currently unavailable.', 503, 'GRAPH_UNAVAILABLE')
  }
  if (/Unauthorized|AuthenticationRateLimit|Security/.test(code)) {
    return new GraphError('The graph database rejected this server. An administrator must check NEO4J_USERNAME / NEO4J_PASSWORD.', 502, 'GRAPH_AUTH_FAILED')
  }
  return new GraphError('The knowledge graph query failed.', 502, 'GRAPH_QUERY_FAILED')
}

async function inSession(mode, fn) {
  const session = getDriver().session({ database: env('NEO4J_DATABASE') || undefined, defaultAccessMode: mode })
  try {
    return await fn(session)
  } catch (err) {
    throw toGraphError(err)
  } finally {
    await session.close().catch(() => {})
  }
}

// readQuery(cypher, params) -> plain rows.   Runs as a managed (retried) read transaction.
export const readQuery = (cypher, params = {}) =>
  inSession('READ', (s) => s.executeRead(async (tx) => rows(await tx.run(cypher, params))))

// readTx(async (tx) => ...) / writeTx(async (tx) => ...): several statements in ONE transaction.
export const readTx = (fn) => inSession('READ', (s) => s.executeRead(fn))
export const writeTx = (fn) => inSession('WRITE', (s) => s.executeWrite(fn))

// Never throws. { configured, status: 'disabled' | 'ok' | 'unavailable' }
export async function checkNeo4jHealth() {
  if (!isNeo4jConfigured()) return { configured: false, status: 'disabled' }
  try {
    await getDriver().verifyConnectivity({ database: env('NEO4J_DATABASE') || undefined })
    await readQuery('RETURN 1 AS ok')
    return { configured: true, status: 'ok' }
  } catch (err) {
    console.error('Neo4j health check failed:', err?.code || '', err?.message || '')
    return { configured: true, status: 'unavailable' }
  }
}

// ---------- constraints and indexes (idempotent: IF NOT EXISTS) ----------
// Plain single-property uniqueness constraints work on Neo4j Community Edition too, which is why
// every node has one synthetic "uid" (company-prefixed) instead of a composite key.
// Relationship-type names below come from the fixed RELATION_TYPES list, never from input.
export const SCHEMA_STATEMENTS = [
  'CREATE CONSTRAINT memhub_entity_uid IF NOT EXISTS FOR (n:Entity) REQUIRE n.uid IS UNIQUE',
  'CREATE CONSTRAINT memhub_document_uid IF NOT EXISTS FOR (n:Document) REQUIRE n.uid IS UNIQUE',
  'CREATE CONSTRAINT memhub_chunk_uid IF NOT EXISTS FOR (n:Chunk) REQUIRE n.uid IS UNIQUE',
  'CREATE INDEX memhub_entity_company_key IF NOT EXISTS FOR (n:Entity) ON (n.companyId, n.normalizedKey)',
  'CREATE INDEX memhub_chunk_company_doc IF NOT EXISTS FOR (n:Chunk) ON (n.companyId, n.documentId)',
  'CREATE INDEX memhub_document_company IF NOT EXISTS FOR (n:Document) ON (n.companyId)',
]

export async function ensureGraphSchema() {
  for (const statement of SCHEMA_STATEMENTS) {
    await inSession('WRITE', (s) => s.run(statement)) // schema changes run in their own auto-commit transactions
  }
  return SCHEMA_STATEMENTS.length
}

export { RELATION_TYPES }
