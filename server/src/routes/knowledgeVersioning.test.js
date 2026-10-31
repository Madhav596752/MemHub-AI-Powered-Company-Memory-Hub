// Module 9.4 through the REAL Express routers (documents, graph), the REAL JWT / permission middleware, the REAL
// version module and the REAL answer cache. Faked: Prisma, Redis, Cloudinary, the vector service, the NLP/graph
// ingestion and Neo4j writes (each can be told to succeed or fail). They prove WHEN the knowledge-base version advances,
// when it must not, that nothing is cached while a change is in flight, and that old cache entries become unreachable.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import jwt from 'jsonwebtoken'
import { fakeKnowledgeState } from '../test-helpers/fakeKnowledgeState.js'

process.env.JWT_ACCESS_SECRET = 'unit-test-access-secret'
delete process.env.REDIS_URL // set per test, after the routers are imported
delete process.env.NEO4J_URI

const DOC_ID = '11111111-1111-4111-8111-111111111111'
const NEW_ID = '33333333-3333-4333-8333-333333333333'

// ---------- fakes ----------
class RagError extends Error {
  constructor(message, status = 503, code = 'EMBEDDING_SERVICE_UNAVAILABLE') { super(message); this.name = 'RagError'; this.status = status; this.code = code }
}
const knowledge = fakeKnowledgeState()
const db = {}
function resetDb() {
  db.users = [
    { id: 'admin-A', companyId: 'company-A', role: 'ADMIN' },
    { id: 'member-A', companyId: 'company-A', role: 'MEMBER' },
  ]
  db.docs = [{
    id: DOC_ID, companyId: 'company-A', originalName: 'refund.txt', cloudinaryPublicId: 'pid-1', extractedText: 'Refunds are paid within 14 days.',
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  }]
  db.failCreate = false
  knowledge.state.leases.length = 0
  knowledge.state.versions.clear()
  knowledge.state.advances.length = 0
  for (const k of ['failRead', 'failCreate', 'failAdvance', 'failRelease']) knowledge.state[k] = false
}
resetDb()

const agg = (rows) => async ({ where }) => {
  const mine = rows().filter((r) => r.companyId === where.companyId)
  const newest = mine.map((r) => r.updatedAt).filter(Boolean).sort((a, b) => b - a)[0] ?? null
  return { _count: { _all: mine.length }, _max: { updatedAt: newest } }
}
mock.module('../prisma.js', {
  defaultExport: {
    ...knowledge.models,
    user: { findUnique: async ({ where }) => db.users.find((u) => u.id === where.id) ?? null },
    document: {
      aggregate: agg(() => db.docs),
      findFirst: async ({ where }) => db.docs.find((d) => d.id === where.id && d.companyId === where.companyId) ?? null,
      create: async ({ data }) => {
        if (db.failCreate) throw new Error('db down')
        const row = { id: NEW_ID, ...data, uploader: { id: data.uploadedBy, name: 'Admin' }, createdAt: new Date(), updatedAt: new Date() }
        db.docs.push(row)
        return row
      },
      deleteMany: async ({ where }) => {
        const before = db.docs.length
        db.docs = db.docs.filter((d) => !(d.id === where.id && d.companyId === where.companyId))
        return { count: before - db.docs.length }
      },
    },
    graphIngestion: { aggregate: agg(() => []) },
  },
})

// What each external store does next. `inflight` runs INSIDE the call, i.e. while the change is in flight.
const store = { index: null, deleteChunks: null, graphRun: null, graphDelete: null, inflight: null, cloudinaryDeleted: [], calls: [] }
function resetStores() {
  store.index = async () => 3
  store.deleteChunks = async () => {}
  store.graphRun = async () => ({ status: 'processed', entities: 2, relationships: 1, relationshipStatus: 'extracted', chunks: 1 })
  store.graphDelete = async () => ({ skipped: false })
  store.inflight = null
  store.cloudinaryDeleted = []
  store.calls = []
}
resetStores()
const step = async (name, fn, ...args) => {
  store.calls.push(name)
  if (store.inflight) await store.inflight(name)
  return fn(...args)
}
mock.module('../cloudinary.js', {
  namedExports: {
    isCloudinaryConfigured: () => true,
    uploadDocumentFile: async () => ({ url: 'https://files.example/x.txt', publicId: 'pid-new' }),
    deleteDocumentFile: async (id) => { store.cloudinaryDeleted.push(id) },
  },
})
mock.module('../utils/vectorStore.js', {
  namedExports: {
    RagError,
    MAX_SEARCH_LIMIT: 20,
    indexDocument: (doc) => step('index', store.index, doc),
    deleteDocumentChunks: (c, d) => step('deleteChunks', store.deleteChunks, c, d),
    searchChunks: async () => [],
  },
})
mock.module('../utils/graphIngest.js', { namedExports: { processDocumentGraph: (doc) => step('graphRun', store.graphRun, doc) } })
mock.module('../utils/graphStore.js', {
  namedExports: {
    deleteDocumentGraph: (c, d) => step('graphDelete', store.graphDelete, c, d),
    getGraphOverview: async () => ({}),
    getEntityDetail: async () => null,
  },
})

