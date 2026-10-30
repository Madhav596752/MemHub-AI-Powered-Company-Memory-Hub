// Creates the Neo4j constraints and indexes the knowledge graph needs. Safe to run any number of
// times (every statement is IF NOT EXISTS). The server also does this at start-up.
//
//   cd server && npm run graph:setup
import 'dotenv/config'
import { closeDriver, ensureGraphSchema, isNeo4jConfigured, SCHEMA_STATEMENTS } from '../src/utils/neo4j.js'

if (!isNeo4jConfigured()) {
  console.error('Set NEO4J_URI, NEO4J_USERNAME and NEO4J_PASSWORD in server/.env first.')
  process.exit(1)
}
try {
  const n = await ensureGraphSchema()
  console.log(`Neo4j schema ready (${n} statements):`)
  for (const s of SCHEMA_STATEMENTS) console.log(`  ${s}`)
  await closeDriver()
} catch (err) {
  console.error('Neo4j schema setup failed:', err.code || err.message)
  await closeDriver()
  process.exit(1)
}
