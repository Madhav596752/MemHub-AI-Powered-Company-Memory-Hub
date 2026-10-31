// processDocumentGraph() through the REAL chunker, nlpClient, graphStore and graphIngest code, with a
// fake NLP HTTP service, a recording fake Neo4j driver and an in-memory stand-in for Prisma.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { clearGraphEnv, makeFakeDriver, setGraphEnv } from '../test-helpers/fakeNeo4j.js'

const statuses = []
mock.module('../prisma.js', {
  defaultExport: { graphIngestion: { upsert: async (args) => { statuses.push(args.update) } } },
})
const { processDocumentGraph } = await import('./graphIngest.js')
const { setDriverForTests } = await import('./neo4j.js')

process.env.CHUNK_SIZE = '100'
process.env.CHUNK_OVERLAP = '20'
const doc = { id: 'doc-1', companyId: 'company-A', originalName: 'notes.txt', extractedText: 'Priya resolved the login issue. '.repeat(8) }

// ---------- fake NLP service ----------
const nlp = { mode: 'ok', requests: 0, sawText: [] }
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', async () => {
    nlp.requests += 1
    const body = JSON.parse(raw)
    nlp.sawText.push(...body.chunks.map((c) => c.text))
    if (nlp.mode === 'slow') await new Promise((r) => setTimeout(r, 80))
    if (nlp.mode === 'down') { res.writeHead(500); return res.end('{}') }
    if (nlp.mode === 'garbage') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"results":"nope"}') }
    const results = []
    const failed = []
    for (const c of body.chunks) {
      if (nlp.mode === 'partial' && c.chunkIndex === 1) { failed.push({ chunkId: c.chunkId, code: 'nlp_failed' }); continue }
      results.push({
        chunkId: c.chunkId, chunkIndex: c.chunkIndex,
        entities: [
          { id: 'entity_1', text: 'Priya', type: 'PERSON', normalized: 'Priya', confidence: 0.9 },
          { id: 'entity_2', text: 'login issue', type: 'ISSUE', normalized: 'login issue', confidence: 0.94 },
        ],
        relationships: nlp.mode === 'norel' ? [] : [{ source: 'entity_1', target: 'entity_2', type: 'RESOLVED', confidence: 0.96, evidence: 'Priya resolved the login issue' }],
      })
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ results, failed }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.NLP_SERVICE_URL = `http://127.0.0.1:${server.address().port}`
process.env.NLP_SERVICE_TOKEN = 'nlp-token'

let fake
function reset(mode = 'ok') {
  nlp.mode = mode; nlp.requests = 0; nlp.sawText = []
  statuses.length = 0
  setGraphEnv()
  fake = makeFakeDriver((cypher) => (cypher.includes('collect(DISTINCT e.uid)') ? [{ uids: [] }] : []))
  setDriverForTests(fake)
}
test.after(() => { server.closeAllConnections?.(); server.close(); setDriverForTests(null); clearGraphEnv() })

test('success: chunks -> NLP -> one Neo4j transaction; status stored; counts reported', async () => {
  reset()
  const r = await processDocumentGraph(doc)
  assert.equal(r.status, 'processed')
  assert.ok(r.chunks >= 2)
  assert.equal(r.entities, 2) // Priya and the login issue, merged across all chunks of THIS document
  assert.equal(fake.state.transactions, 1)
  assert.ok(fake.state.calls.every((c) => c.params.companyId === 'company-A'))
  // the SAME chunks as the vector index were analysed (same chunker, same ids)
  const chunkRows = fake.state.calls.find((c) => c.cypher.includes('MERGE (c:Chunk')).params.chunks
  assert.deepEqual(chunkRows.map((c) => c.chunkId), chunkRows.map((_, i) => `doc-1:${i}`))
  assert.deepEqual(statuses.at(-1), { companyId: 'company-A', status: 'processed', entityCount: 2, relationshipCount: r.relationships, errorCode: null, pipeline: 'memhub-nlp-v1-hybrid', processedAt: statuses.at(-1).processedAt })
})

test('NLP service down: failed + recoverable, graph untouched, never throws', async () => {
  reset('down')
  const r = await processDocumentGraph(doc)
  assert.equal(r.status, 'failed')
  assert.equal(r.code, 'NLP_FAILED')
  assert.equal(fake.state.calls.length, 0, 'no graph write after an NLP failure')
  assert.equal(statuses.at(-1).status, 'failed')
})