const { default: express } = await import('express')
const { default: documentsRouter } = await import('./documents.js')
const { default: graphRouter } = await import('./graph.js')
const { initRedisCache, closeRedisCache, setRedisClientFactoryForTests } = await import('../utils/redisCache.js')
const { prepareAskCache } = await import('../utils/askCache.js')
const { knowledgeBaseVersion } = await import('../utils/knowledgeVersion.js')

function fakeRedis() {
  const data = new Map()
  const c = new EventEmitter()
  c.isOpen = false
  c.isReady = false
  c.connect = async () => { c.isOpen = true; c.isReady = true; c.emit('ready') }
  c.get = async (key) => (data.has(key) ? data.get(key) : null)
  c.sendCommand = async (args) => {
    const [, key, value, ...opts] = args
    if (opts.includes('NX') && data.has(key)) return null
    data.set(key, value)
    return 'OK'
  }
  c.ping = async () => 'PONG'
  c.quit = async () => { c.isOpen = false; c.isReady = false }
  c.disconnect = c.quit
  return { client: c, data }
}

const app = express()
app.use(express.json())
app.use('/api/documents', documentsRouter)
app.use('/api/graph', graphRouter)
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => { server.closeAllConnections?.(); server.close() })

const sign = (userId, companyId, role) => jwt.sign({ userId, companyId, role }, process.env.JWT_ACCESS_SECRET, { algorithm: 'HS256' })
const admin = sign('admin-A', 'company-A', 'ADMIN')
const member = sign('member-A', 'company-A', 'MEMBER')
const auth = (t) => ({ Authorization: `Bearer ${t}` })

let fake
let restoreLogs
test.beforeEach(async () => {
  resetDb()
  resetStores()
  process.env.REDIS_URL = 'redis://127.0.0.1:6379'
  process.env.REDIS_CONNECT_TIMEOUT = '100'
  for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {})
  fake = fakeRedis()
  setRedisClientFactoryForTests(() => fake.client)
  await initRedisCache()
})
test.afterEach(async () => {
  await closeRedisCache()
  setRedisClientFactoryForTests(null)
  mock.restoreAll()
  delete process.env.REDIS_URL
  delete process.env.REDIS_CONNECT_TIMEOUT
  delete process.env.KB_UNCERTAIN_GRACE_SECONDS
})

// ---------- helpers ----------
const kbOf = () => knowledgeBaseVersion({ ...knowledge.models, document: { aggregate: agg(() => db.docs) }, graphIngestion: { aggregate: agg(() => []) } }, 'company-A')
const counter = () => knowledge.counter('company-A')
const upload = (name = 'notes.txt', content = 'Priya fixed the login issue on Monday.') => {
  const fd = new FormData()
  fd.append('file', new Blob([content], { type: 'text/plain' }), name)
  return fetch(`${base}/api/documents`, { method: 'POST', headers: auth(admin), body: fd })
}
const reindex = () => fetch(`${base}/api/documents/${DOC_ID}/reindex`, { method: 'POST', headers: auth(admin) })
const remove = () => fetch(`${base}/api/documents/${DOC_ID}`, { method: 'DELETE', headers: auth(admin) })
const reprocess = () => fetch(`${base}/api/graph/documents/${DOC_ID}/reprocess`, { method: 'POST', headers: auth(admin) })

