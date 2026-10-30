// Tests the Node client against a fake HTTP service. This checks the client's request
// handling and error handling only; it does NOT run the real MiniLM model.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { embedTexts, embedQuery, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from './embeddings.js'

function startFake(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => handler(JSON.parse(raw || '{}'), res))
    })
    server.listen(0, '127.0.0.1', () => {
      process.env.EMBEDDING_SERVICE_URL = `http://127.0.0.1:${server.address().port}`
      resolve(server)
    })
  })
}
const reply = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const good = (texts) => ({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, embeddings: texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0.1)) })

test('embeds in batches and keeps order/count', async () => {
  let calls = 0
  const server = await startFake((body, res) => { calls++; reply(res, 200, good(body.texts)) })
  const texts = Array.from({ length: 70 }, (_, i) => `text ${i}`)
  const vectors = await embedTexts(texts)
  assert.equal(vectors.length, 70)
  assert.equal(calls, 3) // 32 + 32 + 6
  assert.equal((await embedQuery('hi')).length, EMBEDDING_DIMENSIONS)
  server.close()
})

test('rejects a service running a different model', async () => {
  const server = await startFake((body, res) => reply(res, 200, { ...good(body.texts), model: 'other/model' }))
  await assert.rejects(embedTexts(['x']), /expected sentence-transformers\/all-MiniLM-L6-v2/)
  server.close()
})

test('rejects wrong vector size', async () => {
  const server = await startFake((body, res) => reply(res, 200, { ...good(body.texts), embeddings: [[1, 2, 3]] }))
  await assert.rejects(embedTexts(['x']), /wrong size/)
  server.close()
})

test('reports service HTTP errors', async () => {
  const server = await startFake((body, res) => reply(res, 500, { detail: 'boom' }))
  await assert.rejects(embedTexts(['x']), /error 500: boom/)
  server.close()
})

test('reports an unreachable service', async () => {
  process.env.EMBEDDING_SERVICE_URL = 'http://127.0.0.1:1'
  await assert.rejects(embedTexts(['x']), /unreachable/)
})

test('rejects empty input before calling the service', async () => {
  await assert.rejects(embedTexts(['ok', '  ']), /non-empty strings/)
})
