// END-TO-END test of the RAG pipeline: real Python service (MiniLM + ChromaDB), real PostgreSQL,
// real search route. Skipped unless RAG_INTEGRATION=1.
//
// Prerequisites (see README):
//   1. PostgreSQL running with the migrations applied and DATABASE_URL set in server/.env
//   2. The embedding service running at EMBEDDING_SERVICE_URL (default http://localhost:8001).
//      Use a THROW-AWAY vector store so test data never mixes with real data:
//        CHROMA_PATH=./chroma_test_data uvicorn app:app --host 127.0.0.1 --port 8001
//   3. Run:  cd server && RAG_INTEGRATION=1 node --test src/rag.integration.test.js
//      (Windows PowerShell:  $env:RAG_INTEGRATION=1; node --test src/rag.integration.test.js)
//
// It creates two temporary companies and deletes them (and their vectors) again at the end.
import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

process.env.JWT_ACCESS_SECRET ||= 'integration-test-secret'

const refundText =
  'Refund policy. Customers can request a refund within 14 days of purchase. ' +
  'Refunds are paid back to the original payment method within five business days. '.repeat(3) +
  'Digital products that were already downloaded are not refundable.'
const salaryText =
  'Confidential salary bands. Senior engineers are paid between 90 and 120 thousand per year. ' +
  'Bonuses depend on yearly performance reviews and company revenue. '.repeat(3)
const unrelatedText =
  'Office kitchen rules. Please wash your own dishes and label food in the shared fridge. ' +
  'The coffee machine is cleaned every Friday afternoon. '.repeat(3)