const GOOD = () => ({
  success: true, grounded: true, answer: 'Refunds within 14 days [1].',
  sources: [{ ref: 1, kind: 'chunk', documentId: DOC_ID, documentName: 'refund.txt', chunkIndex: 0, text: 'Refunds are paid within 14 days.', startChar: 0, endChar: 32, score: 0.9 }],
  retrieval: { vector: { status: 'ok', chunks: 1 }, graph: { status: 'disabled', facts: 0 } },
})
const CONFIG = { topK: 5, minScore: 0.25, maxContextChars: 6000, graph: { enabled: false }, model: 'm' }
const askHandle = () => prepareAskCache({
  prisma: { ...knowledge.models, user: { findUnique: async ({ where }) => db.users.find((u) => u.id === where.id) ?? null }, document: { aggregate: agg(() => db.docs) }, graphIngestion: { aggregate: agg(() => []) } },
  user: { userId: 'member-A', companyId: 'company-A', role: 'MEMBER' }, question: 'How fast are refunds?', config: CONFIG,
})
async function warmAnswer() {
  const h = await askHandle()
  assert.ok(h, 'cache is active before the change')
  await h.store(GOOD())
  assert.ok(await (await askHandle()).lookup(), 'warm: the answer is served from the cache')
}

// ---------- upload ----------

test('upload: while it runs the caches are off; when it succeeds the version advances once and old answers are unreachable', async () => {
  await warmAnswer()
  const before = await kbOf()
  const seen = {}
  store.inflight = async (name) => { seen[name] = { kb: await kbOf(), handle: await askHandle(), leases: knowledge.state.leases.length } }

  const res = await upload()
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.equal(body.indexing.status, 'indexed')
  assert.equal(body.graph.status, 'processed')

  for (const name of ['index', 'graphRun']) {
    assert.equal(seen[name].leases, 1, `${name}: lease held`)
    assert.equal(seen[name].kb, null, `${name}: no version while in flight`)
    assert.equal(seen[name].handle, null, `${name}: no answer cache while in flight`)
  }
  assert.equal(counter(), 1, 'advanced exactly once')
  assert.equal(knowledge.state.leases.length, 0, 'lease released')
  const after = await kbOf()
  assert.notEqual(after, before)
  assert.equal(await (await askHandle()).lookup(), null, 'the answer cached before the upload is unreachable')
})

test('upload: the version is advanced BEFORE the 201 is sent', async () => {
  const res = await upload()
  assert.equal(res.status, 201)
  assert.equal(counter(), 1)
  assert.equal(knowledge.state.leases.length, 0)
})

test('upload where the row cannot be saved: nothing was published, version unchanged, lease released', async () => {
  await warmAnswer()
  db.failCreate = true
  const res = await upload()
  assert.equal(res.status, 500)
  assert.equal(counter(), 0, 'a failed upload must not advance the version')
  assert.equal(knowledge.state.leases.length, 0)
  assert.deepEqual(store.cloudinaryDeleted, ['pid-new'], 'the orphaned file is removed again')
  assert.ok(await (await askHandle()).lookup(), 'valid cached answers survive a failed upload')
  assert.deepEqual(store.calls, [], 'nothing reached ChromaDB or Neo4j')
})

test('upload where indexing fails before ChromaDB was touched: the row exists, so the version advances; the answer cache stays consistent', async () => {
  store.index = async () => { throw new RagError('The embedding service could not process the text.', 503, 'EMBEDDING_FAILED') }
  const res = await upload()
  assert.equal(res.status, 201)
  assert.equal((await res.json()).indexing.status, 'failed')
  assert.equal(counter(), 1, 'the PostgreSQL row is part of the knowledge base: the state changed')
  assert.equal(knowledge.state.leases.length, 0)
  assert.ok(await kbOf(), 'caching is allowed again, over the settled state')
})

test('upload where indexing times out: version advances AND the caches stay off for the grace period (a late write may still land)', async () => {
  process.env.KB_UNCERTAIN_GRACE_SECONDS = '60'
  store.index = async () => { throw new RagError('The embedding service is currently unavailable.', 503, 'EMBEDDING_SERVICE_UNAVAILABLE') }
  const res = await upload()
  assert.equal(res.status, 201)
  assert.equal(counter(), 1)
  assert.equal(knowledge.state.leases.length, 1, 'quarantine lease')
  assert.equal(await kbOf(), null, 'no caching while the outcome is unknown')

  knowledge.state.leases[0].expiresAt = new Date(Date.now() - 1)
  assert.ok(await kbOf())
  assert.equal(counter(), 2, 'advanced again when the grace period ended')
})

