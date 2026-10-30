import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkText, chunkDocument } from './chunker.js'

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')

test('empty / whitespace / non-string text gives no chunks', () => {
  assert.deepEqual(chunkText(''), [])
  assert.deepEqual(chunkText('   \n\n\t '), [])
  assert.deepEqual(chunkText(null), [])
  assert.deepEqual(chunkText(undefined), [])
})

test('short text gives exactly one unchanged chunk', () => {
  const chunks = chunkText('Hello world.', { chunkSize: 100, overlap: 10 })
  assert.equal(chunks.length, 1)
  assert.deepEqual(chunks[0], { chunkIndex: 0, text: 'Hello world.', startChar: 0, endChar: 12 })
})

test('text exactly chunkSize long is one chunk', () => {
  const text = 'a'.repeat(100)
  assert.equal(chunkText(text, { chunkSize: 100, overlap: 20 }).length, 1)
})

test('long text is split into ordered chunks no larger than chunkSize', () => {
  const text = words(500)
  const chunks = chunkText(text, { chunkSize: 200, overlap: 40 })
  assert.ok(chunks.length > 2)
  chunks.forEach((c, i) => {
    assert.equal(c.chunkIndex, i)
    assert.ok(c.text.length <= 200)
    assert.equal(text.slice(c.startChar, c.endChar), c.text) // exact, unmodified slice
    if (i > 0) assert.ok(c.startChar > chunks[i - 1].startChar) // order preserved
  })
})

test('chunks overlap and together cover the whole text', () => {
  const text = words(300)
  const chunks = chunkText(text, { chunkSize: 150, overlap: 30 })
  assert.equal(chunks[0].startChar, 0)
  assert.equal(chunks.at(-1).endChar, text.length)
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].startChar < chunks[i - 1].endChar, 'no gap between chunks')
    assert.equal(chunks[i].startChar, chunks[i - 1].endChar - 30) // configured overlap
  }
})

test('prefers paragraph boundaries over cutting mid-word', () => {
  const text = `${'a '.repeat(40)}\n\n${'b '.repeat(40)}`
  const [first] = chunkText(text, { chunkSize: 100, overlap: 10 })
  assert.ok(first.text.endsWith('\n\n'))
})

test('text without any spaces still terminates and splits', () => {
  const chunks = chunkText('x'.repeat(1000), { chunkSize: 100, overlap: 20 })
  assert.ok(chunks.length >= 10)
  assert.ok(chunks.every((c) => c.text.length <= 100))
})

test('whitespace-only chunks are skipped, others keep their order', () => {
  const text = `start${' '.repeat(300)}end`
  const chunks = chunkText(text, { chunkSize: 100, overlap: 0 })
  assert.ok(chunks.every((c) => c.text.trim()))
  assert.equal(chunks[0].text.trim(), 'start')
  assert.equal(chunks.at(-1).text.trim(), 'end')
  chunks.forEach((c, i) => assert.equal(c.chunkIndex, i)) // indexes stay contiguous
})

test('invalid options throw', () => {
  assert.throws(() => chunkText('abc', { chunkSize: 0 }))
  assert.throws(() => chunkText('abc', { chunkSize: 10, overlap: 10 }))
  assert.throws(() => chunkText('abc', { chunkSize: 10, overlap: -1 }))
  assert.throws(() => chunkText('abc', { chunkSize: 10.5 }))
})

test('chunk size / overlap can come from CHUNK_SIZE / CHUNK_OVERLAP', () => {
  process.env.CHUNK_SIZE = '50'
  process.env.CHUNK_OVERLAP = '10'
  try {
    const chunks = chunkText(words(100))
    assert.ok(chunks.length > 1)
    assert.ok(chunks.every((c) => c.text.length <= 50))
  } finally {
    delete process.env.CHUNK_SIZE
    delete process.env.CHUNK_OVERLAP
  }
})

test('chunkDocument carries the document identity', () => {
  const doc = { id: 'doc-1', companyId: 'co-1', originalName: 'policy.pdf', extractedText: words(200) }
  const chunks = chunkDocument(doc, { chunkSize: 200, overlap: 20 })
  assert.ok(chunks.length > 1)
  for (const c of chunks) {
    assert.equal(c.documentId, 'doc-1')
    assert.equal(c.companyId, 'co-1')
    assert.equal(c.documentName, 'policy.pdf')
  }
})
