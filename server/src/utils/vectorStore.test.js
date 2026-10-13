// Tests the Node vector-store client against a FAKE HTTP service. This checks what the client
// sends (always the company ID), how it maps results and how it reports errors. It does NOT
// run ChromaDB or the real model; see rag.integration.test.js for that.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { indexDocument, searchChunks, deleteDocumentChunks, RagError } from './vectorStore.js'

function startFake(handler) {
  const requests = []
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null
        requests.push({ method: req.method, url: req.url, body })
        handler({ method: req.method, url: req.url, body }, res)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      process.env.EMBEDDING_SERVICE_URL = `http://127.0.0.1:${server.address().port}`
      resolve({ server, requests })
    })
  })
}
const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const longText = Array.from({ length: 600 }, (_, i) => `sentence number ${i} about refunds.`).join(' ')
const doc = { id: 'doc-1', companyId: 'company-A', originalName: 'policy.pdf', extractedText: longText }

test('indexDocument sends every chunk with the company and document id', async () => {
  const { server, requests } = await startFake(({ body }, res) => reply(res, 200, { chunksStored: body.chunks.length }))
  const stored = await indexDocument(doc)
  assert.ok(stored > 1)
  const [req] = requests
  assert.equal(req.method, 'POST')
  assert.equal(req.url, '/index')
  assert.equal(req.body.companyId, 'company-A')
  assert.equal(req.body.documentId, 'doc-1')
  assert.equal(req.body.documentName, 'policy.pdf')
  assert.equal(req.body.chunks.length, stored)
  assert.ok(req.body.chunks.every((c) => c.text.trim())) // no empty chunks
  server.close()
})

test('indexDocument with empty text fails with 422 and never calls the service', async () => {
  const { server, requests } = await startFake((_, res) => reply(res, 200, {}))
  for (const extractedText of ['', '   \n\n  ']) {
    await assert.rejects(indexDocument({ ...doc, extractedText }), (err) => err instanceof RagError && err.status === 422)
  }
  assert.equal(requests.length, 0)
  server.close()
})

test('indexDocument does not report success if fewer chunks were stored than sent', async () => {
  const { server } = await startFake((_, res) => reply(res, 200, { chunksStored: 1 }))
  await assert.rejects(indexDocument(doc), (err) => err instanceof RagError && err.status === 502 && err.code === 'VECTOR_STORE_FAILED')
  server.close()
})

test('service errors become a safe RagError without internal details', async () => {
  const { server } = await startFake((_, res) => reply(res, 500, { detail: 'chromadb exploded at /secret/path' }))
  await assert.rejects(indexDocument(doc), (err) => {
    assert.ok(err instanceof RagError)
    assert.equal(err.status, 502)
    assert.equal(err.code, 'VECTOR_STORE_FAILED')
    assert.doesNotMatch(err.message, /chromadb|secret|path|500/i)
    return true
  })
  server.close()
})

test('unreachable service gives a 503 RagError without the URL', async () => {
  process.env.EMBEDDING_SERVICE_URL = 'http://127.0.0.1:1'
  await assert.rejects(searchChunks('company-A', 'refunds', 5), (err) => {
    assert.ok(err instanceof RagError)
    assert.equal(err.status, 503)
    assert.doesNotMatch(err.message, /127\.0\.0\.1/)
    return true
  })
})

test('searchChunks sends the company id and maps results with a score', async () => {
  const { server, requests } = await startFake((_, res) =>
    reply(res, 200, {
      results: [
        { text: 'Refunds take 14 days.', distance: 0.25, metadata: { documentId: 'doc-1', documentName: 'policy.pdf', chunkIndex: 3, startChar: 10, endChar: 40, companyId: 'company-A' } },
      ],
    })
  )
  const results = await searchChunks('company-A', 'refund time', 3)
  assert.deepEqual(requests[0].body, { companyId: 'company-A', query: 'refund time', topK: 3 })
  assert.equal(results.length, 1)
  assert.equal(results[0].documentId, 'doc-1')
  assert.equal(results[0].documentName, 'policy.pdf')
  assert.equal(results[0].score, 0.75)
  assert.equal(results[0].distance, 0.25)
  assert.equal(results[0].startChar, 10)
  assert.equal('companyId' in results[0], false) // internal metadata is not passed on
  server.close()
})