test('upload where the vector index worked but the graph failed before writing: the version advances (vectors changed), once', async () => {
  store.graphRun = async () => ({ status: 'failed', code: 'NLP_SERVICE_UNAVAILABLE', entities: 0, relationships: 0, relationshipStatus: 'not_run' })
  const res = await upload()
  assert.equal(res.status, 201)
  assert.equal((await res.json()).graph.status, 'failed')
  assert.equal(counter(), 1)
})

// ---------- reindex ----------

test('reindex success advances the version and makes cached answers unreachable', async () => {
  await warmAnswer()
  assert.equal((await reindex()).status, 200)
  assert.equal(counter(), 1)
  assert.equal(knowledge.state.leases.length, 0)
  assert.equal(await (await askHandle()).lookup(), null)
})

test('reindex that fails before ChromaDB was touched does NOT advance the version; cached answers stay valid', async () => {
  await warmAnswer()
  for (const code of ['EMBEDDING_FAILED', 'NO_TEXT', 'VECTOR_SERVICE_MISCONFIGURED']) {
    store.index = async () => { throw new RagError('failed', 502, code) }
    const res = await reindex()
    assert.equal(res.status, 502, code)
    assert.equal(counter(), 0, `${code}: version unchanged`)
    assert.equal(knowledge.state.leases.length, 0, `${code}: lease released`)
  }
  assert.ok(await (await askHandle()).lookup(), 'the cached answer is still served')
})

test('reindex that fails inside ChromaDB advances the version (the old chunks may already be gone)', async () => {
  await warmAnswer()
  store.index = async () => { throw new RagError('The vector database failed.', 502, 'VECTOR_STORE_FAILED') }
  assert.equal((await reindex()).status, 502)
  assert.equal(counter(), 1)
  assert.equal(knowledge.state.leases.length, 0)
  assert.equal(await (await askHandle()).lookup(), null)
})

test('reindex that times out advances the version and quarantines the company', async () => {
  store.index = async () => { throw new RagError('unavailable', 503, 'EMBEDDING_SERVICE_UNAVAILABLE') }
  assert.equal((await reindex()).status, 503)
  assert.equal(counter(), 1)
  assert.equal(knowledge.state.leases.length, 1)
  assert.equal(await kbOf(), null)
})

test('reindex of another company\'s or unknown document: 404, no lease, no version change', async () => {
  const res = await fetch(`${base}/api/documents/${NEW_ID}/reindex`, { method: 'POST', headers: auth(admin) })
  assert.equal(res.status, 404)
  assert.equal(counter(), 0)
  assert.equal(knowledge.state.leases.length, 0)
})

test('a member (no document:reindex permission) is refused before any change begins', async () => {
  const res = await fetch(`${base}/api/documents/${DOC_ID}/reindex`, { method: 'POST', headers: auth(member) })
  assert.equal(res.status, 403)
  assert.equal(counter(), 0)
  assert.equal(knowledge.state.leases.length, 0)
})

// ---------- delete ----------

test('delete: vectors, graph, file and row are removed; the version advances once; cached answers citing the document are unreachable', async () => {
  await warmAnswer()
  const seen = {}
  store.inflight = async (name) => { seen[name] = await askHandle() }
  const res = await remove()
  assert.equal(res.status, 200)
  assert.deepEqual(store.calls, ['deleteChunks', 'graphDelete'])
  assert.deepEqual(store.cloudinaryDeleted, ['pid-1'])
  assert.equal(db.docs.length, 0)
  assert.equal(counter(), 1)
  assert.equal(knowledge.state.leases.length, 0)
  assert.equal(seen.deleteChunks, null, 'no cache while the delete is in flight')
  assert.equal(seen.graphDelete, null)
  assert.equal(await (await askHandle()).lookup(), null)
})

