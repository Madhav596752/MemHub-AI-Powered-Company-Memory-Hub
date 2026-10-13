// PDF -> answer pipeline, through the REAL Express routes and middleware:
//   upload (multer) -> real PDF text extraction (pdf-parse) -> real chunker -> index ->
//   /api/search and /api/ask -> citations.
//
// Fakes (so it runs offline, without Neon / Cloudinary / an API key):
//   - Prisma: in-memory, with the same companyId filtering as the real queries
//   - Cloudinary: records uploads/deletes
//   - LLM: answers ONLY from the excerpts it is actually sent
//   - Vector service: in-process, ranks by word overlap (default), OR the REAL Python service
//     (real ChromaDB, cosine distance) when PIPELINE_REAL_VECTOR_URL is set, e.g.
//       PIPELINE_REAL_VECTOR_URL=http://127.0.0.1:8001 EMBEDDING_SERVICE_TOKEN=... npm test
//     (with the real MiniLM model that is the closest thing to production without Neon + Groq).
//
// Needs: node --experimental-test-module-mocks   (already in the "test" script)
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'

process.env.JWT_ACCESS_SECRET = 'pipeline-test-secret'
process.env.GROQ_API_KEY = 'sk-test-not-a-real-key'
process.env.EMBEDDING_SERVICE_TOKEN ||= 'pipeline-test-internal-token'
delete process.env.RAG_MIN_SCORE
const REAL_VECTOR_URL = process.env.PIPELINE_REAL_VECTOR_URL || ''

// ---------- fake Prisma (same filters as the real queries in the routes) ----------
const db = { documents: [] }
const fakePrisma = {
  document: {
    create: async ({ data }) => {
      const doc = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...data, uploader: { id: data.uploadedBy, name: 'Test User' } }
      db.documents.push(doc)
      return doc
    },
    findMany: async ({ where }) =>
      db.documents.filter((d) => d.companyId === where.companyId && (!where.id?.in || where.id.in.includes(d.id))),
    findFirst: async ({ where }) => db.documents.find((d) => d.id === where.id && d.companyId === where.companyId) ?? null,
    deleteMany: async ({ where }) => {
      const before = db.documents.length
      db.documents = db.documents.filter((d) => !(d.id === where.id && d.companyId === where.companyId))
      return { count: before - db.documents.length }
    },
  },
}
mock.module('./prisma.js', { defaultExport: fakePrisma })

const cloud = { uploads: [], deletes: [] }
mock.module('./cloudinary.js', {
  namedExports: {
    isCloudinaryConfigured: () => true,
    uploadDocumentFile: async (filePath, companyId, fileName) => {
      cloud.uploads.push({ companyId, fileName })
      return { url: `https://files.example/${companyId}/${fileName}`, publicId: `pid-${fileName}` }
    },
    deleteDocumentFile: async (publicId) => void cloud.deletes.push(publicId),
  },
})

const { default: express } = await import('express')
const { default: documentsRouter } = await import('./routes/documents.js')
const { default: searchRouter } = await import('./routes/search.js')
const { default: askRouter } = await import('./routes/ask.js')

// ---------- fake vector service (word overlap; stateful; checks the internal token) ----------
const store = new Map() // `${companyId}:${documentId}` -> [{ text, metadata }]
const STOP = new Set(['the', 'and', 'for', 'are', 'what', 'how', 'can', 'does', 'our', 'with', 'that', 'from', 'was', 'who', 'did', 'about', 'this', 'there'])
const words = (s) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOP.has(w)) ?? [])
const vectorCalls = []

function startFakeVectorService() {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.headers['x-internal-token'] !== process.env.EMBEDDING_SERVICE_TOKEN) return send(401, { detail: 'invalid internal token' })
      const url = new URL(req.url, 'http://x')
      const body = raw ? JSON.parse(raw) : {}
      vectorCalls.push({ method: req.method, path: url.pathname, body })

      if (req.method === 'POST' && url.pathname === '/index') {
        store.set(`${body.companyId}:${body.documentId}`, body.chunks.map((c) => ({ text: c.text, metadata: { companyId: body.companyId, documentId: body.documentId, documentName: body.documentName, chunkIndex: c.chunkIndex, startChar: c.startChar, endChar: c.endChar } })))
        return send(200, { documentId: body.documentId, chunksStored: body.chunks.length })
      }
      if (req.method === 'POST' && url.pathname === '/search') {
        const q = words(body.query)
        const results = [...store.values()].flat()
          .filter((c) => c.metadata.companyId === body.companyId)
          .map((c) => {
            const cw = words(c.text)
            return { ...c, distance: 1 - (q.size ? [...q].filter((w) => cw.has(w)).length / q.size : 0) }
          })
          .sort((a, b) => a.distance - b.distance)
          .slice(0, body.topK)
        return send(200, { results })
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/documents/')) {
        store.delete(`${url.searchParams.get('companyId')}:${decodeURIComponent(url.pathname.split('/')[2])}`)
        return send(200, { deleted: true })
      }
      send(404, { detail: 'not found' })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