test('RAG pipeline end to end', { skip: process.env.RAG_INTEGRATION !== '1' }, async (t) => {
  const { default: express } = await import('express')
  const { default: jwt } = await import('jsonwebtoken')
  const { default: prisma } = await import('./prisma.js')
  const { default: searchRouter } = await import('./routes/search.js')
  const { indexDocument, deleteDocumentChunks } = await import('./utils/vectorStore.js')

  const originalServiceUrl = process.env.EMBEDDING_SERVICE_URL
  const app = express()
  app.use(express.json())
  app.use('/api/search', searchRouter)
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`

  const tokenFor = (companyId) => jwt.sign({ userId: randomUUID(), companyId, role: 'MEMBER' }, process.env.JWT_ACCESS_SECRET)
  const search = (token, body) =>
    fetch(`${base}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }))

  const companyA = await prisma.company.create({ data: { name: `rag-test-A-${randomUUID()}` } })
  const companyB = await prisma.company.create({ data: { name: `rag-test-B-${randomUUID()}` } })
  const makeDoc = (company, originalName, extractedText) =>
    prisma.document.create({
      data: {
        companyId: company.id,
        originalName,
        fileName: `${randomUUID()}.txt`,
        mimeType: 'text/plain',
        fileSize: extractedText.length,
        cloudinaryUrl: 'https://example.invalid/test',
        cloudinaryPublicId: `test/${randomUUID()}`,
        extractedText,
      },
    })

  try {
    const refundDoc = await makeDoc(companyA, 'refund-policy.txt', refundText)
    const kitchenDoc = await makeDoc(companyA, 'kitchen.txt', unrelatedText)
    const salaryDoc = await makeDoc(companyB, 'salaries.txt', salaryText)
    for (const doc of [refundDoc, kitchenDoc, salaryDoc]) {
      assert.ok((await indexDocument(doc)) >= 1)
    }
    const tokenA = tokenFor(companyA.id)
    const tokenB = tokenFor(companyB.id)

    await t.test('unauthenticated search is rejected', async () => {
      assert.equal((await search(null, { query: 'refund' })).status, 401)
      assert.equal((await search('not-a-real-token', { query: 'refund' })).status, 401)
    })

    await t.test('empty or invalid queries are rejected', async () => {
      assert.equal((await search(tokenA, { query: '   ' })).status, 400)
      assert.equal((await search(tokenA, {})).status, 400)
      assert.equal((await search(tokenA, { query: 'x', limit: 999 })).status, 400)
    })

    await t.test('semantic search returns the relevant chunk first, with source metadata', async () => {
      const { status, body } = await search(tokenA, { query: 'How long do refunds take to arrive?', limit: 3 })
      assert.equal(status, 200)
      assert.ok(body.results.length >= 1)
      const top = body.results[0]
      assert.equal(top.documentId, refundDoc.id)
      assert.equal(top.documentName, 'refund-policy.txt')
      assert.ok(top.text.includes('Refund'))
      assert.equal(typeof top.score, 'number')
      assert.equal(typeof top.distance, 'number')
    })

    await t.test('company A never sees company B chunks (even when asking for them)', async () => {
      const { body } = await search(tokenA, { query: 'senior engineer salary bands', limit: 20 })
      assert.ok(body.results.every((r) => r.documentId !== salaryDoc.id))
      assert.ok(body.results.every((r) => !r.text.includes('Confidential salary')))
    })

    await t.test('a companyId sent by the client is ignored', async () => {
      const { body } = await search(tokenA, { query: 'senior engineer salary bands', limit: 20, companyId: companyB.id })
      assert.ok(body.results.every((r) => r.documentId !== salaryDoc.id))
    })

    await t.test('company B can find its own document but not company A documents', async () => {
      const own = await search(tokenB, { query: 'senior engineer salary bands', limit: 20 })
      assert.equal(own.body.results[0].documentId, salaryDoc.id)
      const other = await search(tokenB, { query: 'refund within 14 days', limit: 20 })
      assert.ok(other.body.results.every((r) => r.documentId === salaryDoc.id))
    })

    await t.test('reindexing replaces chunks instead of duplicating them', async () => {
      await indexDocument(refundDoc)
      await indexDocument(refundDoc)
      const { body } = await search(tokenA, { query: 'refund policy', limit: 20 })
      const keys = body.results.map((r) => `${r.documentId}:${r.chunkIndex}`)
      assert.equal(new Set(keys).size, keys.length)

      // A shorter version of the text must not leave stale chunks behind
      const shorter = { ...refundDoc, extractedText: 'Refunds are paid within five business days.' }
      assert.equal(await indexDocument(shorter), 1)
      const after = await search(tokenA, { query: 'refund policy', limit: 20 })
      const refundHits = after.body.results.filter((r) => r.documentId === refundDoc.id)
      assert.equal(refundHits.length, 1)
      await indexDocument(refundDoc) // restore
    })

    await t.test("another company cannot delete a document's vectors", async () => {
      await deleteDocumentChunks(companyB.id, refundDoc.id) // wrong company: must do nothing
      const { body } = await search(tokenA, { query: 'refund within 14 days', limit: 5 })
      assert.equal(body.results[0].documentId, refundDoc.id)
    })

    await t.test('deleting a document removes its vectors', async () => {
      await deleteDocumentChunks(companyA.id, refundDoc.id)
      const { body } = await search(tokenA, { query: 'refund within 14 days', limit: 20 })
      assert.ok(body.results.every((r) => r.documentId !== refundDoc.id))
      // company B is unaffected
      const b = await search(tokenB, { query: 'senior engineer salary bands', limit: 5 })
      assert.equal(b.body.results[0].documentId, salaryDoc.id)
    })

    await t.test('search reports 503 when the embedding service is down', async () => {
      process.env.EMBEDDING_SERVICE_URL = 'http://127.0.0.1:1'
      try {
        const { status, body } = await search(tokenA, { query: 'refund' })
        assert.equal(status, 503)
        assert.doesNotMatch(JSON.stringify(body), /127\.0\.0\.1|stack|ECONN/i)
      } finally {
        process.env.EMBEDDING_SERVICE_URL = originalServiceUrl
      }
    })
  } finally {
    process.env.EMBEDDING_SERVICE_URL = originalServiceUrl
    const docs = await prisma.document.findMany({ where: { companyId: { in: [companyA.id, companyB.id] } }, select: { id: true, companyId: true } })
    for (const d of docs) await deleteDocumentChunks(d.companyId, d.id).catch(() => {})
    await prisma.company.deleteMany({ where: { id: { in: [companyA.id, companyB.id] } } }) // cascades to documents
    await prisma.$disconnect()
    server.close()
  }
})
