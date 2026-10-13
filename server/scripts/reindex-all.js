// Rebuilds the vectors of EVERY document from the text already stored in PostgreSQL.
// Use it after moving/deleting the ChromaDB folder (for example when the embedding service
// refuses to start because the collection is not cosine). It only reads documents and writes
// vectors: nothing in PostgreSQL is changed or deleted.
//
//   cd server && npm run reindex        (the embedding service must be running)
import 'dotenv/config'
import prisma from '../src/prisma.js'
import { indexDocument } from '../src/utils/vectorStore.js'

const docs = await prisma.document.findMany({
  select: { id: true, companyId: true, originalName: true, extractedText: true },
  orderBy: { createdAt: 'asc' },
})
console.log(`Re-indexing ${docs.length} document(s)...`)

let ok = 0
let failed = 0
for (const doc of docs) {
  try {
    const chunks = await indexDocument(doc)
    ok += 1
    console.log(`  OK     ${doc.originalName} (${chunks} chunks)`)
  } catch (err) {
    failed += 1
    console.error(`  FAILED ${doc.originalName}: ${err.message}`)
  }
}
console.log(`Done: ${ok} indexed, ${failed} failed.`)
await prisma.$disconnect()
process.exit(failed ? 1 : 0)