test('NLP failed for some chunks: nothing is written, so old facts are not half-replaced', async () => {
  reset('partial')
  const r = await processDocumentGraph(doc)
  assert.deepEqual([r.status, r.code], ['failed', 'NLP_CHUNK_FAILED'])
  assert.equal(fake.state.calls.length, 0)
})

test('malformed NLP output is rejected, not ingested', async () => {
  reset('garbage')
  const r = await processDocumentGraph(doc)
  assert.deepEqual([r.status, r.code], ['failed', 'NLP_BAD_RESPONSE'])
  assert.equal(fake.state.calls.length, 0)
})

test('Neo4j failing during the write: failed with a safe message', async () => {
  reset()
  fake.state.failWith = Object.assign(new Error('internal topology detail'), { code: 'ServiceUnavailable' })
  const r = await processDocumentGraph(doc)
  assert.deepEqual([r.status, r.code], ['failed', 'GRAPH_UNAVAILABLE'])
  assert.doesNotMatch(r.message, /topology/)
})

test('not configured: skipped without calling the NLP service', async () => {
  reset()
  clearGraphEnv()
  assert.deepEqual((({ status, code }) => ({ status, code }))(await processDocumentGraph(doc)), { status: 'skipped', code: 'GRAPH_NOT_CONFIGURED' })
  setGraphEnv()
  const token = process.env.NLP_SERVICE_TOKEN
  delete process.env.NLP_SERVICE_TOKEN
  assert.deepEqual((({ status, code }) => ({ status, code }))(await processDocumentGraph(doc)), { status: 'skipped', code: 'NLP_NOT_CONFIGURED' })
  process.env.NLP_SERVICE_TOKEN = token
  assert.equal(nlp.requests, 0)
})

test('document without text: skipped', async () => {
  reset()
  const r = await processDocumentGraph({ ...doc, extractedText: '  \n ' })
  assert.deepEqual([r.status, r.code], ['skipped', 'NO_TEXT'])
})

test('reprocessing the same document twice replaces, never accumulates', async () => {
  reset()
  await processDocumentGraph(doc)
  const first = fake.state.calls.map((c) => JSON.stringify([c.cypher, c.params]))
  fake.state.calls.length = 0
  await processDocumentGraph(doc)
  const second = fake.state.calls.map((c) => JSON.stringify([c.cypher, c.params]))
  assert.deepEqual(second, first, 'identical statements and ids on the second run')
  assert.equal(fake.state.transactions, 2)
  assert.ok(second.some((s) => s.includes('DELETE r')), 'every run starts by removing this document\'s old facts')
})

test('two simultaneous runs for one document share a single run (no duplicate processing)', async () => {
  reset('slow')
  const [a, b] = await Promise.all([processDocumentGraph(doc), processDocumentGraph(doc)])
  assert.equal(a, b)
  assert.equal(fake.state.transactions, 1)
  assert.equal(nlp.requests, Math.ceil(a.chunks / 25))
})

test('document text is never written to the logs', async () => {
  reset()
  const lines = []
  const orig = { log: console.log, error: console.error, warn: console.warn }
  console.log = console.error = console.warn = (...a) => lines.push(a.join(' '))
  try { await processDocumentGraph(doc); reset('down'); await processDocumentGraph(doc) } finally { Object.assign(console, orig) }
  assert.ok(lines.length > 0)
  assert.ok(!lines.join('\n').includes('resolved the login issue'))
})

test('entities without any relationship: processed, but relationshipStatus says "none" (not a failure, not a fake edge)', async () => {
  reset('norel')
  const r = await processDocumentGraph(doc)
  assert.deepEqual([r.status, r.entities, r.relationships, r.relationshipStatus], ['processed', 2, 0, 'none'])
  assert.equal(statuses.at(-1).relationshipCount, 0)
  assert.equal(fake.state.calls.some((c) => c.cypher.includes('MERGE (s)-[r:')), false, 'no relationship statement is sent')
})

test('relationshipStatus is "extracted" when the text stated relationships, "not_run" when the run failed', async () => {
  reset()
  assert.equal((await processDocumentGraph(doc)).relationshipStatus, 'extracted')
  reset('down')
  assert.equal((await processDocumentGraph(doc)).relationshipStatus, 'not_run')
})

test('a failed run only changes the status: counts of the last good run are not reset while the graph still holds them', async () => {
  reset('down')
  await processDocumentGraph(doc)
  assert.deepEqual(Object.keys(statuses.at(-1)).sort(), ['companyId', 'errorCode', 'status'])
  assert.equal(statuses.at(-1).status, 'failed')
})