// ---------- fake LLM: answers only from the excerpts in the prompt it receives ----------
const llm = { prompts: [], fail: false }
function startFakeLlm() {
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = JSON.parse(raw)
      const user = body.messages.find((m) => m.role === 'user').content
      llm.prompts.push(user)
      if (llm.fail) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: { type: 'server_error', message: 'provider down' } }))
      }
      const excerpts = [...user.matchAll(/<document number="(\d+)"[^>]*>\n([\s\S]*?)\n<\/document>/g)]
      const hit = excerpts.find((m) => /ZEPHYR-LAUNCH-7731/.test(m[2]))
      const reply = hit
        ? { answerable: true, answer: `The Zephyr launch code is ZEPHYR-LAUNCH-7731 [${hit[1]}].`, citations: [Number(hit[1])] }
        : { answerable: false, answer: '', citations: [] }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

const vectorServer = REAL_VECTOR_URL ? null : await startFakeVectorService()
const llmServer = await startFakeLlm()
const vectorUrl = REAL_VECTOR_URL || `http://127.0.0.1:${vectorServer.address().port}`
process.env.EMBEDDING_SERVICE_URL = vectorUrl
process.env.LLM_API_URL = `http://127.0.0.1:${llmServer.address().port}/v1/chat/completions`

const app = express()
app.use(express.json())
app.use('/api/documents', documentsRouter)
app.use('/api/search', searchRouter)
app.use('/api/ask', askRouter)
const appServer = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s))
})
const base = `http://127.0.0.1:${appServer.address().port}`

test.after(() => {
  for (const s of [appServer, vectorServer, llmServer]) {
    s?.closeAllConnections?.()
    s?.close()
  }
})

// ---------- helpers ----------

