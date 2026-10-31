// GET /api/documents and GET /api/documents/:id (the data the Knowledge Base page shows), through the REAL
// Express router and the REAL JWT middleware, with an in-memory stand-in for Prisma that filters by
// companyId exactly like PostgreSQL would. Covers: authentication, tenant isolation, and the shape of the
// per-document knowledge-graph processing status (GraphIngestion).
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'

process.env.JWT_ACCESS_SECRET = 'unit-test-access-secret'

const UUID_A1 = '11111111-1111-4111-8111-111111111111'
const UUID_A2 = '11111111-1111-4111-8111-222222222222'
const UUID_A3 = '11111111-1111-4111-8111-333333333333'
const UUID_B1 = '22222222-2222-4222-8222-111111111111'

const when = new Date('2026-09-01T10:00:00.000Z')
const DOCS = [
  {
    id: UUID_A1, companyId: 'company-A', originalName: 'a-incident.pdf', fileName: `${UUID_A1}.pdf`, mimeType: 'application/pdf', fileSize: 100,
    cloudinaryUrl: 'https://files.example/a1.pdf', cloudinaryPublicId: 'pid-a1', extractedText: 'Priya fixed the login issue. '.repeat(100), createdAt: when,
    uploader: { id: 'user-A', name: 'Priya Rao' },
    // the raw row has internal fields that must never reach the browser
    graphIngestion: { documentId: UUID_A1, companyId: 'company-A', status: 'processed', entityCount: 12, relationshipCount: 7, errorCode: null, pipeline: 'memhub-nlp-v1-hybrid', processedAt: when, updatedAt: when },
  },
  {
    id: UUID_A2, companyId: 'company-A', originalName: 'a-failed.docx', fileName: `${UUID_A2}.docx`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileSize: 200,
    cloudinaryUrl: 'https://files.example/a2.docx', cloudinaryPublicId: 'pid-a2', extractedText: 'text', createdAt: when,
    uploader: null,
    graphIngestion: { documentId: UUID_A2, companyId: 'company-A', status: 'failed', entityCount: 0, relationshipCount: 0, errorCode: 'NLP_CHUNK_FAILED', pipeline: null, processedAt: null, updatedAt: when },
  },
  {
    id: UUID_A3, companyId: 'company-A', originalName: 'a-legacy.txt', fileName: `${UUID_A3}.txt`, mimeType: 'text/plain', fileSize: 50,
    cloudinaryUrl: 'https://files.example/a3.txt', cloudinaryPublicId: 'pid-a3', extractedText: 'legacy', createdAt: when,
    uploader: { id: 'user-A', name: 'Priya Rao' },
    graphIngestion: null, // uploaded before the graph existed: no processing record
  },
  {
    id: UUID_B1, companyId: 'company-B', originalName: 'b-secret.pdf', fileName: `${UUID_B1}.pdf`, mimeType: 'application/pdf', fileSize: 999,
    cloudinaryUrl: 'https://files.example/b1.pdf', cloudinaryPublicId: 'pid-b1', extractedText: 'TOP SECRET OF COMPANY B', createdAt: when,
    uploader: { id: 'user-B', name: 'Bob Other' },
    graphIngestion: { documentId: UUID_B1, companyId: 'company-B', status: 'processed', entityCount: 99, relationshipCount: 98, errorCode: null, pipeline: 'x', processedAt: when, updatedAt: when },
  },
]

const calls = []
mock.module('../prisma.js', {
  defaultExport: {
    document: {
      // Same company filtering as the real query; records the arguments so the tests can assert on them.
      findMany: async (args) => {
        calls.push({ op: 'findMany', args })
        return DOCS.filter((d) => d.companyId === args.where.companyId)
      },
      findFirst: async (args) => {
        calls.push({ op: 'findFirst', args })
        return DOCS.find((d) => d.id === args.where.id && d.companyId === args.where.companyId) ?? null
      },
    },
  },
})

const { default: express } = await import('express')
const { default: documentsRouter } = await import('./documents.js')

const app = express()
app.use(express.json())
app.use('/api/documents', documentsRouter)
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const token = (companyId) => jwt.sign({ userId: `user-${companyId}`, companyId, role: 'MEMBER' }, process.env.JWT_ACCESS_SECRET, { algorithm: 'HS256' })
const tokenA = token('company-A')
const tokenB = token('company-B')
const get = async (path, tok, headers = {}) => {
  const res = await fetch(base + path, { headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers } })
  return { status: res.status, body: await res.json() }
}
test.after(() => { server.closeAllConnections?.(); server.close() })

