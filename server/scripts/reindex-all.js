// Rebuilds the vectors of EVERY document from the text already stored in PostgreSQL.
// Use it after moving/deleting the ChromaDB folder (for example when the embedding service
// refuses to start because the collection is not cosine). It only reads documents and writes
// vectors: nothing in PostgreSQL is changed or deleted (except the knowledge-base version of each company, see below).
//
// Module 9.4: every document is re-indexed inside a knowledge-base change (utils/knowledgeVersion.js). While it runs the
// company's cached answers are bypassed, and when it ends the company's version advances (if ChromaDB changed), so
// answers cached by the running server before the reindex can no longer be served. The server does not need a restart.
//
//   cd server && npm run reindex        (the embedding service must be running)
import 'dotenv/config'
import prisma from '../src/prisma.js'
import { indexDocument } from '../src/utils/vectorStore.js'
import { beginKnowledgeChange, vectorWriteEffect } from '../src/utils/knowledgeVersion.js'

const docs = await prisma.document.findMany({
  select: { id: true, companyId: true, originalName: true, extractedText: true },
  orderBy: { createdAt: 'asc' },
})
console.log(`Re-indexing ${docs.length} document(s)...`)

let ok = 0
let failed = 0
for (const doc of docs) {
  const change = await beginKnowledgeChange(prisma, doc.companyId, 'reindex-script')
  try {
    const chunks = await change.step(() => indexDocument(doc), { onError: vectorWriteEffect })
    ok += 1
    console.log(`  OK     ${doc.originalName} (${chunks} chunks)`)
  } catch (err) {
    failed += 1
    console.error(`  FAILED ${doc.originalName}: ${err.message}`)
  } finally {
    await change.settle()
  }
}
console.log(`Done: ${ok} indexed, ${failed} failed.`)
await prisma.$disconnect()
process.exit(failed ? 1 : 0)
