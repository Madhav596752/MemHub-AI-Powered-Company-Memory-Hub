import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { NlpError, extractChunks, validateExtraction } from './nlpClient.js'

const sent = [{ chunkId: 'd:0', chunkIndex: 0, text: 'Priya resolved the login issue.', startChar: 0, endChar: 31 }]
const good = () => ({
  results: [{
    chunkId: 'd:0', chunkIndex: 99, documentId: 'someone-else',
    entities: [
      { id: 'entity_1', text: 'Priya', type: 'PERSON', normalized: 'Priya', confidence: 0.9, documentStartChar: 0, documentEndChar: 5 },
      { id: 'entity_2', text: 'login issue', type: 'ISSUE', normalized: 'login issue', confidence: 0.94 },
    ],
    relationships: [{ source: 'entity_1', target: 'entity_2', type: 'RESOLVED', confidence: 0.96, evidence: 'Priya resolved the login issue', trigger: 'resolve/fix' }],
  }],
  failed: [],
})

test('a valid answer is accepted; identity comes from OUR chunk list, not from the service', () => {
  const { extractions, dropped } = validateExtraction(good(), 'doc-real', sent)
  assert.equal(dropped, 0)
  assert.equal(extractions[0].documentId, 'doc-real')
  assert.equal(extractions[0].chunkIndex, 0)
  assert.equal(extractions[0].entities[0].startChar, 0)
  assert.equal(extractions[0].entities[1].startChar, null) // no offsets were given -> none are invented
})

test('malformed items are dropped, not trusted', () => {
  const raw = good()
  raw.results[0].entities.push(
    { id: 'entity_3', text: 'X', type: 'ROBOT' }, // unknown type
    { id: 'entity_1', text: 'Dup', type: 'PERSON' }, // duplicate local id
    { id: 'entity_4', text: '  ', type: 'PERSON' }, // empty text
  )
  raw.results[0].relationships.push(
    { source: 'entity_1', target: 'entity_2', type: 'DROP_TABLE', confidence: 0.9, evidence: 'x' }, // type outside the allow-list
    { source: 'entity_1', target: 'entity_77', type: 'USED', confidence: 0.9, evidence: 'x' }, // endpoint does not exist
    { source: 'entity_1', target: 'entity_1', type: 'USED', confidence: 0.9, evidence: 'x' }, // self loop
    { source: 'entity_1', target: 'entity_2', type: 'CREATED', confidence: 0.9 }, // no evidence
    { source: 'entity_1', target: 'entity_2', type: 'CREATED', confidence: 3, evidence: 'x' }, // confidence out of range
  )
  const { extractions, dropped } = validateExtraction(raw, 'd', sent)
  assert.equal(dropped, 8)
  assert.equal(extractions[0].entities.length, 2)
  assert.deepEqual(extractions[0].relationships.map((r) => r.type), ['RESOLVED'])
})

test('structurally broken answers throw NLP_BAD_RESPONSE', () => {
  const bad = [null, 'text', [], {}, { results: 'x' }, { results: [null] }, { results: [{ chunkId: 'unknown:9' }] }, { results: [] }]
  for (const raw of bad) assert.throws(() => validateExtraction(raw, 'd', sent), (e) => e instanceof NlpError && e.code === 'NLP_BAD_RESPONSE', JSON.stringify(raw))
})

test('a chunk reported as failed is returned as failed; a silently missing chunk is an error', () => {
  const { failedChunkIds } = validateExtraction({ results: [], failed: [{ chunkId: 'd:0', code: 'nlp_failed' }] }, 'd', sent)
  assert.deepEqual(failedChunkIds, ['d:0'])
})

// ---------- over HTTP ----------
let mode = 'ok'
let last = null
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    last = { headers: req.headers, raw, body: JSON.parse(raw || '{}') }
    if (mode === 'hang') return // never answers
    if (mode === '401') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"detail":"invalid internal token"}') }
    if (mode === '500') { res.writeHead(500); return res.end('boom') }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(mode === 'garbage' ? '{"nope":1}' : JSON.stringify({ results: last.body.chunks.map((c) => ({ chunkId: c.chunkId, chunkIndex: c.chunkIndex, entities: [], relationships: [] })), failed: [] }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.NLP_SERVICE_URL = `http://127.0.0.1:${server.address().port}`
process.env.NLP_SERVICE_TOKEN = 'nlp-secret-token'
process.env.NLP_TIMEOUT_MS = '300'
test.after(() => { server.closeAllConnections?.(); server.close() })

const expectCode = (promise, status, code) => assert.rejects(promise, (e) => e instanceof NlpError && e.status === status && e.code === code)

test('every call carries the shared token in the header, never in the body; batches respect NLP_BATCH_SIZE', async () => {
  mode = 'ok'
  process.env.NLP_BATCH_SIZE = '2'
  const five = Array.from({ length: 5 }, (_, i) => ({ chunkId: `d:${i}`, chunkIndex: i, text: 'text', startChar: i, endChar: i + 4 }))
  const out = await extractChunks('d', five)
  delete process.env.NLP_BATCH_SIZE
  assert.equal(out.extractions.length, 5)
  assert.equal(last.headers['x-internal-token'], 'nlp-secret-token')
  assert.ok(!last.raw.includes('nlp-secret-token'))
})

test('service errors become safe NlpErrors', async () => {
  mode = '401'; await expectCode(extractChunks('d', sent), 502, 'NLP_SERVICE_MISCONFIGURED')
  mode = '500'; await expectCode(extractChunks('d', sent), 502, 'NLP_FAILED')
  mode = 'garbage'; await expectCode(extractChunks('d', sent), 502, 'NLP_BAD_RESPONSE')
  mode = 'hang'; await expectCode(extractChunks('d', sent), 503, 'NLP_SERVICE_UNAVAILABLE') // timeout
})

test('unreachable service and missing token', async () => {
  const url = process.env.NLP_SERVICE_URL
  process.env.NLP_SERVICE_URL = 'http://127.0.0.1:1'
  await expectCode(extractChunks('d', sent), 503, 'NLP_SERVICE_UNAVAILABLE')
  process.env.NLP_SERVICE_URL = url
  const token = process.env.NLP_SERVICE_TOKEN
  delete process.env.NLP_SERVICE_TOKEN
  await expectCode(extractChunks('d', sent), 503, 'NLP_NOT_CONFIGURED')
  process.env.NLP_SERVICE_TOKEN = token
})