test('list and detail require authentication, and unauthenticated requests never reach the database', async () => {
  calls.length = 0
  for (const path of ['/api/documents', `/api/documents/${UUID_A1}`]) {
    assert.equal((await get(path)).status, 401, path)
    assert.equal((await get(path, 'not-a-token')).status, 401, path)
    const wrongSecret = jwt.sign({ userId: 'u', companyId: 'company-A', role: 'MEMBER' }, 'another-secret', { algorithm: 'HS256' })
    assert.equal((await get(path, wrongSecret)).status, 401, path)
  }
  assert.equal(calls.length, 0)
})

test('list: only the JWT company is queried; a client-supplied companyId (query or header) is ignored', async () => {
  calls.length = 0
  const { status, body } = await get('/api/documents?companyId=company-B', tokenA, { 'x-company-id': 'company-B' })
  assert.equal(status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.where.companyId, 'company-A')
  assert.deepEqual(body.documents.map((d) => d.id).sort(), [UUID_A1, UUID_A2, UUID_A3].sort())
  assert.ok(!JSON.stringify(body).includes('b-secret'), 'no document of company B')
  assert.ok(!JSON.stringify(body).includes('TOP SECRET'))
})

test('list: company B sees only its own documents and its own processing status', async () => {
  const { body } = await get('/api/documents', tokenB)
  assert.deepEqual(body.documents.map((d) => d.id), [UUID_B1])
  assert.equal(body.documents[0].graphIngestion.entityCount, 99)
  assert.ok(!JSON.stringify(body).includes('a-incident'))
})

test('list: each document carries its real processing status; no record is null, never invented', async () => {
  const { body } = await get('/api/documents', tokenA)
  const byId = Object.fromEntries(body.documents.map((d) => [d.id, d]))
  assert.deepEqual(byId[UUID_A1].graphIngestion, { status: 'processed', entityCount: 12, relationshipCount: 7, errorCode: null, processedAt: when.toISOString(), updatedAt: when.toISOString() })
  assert.equal(byId[UUID_A2].graphIngestion.status, 'failed')
  assert.equal(byId[UUID_A2].graphIngestion.errorCode, 'NLP_CHUNK_FAILED')
  assert.equal(byId[UUID_A2].uploader, null)
  assert.equal(byId[UUID_A3].graphIngestion, null)
  assert.equal(byId[UUID_A1].fileType, 'PDF')
  assert.equal(byId[UUID_A2].fileType, 'DOCX')
  assert.equal(byId[UUID_A3].fileType, 'TXT')
})

test('list: internal fields (companyId, pipeline, storage ids, full text) are not exposed, and the query does not select them', async () => {
  calls.length = 0
  const { body } = await get('/api/documents', tokenA)
  const text = JSON.stringify(body)
  for (const secret of ['company-A', 'memhub-nlp-v1-hybrid', 'pid-a1', 'Priya fixed the login issue', '"companyId"', '"pipeline"', '"documentId"', '"extractedText"']) {
    assert.ok(!text.includes(secret), `${secret} must not be sent to the browser`)
  }
  const selected = calls[0].args.select.graphIngestion.select
  assert.ok(!('pipeline' in selected) && !('companyId' in selected), 'the query itself asks only for the public columns')
})

test('detail: own document with processing status and preview; another company\'s document is 404 with no data', async () => {
  const own = await get(`/api/documents/${UUID_A1}`, tokenA)
  assert.equal(own.status, 200)
  assert.equal(own.body.document.graphIngestion.status, 'processed')
  assert.equal(own.body.document.graphIngestion.relationshipCount, 7)
  assert.equal(own.body.document.textLength, DOCS[0].extractedText.length)
  assert.equal(own.body.document.textPreview.length, 1000)

  calls.length = 0
  const foreign = await get(`/api/documents/${UUID_B1}`, tokenA)
  assert.equal(foreign.status, 404)
  assert.equal(foreign.body.message, 'Document not found')
  assert.ok(!JSON.stringify(foreign.body).includes('b-secret'))
  assert.equal(calls[0].args.where.companyId, 'company-A', 'the lookup is scoped to the JWT company')

  const reverse = await get(`/api/documents/${UUID_A1}`, tokenB)
  assert.equal(reverse.status, 404)
})

test('detail: a document without a processing record has graphIngestion null; a bad id is 400', async () => {
  const { body } = await get(`/api/documents/${UUID_A3}`, tokenA)
  assert.equal(body.document.graphIngestion, null)
  assert.equal((await get('/api/documents/not-a-uuid', tokenA)).status, 400)
})