test('searchChunks handles an empty result list', async () => {
  const { server } = await startFake((_, res) => reply(res, 200, { results: [] }))
  assert.deepEqual(await searchChunks('company-A', 'nothing matches', 5), [])
  server.close()
})

test('searchChunks rejects a malformed service response', async () => {
  const { server } = await startFake((_, res) => reply(res, 200, { nope: true }))
  await assert.rejects(searchChunks('company-A', 'x', 5), RagError)
  server.close()
})

test('deleteDocumentChunks is scoped by company id and url-encodes its parts', async () => {
  const { server, requests } = await startFake((_, res) => reply(res, 200, { deleted: true }))
  await deleteDocumentChunks('company A', 'doc/../1')
  assert.equal(requests[0].method, 'DELETE')
  assert.equal(requests[0].url, '/documents/doc%2F..%2F1?companyId=company%20A')
  server.close()
})

// ---------- failure reporting: each cause gets its own status + code ----------

async function failureWith(status, body) {
  const { server } = await startFake((_, res) => reply(res, status, body))
  try {
    return await indexDocument(doc).then(() => null, (err) => err)
  } finally {
    server.close()
  }
}

test('embedding failure in the Python service -> 503 EMBEDDING_FAILED', async () => {
  const err = await failureWith(503, { detail: 'embedding_failed' })
  assert.ok(err instanceof RagError)
  assert.equal(err.status, 503)
  assert.equal(err.code, 'EMBEDDING_FAILED')
})

test('ChromaDB failure in the Python service -> 502 VECTOR_STORE_FAILED', async () => {
  const err = await failureWith(500, { detail: 'chroma_failed' })
  assert.equal(err.status, 502)
  assert.equal(err.code, 'VECTOR_STORE_FAILED')
})

test('service rejecting our token -> 502 VECTOR_SERVICE_MISCONFIGURED (no token value in the message)', async () => {
  process.env.EMBEDDING_SERVICE_TOKEN = 'super-secret-token-value'
  const err = await failureWith(401, { detail: 'invalid internal token' })
  assert.equal(err.status, 502)
  assert.equal(err.code, 'VECTOR_SERVICE_MISCONFIGURED')
  assert.doesNotMatch(err.message, /super-secret-token-value/)
})

test('unreachable service -> 503 EMBEDDING_SERVICE_UNAVAILABLE', async () => {
  const { server } = await startFake((_, res) => reply(res, 200, {}))
  server.close()
  await new Promise((r) => setTimeout(r, 20))
  const err = await indexDocument(doc).then(() => null, (e) => e)
  assert.equal(err.status, 503)
  assert.equal(err.code, 'EMBEDDING_SERVICE_UNAVAILABLE')
})

test('empty text -> 422 NO_TEXT', async () => {
  const err = await indexDocument({ ...doc, extractedText: '   ' }).then(() => null, (e) => e)
  assert.equal(err.status, 422)
  assert.equal(err.code, 'NO_TEXT')
})

test('every call to the Python service carries the shared token, and it is never in the body', async () => {
  process.env.EMBEDDING_SERVICE_TOKEN = 'token-for-header-test'
  const seen = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      seen.push({ token: req.headers['x-internal-token'], raw })
      reply(res, 200, req.url === '/search' ? { results: [] } : { chunksStored: JSON.parse(raw || '{"chunks":[]}').chunks?.length ?? 0, deleted: true })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.EMBEDDING_SERVICE_URL = `http://127.0.0.1:${server.address().port}`
  try {
    await indexDocument(doc)
    await searchChunks('company-A', 'refunds', 3)
    await deleteDocumentChunks('company-A', 'doc-1')
  } finally {
    server.close()
  }
  assert.equal(seen.length, 3)
  assert.ok(seen.every((r) => r.token === 'token-for-header-test'))
  assert.ok(seen.every((r) => !r.raw.includes('token-for-header-test')))
})
