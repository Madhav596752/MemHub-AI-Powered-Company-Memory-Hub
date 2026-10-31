// GET /api/graph/status is what the Dashboard uses for its document counts.
// This checks, through the REAL router and JWT middleware, that the counts are scoped to the company in
// the token: a companyId in the query string, a header or a body is ignored, and nothing is read without a token.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { clearGraphEnv, makeFakeDriver, setGraphEnv } from '../test-helpers/fakeNeo4j.js'

process.env.JWT_ACCESS_SECRET = 'unit-test-access-secret'

const seen = [] // every companyId the database layer was asked about
const note = (where) => { seen.push(where?.companyId) }
const TOTALS = { 'company-A': 7, 'company-B': 2 }
const BY_STATUS = {
  'company-A': [{ status: 'processed', _count: { _all: 4 } }, { status: 'failed', _count: { _all: 1 } }, { status: 'skipped', _count: { _all: 1 } }],
  'company-B': [{ status: 'processed', _count: { _all: 2 } }],
}
mock.module('../prisma.js', {
  defaultExport: {
    document: { count: async ({ where }) => { note(where); return TOTALS[where.companyId] ?? 0 } },
    graphIngestion: {
      groupBy: async ({ where }) => { note(where); return BY_STATUS[where.companyId] ?? [] },
      count: async ({ where }) => { note(where); return where.companyId === 'company-A' ? 1 : 0 },
    },
  },
})

const { default: express } = await import('express')
const { default: graphRouter } = await import('./graph.js')
const { setDriverForTests } = await import('../utils/neo4j.js')

const app = express()
app.use(express.json())
app.use('/api/graph', graphRouter)
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
const token = (companyId, role = 'MEMBER') => jwt.sign({ userId: `user-${companyId}`, companyId, role }, process.env.JWT_ACCESS_SECRET, { algorithm: 'HS256' })
const get = async (path, tok, headers = {}) => {
  const res = await fetch(base + path, { headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers } })
  return { status: res.status, body: await res.json() }
}

test.before(() => { setGraphEnv(); setDriverForTests(makeFakeDriver(() => [])) })
test.beforeEach(() => { seen.length = 0 })
test.after(() => { server.closeAllConnections?.(); server.close(); setDriverForTests(null); clearGraphEnv() })

test('status: no token -> 401 and the database is never read', async () => {
  assert.equal((await get('/api/graph/status')).status, 401)
  assert.equal((await get('/api/graph/status', 'garbage')).status, 401)
  assert.deepEqual(seen, [])
})

test('status: company A gets only its own counts, and only company A is queried', async () => {
  const { status, body } = await get('/api/graph/status', token('company-A'))
  assert.equal(status, 200)
  assert.deepEqual(body.documents, { total: 7, processed: 4, failed: 1, skipped: 1, notProcessed: 1, processedWithoutRelationships: 1 })
  assert.ok(seen.length >= 3)
  assert.ok(seen.every((c) => c === 'company-A'), `unexpected company in ${JSON.stringify(seen)}`)
})

test('status: a companyId in the query string, a header or a ?companyId[]= array cannot switch company', async () => {
  const { body } = await get('/api/graph/status?companyId=company-B&companyId[]=company-B', token('company-A'), { 'x-company-id': 'company-B', 'x-forwarded-company': 'company-B' })
  assert.equal(body.documents.total, 7)
  assert.ok(seen.every((c) => c === 'company-A'))
})

test('status: company B sees its own different numbers (no bleed between tenants)', async () => {
  const b = await get('/api/graph/status', token('company-B'))
  assert.deepEqual(b.body.documents, { total: 2, processed: 2, failed: 0, skipped: 0, notProcessed: 0, processedWithoutRelationships: 0 })
  assert.ok(seen.every((c) => c === 'company-B'))
})

test('status: a company with no documents gets real zeros', async () => {
  const { body } = await get('/api/graph/status', token('company-C'))
  assert.deepEqual(body.documents, { total: 0, processed: 0, failed: 0, skipped: 0, notProcessed: 0, processedWithoutRelationships: 0 })
})

test('status: the response contains counts only (no document names, ids or other company data)', async () => {
  const { body } = await get('/api/graph/status', token('company-A'))
  assert.deepEqual(Object.keys(body).sort(), ['connected', 'documents', 'enabled', 'success'])
  assert.ok(Object.values(body.documents).every((v) => typeof v === 'number'))
})