test('delete that fails in Neo4j AFTER the vectors were removed: the row is kept for a retry, but the version advances', async () => {
  await warmAnswer()
  store.graphDelete = async () => { throw Object.assign(new Error('graph query failed'), { name: 'GraphError', status: 502, code: 'GRAPH_QUERY_FAILED' }) }
  const res = await remove()
  assert.equal(res.status, 500)
  assert.equal(db.docs.length, 1, 'row kept so the delete can be retried')
  assert.deepEqual(store.cloudinaryDeleted, [], 'the file is kept too')
  assert.equal(counter(), 1, 'the vectors are already gone: cached answers citing this document must not be served')
  assert.equal(knowledge.state.leases.length, 0)
  assert.equal(await (await askHandle()).lookup(), null)

  // the retry succeeds and advances again
  store.graphDelete = async () => ({ skipped: false })
  assert.equal((await remove()).status, 200)
  assert.equal(counter(), 2)
})

test('delete that fails on the very first step without deleting anything leaves the version alone', async () => {
  await warmAnswer()
  store.deleteChunks = async () => { throw new RagError('rejected', 502, 'VECTOR_SERVICE_MISCONFIGURED') }
  assert.equal((await remove()).status, 502)
  assert.equal(db.docs.length, 1)
  assert.equal(counter(), 0)
  assert.equal(knowledge.state.leases.length, 0)
  assert.ok(await (await askHandle()).lookup())
})

test('delete with Neo4j not configured: the graph step is a no-op and does not count as a change by itself', async () => {
  store.deleteChunks = async () => { throw new RagError('rejected', 502, 'VECTOR_SERVICE_MISCONFIGURED') }
  store.graphDelete = async () => ({ skipped: true })
  await remove()
  assert.equal(counter(), 0)
})

// ---------- graph reprocess ----------

test('reprocess that rewrote the graph advances the version; graph and answer caches both become unreachable', async () => {
  await warmAnswer()
  assert.equal((await reprocess()).status, 200)
  assert.equal(counter(), 1)
  assert.equal(knowledge.state.leases.length, 0)
  assert.equal(await (await askHandle()).lookup(), null)
})

test('reprocess that failed before writing (NLP down / chunk failed / skipped) does NOT advance the version', async () => {
  await warmAnswer()
  for (const result of [
    { status: 'failed', code: 'NLP_CHUNK_FAILED' },
    { status: 'failed', code: 'NLP_SERVICE_UNAVAILABLE' },
    { status: 'skipped', code: 'NLP_NOT_CONFIGURED' },
    { status: 'failed', code: 'GRAPH_QUERY_FAILED' }, // Neo4j rolled the transaction back
  ]) {
    store.graphRun = async () => ({ entities: 0, relationships: 0, relationshipStatus: 'not_run', ...result })
    assert.equal((await reprocess()).status, 200, result.code)
    assert.equal(counter(), 0, `${result.code}: version unchanged`)
    assert.equal(knowledge.state.leases.length, 0)
  }
  assert.ok(await (await askHandle()).lookup(), 'valid cached answers survive failed reprocessing')
})

test('reprocess that lost the Neo4j connection (outcome unknown) advances the version and quarantines the company', async () => {
  store.graphRun = async () => ({ status: 'failed', code: 'GRAPH_UNAVAILABLE', entities: 0, relationships: 0, relationshipStatus: 'not_run' })
  assert.equal((await reprocess()).status, 200)
  assert.equal(counter(), 1)
  assert.equal(knowledge.state.leases.length, 1)
  assert.equal(await kbOf(), null)
})

// ---------- bookkeeping failures never break the user's operation ----------

test('PostgreSQL cannot record the change (e.g. migration not applied): the upload still works, caches stay off, Redis epoch is rotated', async () => {
  knowledge.state.failCreate = true
  knowledge.state.failRead = true
  const res = await upload()
  assert.equal(res.status, 201)
  assert.equal(await kbOf(), null, 'without the durable state there is no cache')
  assert.equal(await askHandle(), null)
})

test('the version cannot be advanced at the end: the lease is kept, caches stay off until it expires, then the version advances', async () => {
  knowledge.state.failAdvance = true
  assert.equal((await upload()).status, 201)
  assert.equal(knowledge.state.leases.length, 1)
  assert.equal(await kbOf(), null)
  knowledge.state.failAdvance = false
  knowledge.state.leases[0].expiresAt = new Date(Date.now() - 1)
  assert.ok(await kbOf())
  assert.equal(counter(), 1)
})
