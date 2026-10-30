// Builds (or rebuilds) the knowledge graph of EVERY document from the text already stored in PostgreSQL.
// Use it for documents uploaded before the graph existed, or after a Neo4j / NLP outage.
// Safe to repeat: each document's graph contribution is replaced, never duplicated. It does not touch
// PostgreSQL documents or the vector index.
//
//   cd server && npm run graph:reprocess      (the NLP service and Neo4j must be running)
import 'dotenv/config'
import prisma from '../src/prisma.js'
import { processDocumentGraph } from '../src/utils/graphIngest.js'
import { closeDriver } from '../src/utils/neo4j.js'

const docs = await prisma.document.findMany({
  select: { id: true, companyId: true, originalName: true, extractedText: true },
  orderBy: { createdAt: 'asc' },
})
console.log(`Processing ${docs.length} document(s) for the knowledge graph...`)

const tally = { processed: 0, failed: 0, skipped: 0 }
for (const doc of docs) {
  const r = await processDocumentGraph(doc)
  tally[r.status] += 1
  const note = r.status === 'processed' && r.relationshipStatus === 'none' ? ' [entities found, no relationships stated in the text]' : ''
  console.log(`  ${r.status.toUpperCase().padEnd(9)} ${doc.originalName} (${r.entities} entities, ${r.relationships} relationships)${r.code ? ` [${r.code}]` : ''}${note}`)
}
console.log(`Done: ${tally.processed} processed, ${tally.failed} failed, ${tally.skipped} skipped.`)
await closeDriver()
await prisma.$disconnect()
process.exit(tally.failed ? 1 : 0)
