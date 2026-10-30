// END-TO-END test of POST /api/ask: real Python service (MiniLM + ChromaDB), real PostgreSQL,
// real JWT middleware and the real route. Only the LLM provider is FAKE (a local HTTP server),
// so no API key or money is needed. Skipped unless RAG_INTEGRATION=1.
//
// Prerequisites are the same as rag.integration.test.js (PostgreSQL migrated, DATABASE_URL set,
// embedding service running on a THROW-AWAY store: CHROMA_PATH=./chroma_test_data).
// Run:  cd server && $env:RAG_INTEGRATION=1; node --test src/ask.integration.test.js
//
// It creates two temporary companies and deletes them (and their vectors) again at the end.
import 'dotenv/config'
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'

process.env.JWT_ACCESS_SECRET ||= 'integration-test-secret'

const refundText =
  'Refund policy. Customers can request a refund within 14 days of purchase. ' +
  'Refunds are paid back to the original payment method within five business days. ' +
  'Digital products that were already downloaded are not refundable.'
const salaryText =
  'Confidential salary bands. Senior engineers are paid between 90 and 120 thousand per year. ' +
  'Bonuses depend on yearly performance reviews and company revenue.'
const kitchenText =
  'Office kitchen rules. Please wash your own dishes and label food in the shared fridge. ' +
  'The coffee machine is cleaned every Friday afternoon.'

test('POST /api/ask end to end', { skip: process.env.RAG_INTEGRATION !== '1' }, async (t) => {
  const { default: express } = await import('express')
  const { default: jwt } = await import('jsonwebtoken')
  const { default: prisma } = await import('./prisma.js')
  const { default: askRouter } = await import('./routes/ask.js')
  const { indexDocument, deleteDocumentChunks } = await import('./utils/vectorStore.js')

  // Fake LLM: records each prompt; answers from the first excerpt that mentions "refund".
  const prompts = []
  const llmServer = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => {
        const body = JSON.parse(raw)
        const content = body.messages.find((m) => m.role === 'user').content
        prompts.push(content)
        const hit = [...content.matchAll(/<document number="(\d+)"[^>]*>\n([\s\S]*?)\n<\/document>/g)].find((m) => /refund/i.test(m[2]))
        const out = hit
          ? { answerable: true, answer: `Refunds can be requested within 14 days of purchase [${hit[1]}].`, citations: [Number(hit[1])] }
          : { answerable: false, answer: '', citations: [] }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }))
      })
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
  const original = { key: process.env.GROQ_API_KEY, url: process.env.LLM_API_URL }
  process.env.GROQ_API_KEY = 'sk-test-not-a-real-key'
  process.env.LLM_API_URL = `http://127.0.0.1:${llmServer.address().port}/openai/v1/chat/completions`

  const app = express()
  app.use(express.json())
  app.use('/api/ask', askRouter)
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const tokenFor = (companyId) => jwt.sign({ userId: randomUUID(), companyId, role: 'MEMBER' }, process.env.JWT_ACCESS_SECRET)
  const ask = (token, body) =>
    fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }))

  const companyA = await prisma.company.create({ data: { name: `ask-test-A-${randomUUID()}` } })
  const companyB = await prisma.company.create({ data: { name: `ask-test-B-${randomUUID()}` } })
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
    const kitchenDoc = await makeDoc(companyA, 'kitchen.txt', kitchenText)
    const salaryDoc = await makeDoc(companyB, 'salaries.txt', salaryText)
    for (const doc of [refundDoc, kitchenDoc, salaryDoc]) assert.ok((await indexDocument(doc)) >= 1)
    const tokenA = tokenFor(companyA.id)
    const tokenB = tokenFor(companyB.id)

    await t.test('relevant question: grounded answer citing the real document and chunk', async () => {
      prompts.length = 0
      const { status, body } = await ask(tokenA, { question: 'How many days do I have to request a refund?' })
      assert.equal(status, 200)
      assert.equal(body.grounded, true)
      assert.ok(body.sources.length >= 1)
      const src = body.sources[0]
      assert.equal(src.documentId, refundDoc.id)
      assert.equal(src.documentName, 'refund-policy.txt')
      // the cited text is exactly that slice of the stored document
      assert.equal(refundText.slice(src.startChar, src.endChar), src.text)
      assert.ok(src.text.includes('14 days'))
    })

    await t.test('missing information: no invented answer', async () => {
      const { status, body } = await ask(tokenA, { question: 'What is the airspeed velocity of an unladen swallow?' })
      assert.equal(status, 200)
      assert.equal(body.grounded, false)
      assert.deepEqual(body.sources, [])
    })

    await t.test('tenant isolation: company A cannot reach company B salary text', async () => {
      prompts.length = 0
      const forged = await ask(tokenA, { question: 'What are the senior engineer salary bands?', companyId: companyB.id })
      const all = JSON.stringify(forged.body) + prompts.join('')
      assert.ok(!all.includes('Confidential salary'))
      assert.ok(!all.includes(salaryDoc.id))
      // and company B can reach it
      prompts.length = 0
      await ask(tokenB, { question: 'What are the senior engineer salary bands?' })
      assert.ok(prompts.join('').includes('Confidential salary'))
    })

    await t.test('unauthenticated request is rejected', async () => {
      assert.equal((await ask(null, { question: 'refund?' })).status, 401)
    })

    await t.test('empty question is rejected', async () => {
      assert.equal((await ask(tokenA, { question: '  ' })).status, 400)
    })
  } finally {
    process.env.GROQ_API_KEY = original.key
    process.env.LLM_API_URL = original.url
    const docs = await prisma.document.findMany({ where: { companyId: { in: [companyA.id, companyB.id] } }, select: { id: true, companyId: true } })
    for (const d of docs) await deleteDocumentChunks(d.companyId, d.id).catch(() => {})
    await prisma.company.deleteMany({ where: { id: { in: [companyA.id, companyB.id] } } })
    await prisma.$disconnect()
    server.close()
    llmServer.closeAllConnections?.()
    llmServer.close()
  }
})