// A tiny but valid one-page PDF whose text layer contains `lines` (empty array = a page with no text).
function makePdf(lines) {
  const esc = (t) => t.replace(/[\\()]/g, '\\$&')
  const content = lines.length ? `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -16 Td ' : ''}(${esc(l)}) Tj`).join(' ')} ET` : ''
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const COMPANY_A = `company-a-${randomUUID()}`
const COMPANY_B = `company-b-${randomUUID()}`
const tokenFor = (companyId) => jwt.sign({ userId: `user-${companyId}`, companyId, role: 'ADMIN' }, process.env.JWT_ACCESS_SECRET)
const tokenA = tokenFor(COMPANY_A)
const tokenB = tokenFor(COMPANY_B)

async function upload(token, fileName, buffer, { query = '', extraFields = {} } = {}) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), fileName)
  for (const [k, v] of Object.entries(extraFields)) form.append(k, v)
  const res = await fetch(`${base}/api/documents${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
  return { status: res.status, body: await res.json() }
}
const call = async (method, path, token, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const handbookA = makePdf([
  'Zephyr project handbook.',
  'The Zephyr launch code is ZEPHYR-LAUNCH-7731 and it must never be shared outside the company.',
  'Launch reviews take place every Tuesday morning in the main meeting room.',
])
const salaryB = makePdf([
  'Confidential salary bands.',
  'Senior engineers at company B earn between 90 and 120 thousand. CONFIDENTIAL-B-SALARY-TABLE.',
])

let docA // the document row created by the first upload

// ---------- A. document indexing ----------
test('A. a readable PDF is extracted, chunked, embedded/indexed and searchable', async () => {
  const { status, body } = await upload(tokenA, 'zephyr-handbook.pdf', handbookA)
  assert.equal(status, 201)
  assert.equal(body.indexing.status, 'indexed')
  assert.ok(body.indexing.chunks >= 1)

  docA = db.documents.find((d) => d.id === body.document.id)
  assert.ok(docA.extractedText.length > 0, 'extracted text must not be empty')
  assert.match(docA.extractedText, /ZEPHYR-LAUNCH-7731/)
  assert.equal(docA.companyId, COMPANY_A, 'companyId comes from the JWT')

  const indexCall = vectorCalls.filter((c) => c.path === '/index').at(-1)
  if (indexCall) {
    assert.equal(indexCall.body.companyId, COMPANY_A)
    assert.equal(indexCall.body.documentId, docA.id)
    assert.equal(indexCall.body.chunks.length, body.indexing.chunks)
  }

  const search = await call('POST', '/api/search', tokenA, { query: 'Zephyr launch code' })
  assert.equal(search.status, 200)
  assert.ok(search.body.results.length >= 1)
  assert.equal(search.body.results[0].documentId, docA.id)
  assert.equal(search.body.results[0].documentName, 'zephyr-handbook.pdf')
  assert.match(search.body.results[0].text, /ZEPHYR-LAUNCH-7731/)
})

// ---------- B. end-to-end RAG ----------
test('B1. a question answered by the PDF gets a grounded answer with a citation to that document', async () => {
  llm.prompts.length = 0
  const { status, body } = await call('POST', '/api/ask', tokenA, { question: 'What is the Zephyr launch code?' })
  assert.equal(status, 200)
  assert.equal(body.grounded, true)
  assert.match(body.answer, /ZEPHYR-LAUNCH-7731/)
  assert.ok(body.sources.length >= 1)
  assert.equal(body.sources[0].documentId, docA.id)
  assert.equal(body.sources[0].documentName, 'zephyr-handbook.pdf')
  assert.match(body.sources[0].text, /ZEPHYR-LAUNCH-7731/)
  // the retrieved text really reached the LLM prompt
  assert.equal(llm.prompts.length, 1)
  assert.match(llm.prompts[0], /ZEPHYR-LAUNCH-7731/)
})

test('B2. an unrelated question is not answered and nothing is invented', async () => {
  llm.prompts.length = 0
  const { status, body } = await call('POST', '/api/ask', tokenA, { question: 'cafeteria menu friday' })
  assert.equal(status, 200)
  assert.equal(body.grounded, false)
  assert.deepEqual(body.sources, [])
  assert.doesNotMatch(body.answer, /ZEPHYR|code is/i)
  assert.equal(llm.prompts.length, 0, 'no LLM call without relevant evidence')
})

// ---------- C. multi-tenancy ----------
test('C. two companies: each retrieves only its own documents, and spoofing companyId does nothing', async () => {
  const up = await upload(tokenB, 'salaries.pdf', salaryB)
  assert.equal(up.status, 201)
  const docB = db.documents.find((d) => d.id === up.body.document.id)
  assert.equal(docB.companyId, COMPANY_B)

  // B finds its own text; A does not see it
  const bOwn = await call('POST', '/api/search', tokenB, { query: 'senior engineers salary' })
  assert.ok(bOwn.body.results.every((r) => r.documentId === docB.id))
  assert.ok(bOwn.body.results.length >= 1)
  const aSeesB = await call('POST', '/api/search', tokenA, { query: 'senior engineers salary CONFIDENTIAL-B-SALARY-TABLE', limit: 20 })
  assert.ok(aSeesB.body.results.every((r) => r.documentId === docA.id))
  assert.ok(!JSON.stringify(aSeesB.body.results).includes('CONFIDENTIAL-B')) // (the response echoes the query itself, so check only the results)

  // A cannot ask using B's context, and B cannot read A's
  llm.prompts.length = 0
  const aAsk = await call('POST', '/api/ask', tokenA, { question: 'What are the senior engineers salary bands?' })
  assert.ok(!JSON.stringify(aAsk.body).includes('CONFIDENTIAL-B'))
  assert.ok(llm.prompts.every((p) => !p.includes('CONFIDENTIAL-B')))
  const bAsk = await call('POST', '/api/ask', tokenB, { question: 'What is the Zephyr launch code?' })
  assert.equal(bAsk.body.grounded, false)
  assert.ok(!JSON.stringify(bAsk.body).includes('ZEPHYR-LAUNCH'))

  // Spoofing: companyId in body, query string or multipart field must be ignored
  const spoofSearch = await call('POST', `/api/search?companyId=${COMPANY_B}`, tokenA, { query: 'senior engineers salary', companyId: COMPANY_B, company_id: COMPANY_B })
  assert.ok(!JSON.stringify(spoofSearch.body).includes('CONFIDENTIAL-B'))
  const spoofAsk = await call('POST', `/api/ask?companyId=${COMPANY_B}`, tokenA, { question: 'What are the senior engineers salary bands?', companyId: COMPANY_B })
  assert.ok(!JSON.stringify(spoofAsk.body).includes('CONFIDENTIAL-B'))
  const spoofUpload = await upload(tokenA, 'spoof.pdf', makePdf(['Spoof attempt document about gardening tools and ladders.']), { query: `?companyId=${COMPANY_B}`, extraFields: { companyId: COMPANY_B } })
  assert.equal(db.documents.find((d) => d.id === spoofUpload.body.document.id).companyId, COMPANY_A)
  assert.ok(cloud.uploads.at(-1).companyId === COMPANY_A)

  // Document records: list is per company; other company's id is "not found" for get / reindex / delete
  const listA = await call('GET', '/api/documents', tokenA)
  assert.ok(listA.body.documents.every((d) => d.originalName !== 'salaries.pdf'))
  assert.equal((await call('GET', `/api/documents/${docB.id}`, tokenA)).status, 404)
  assert.equal((await call('POST', `/api/documents/${docB.id}/reindex`, tokenA)).status, 404)
  assert.equal((await call('DELETE', `/api/documents/${docB.id}`, tokenA)).status, 404)
  assert.ok(db.documents.some((d) => d.id === docB.id), "B's document must survive A's delete attempt")
  const stillThere = await call('POST', '/api/search', tokenB, { query: 'senior engineers salary' })
  assert.ok(stillThere.body.results.length >= 1, "B's vectors must survive A's delete attempt")
})

// ---------- D. failure handling ----------
test('D1. a PDF with no readable text is rejected with NO_TEXT and nothing is saved or uploaded', async () => {
  const before = { docs: db.documents.length, uploads: cloud.uploads.length }
  const { status, body } = await upload(tokenA, 'scanned.pdf', makePdf([]))
  assert.equal(status, 400)
  assert.equal(body.code, 'NO_TEXT')
  assert.match(body.message, /no readable text/i)
  assert.deepEqual({ docs: db.documents.length, uploads: cloud.uploads.length }, before)
})

test('D2. a file that is not really a PDF is rejected', async () => {
  const { status } = await upload(tokenA, 'fake.pdf', Buffer.from('MZ this is an exe pretending to be a pdf'))
  assert.equal(status, 400)
})

test('D3. embedding service down at upload: document is saved but the response says indexing FAILED, with a code', async () => {
  const saved = process.env.EMBEDDING_SERVICE_URL
  process.env.EMBEDDING_SERVICE_URL = 'http://127.0.0.1:1'
  try {
    const { status, body } = await upload(tokenA, 'offline.pdf', makePdf(['A perfectly readable document that cannot be indexed right now.']))
    assert.equal(status, 201)
    assert.equal(body.indexing.status, 'failed')
    assert.equal(body.indexing.code, 'EMBEDDING_SERVICE_UNAVAILABLE')
    assert.doesNotMatch(JSON.stringify(body), /127\.0\.0\.1|ECONN|stack/i)
    // /api/search reports the outage honestly too (not an empty "no results")
    const s = await call('POST', '/api/search', tokenA, { query: 'readable document' })
    assert.equal(s.status, 503)
    assert.equal(s.body.code, 'EMBEDDING_SERVICE_UNAVAILABLE')
  } finally {
    process.env.EMBEDDING_SERVICE_URL = saved
  }
})

test('D4. a document that failed to index can be retried with /reindex once the service is back', async () => {
  const offline = db.documents.find((d) => d.originalName === 'offline.pdf')
  const r = await call('POST', `/api/documents/${offline.id}/reindex`, tokenA)
  assert.equal(r.status, 200)
  assert.equal(r.body.indexing.status, 'indexed')
})

test('D5. LLM failure is reported as an error (not as "no relevant information")', async () => {
  llm.fail = true
  try {
    const { status, body } = await call('POST', '/api/ask', tokenA, { question: 'What is the Zephyr launch code?' })
    assert.equal(status, 502)
    assert.equal(body.code, 'LLM_FAILED')
    assert.equal(body.answer, undefined)
    assert.doesNotMatch(JSON.stringify(body), /provider down|sk-test/)
  } finally {
    llm.fail = false
  }
})

test('D6. company with nothing indexed is told so (reason not_indexed), not "no relevant information"', async () => {
  const { body } = await call('POST', '/api/ask', tokenFor(`empty-${randomUUID()}`), { question: 'What is the Zephyr launch code?' })
  assert.equal(body.grounded, false)
  assert.equal(body.reason, 'not_indexed')
})

test('D7. deleting a document removes its vectors, so it can no longer be found or cited', async () => {
  const del = await call('DELETE', `/api/documents/${docA.id}`, tokenA)
  assert.equal(del.status, 200)
  const { body } = await call('POST', '/api/ask', tokenA, { question: 'What is the Zephyr launch code?' })
  assert.equal(body.grounded, false)
  assert.ok(!JSON.stringify(body).includes('ZEPHYR-LAUNCH'))
})
