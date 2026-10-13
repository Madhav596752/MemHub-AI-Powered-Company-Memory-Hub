// Node client for the vector store, which lives inside the Python service
// (server/embedding-service, ChromaDB in persistent mode).
//
// The company ID is always passed in by the caller from req.user.companyId and sent to the
// service, which applies it as a filter inside the Chroma query/delete itself.
import { chunkDocument } from './chunker.js'

const SEARCH_TIMEOUT_MS = 30000
const DELETE_TIMEOUT_MS = 30000

export const MAX_SEARCH_LIMIT = 20

// Thrown for problems the route should turn into a clean HTTP error.
// status: 503 = a service is down, 502 = a service failed or is misconfigured, 422 = nothing to index.
// code tells the failures apart for the frontend and the logs:
//   NO_TEXT, EMBEDDING_SERVICE_UNAVAILABLE, EMBEDDING_FAILED, VECTOR_STORE_FAILED, VECTOR_SERVICE_MISCONFIGURED
export class RagError extends Error {
  constructor(message, status = 503, code = 'EMBEDDING_SERVICE_UNAVAILABLE') {
    super(message)
    this.name = 'RagError'
    this.status = status
    this.code = code
  }
}

function serviceUrl() {
  return (process.env.EMBEDDING_SERVICE_URL || 'http://localhost:8001').replace(/\/+$/, '')
}

function indexTimeoutMs() {
  const value = Number.parseInt(process.env.INDEX_TIMEOUT_MS ?? '', 10)
  return Number.isInteger(value) && value > 0 ? value : 300000 // embedding a big document takes a while
}

// Headers for the Python service. The shared secret proves the call comes from this backend
// (the service refuses everything else). It is never logged.
export function serviceHeaders(hasBody = true) {
  const headers = { 'X-Internal-Token': process.env.EMBEDDING_SERVICE_TOKEN || '' }
  if (hasBody) headers['Content-Type'] = 'application/json'
  return headers
}

// Calls the Python service. The detailed reason stays in the server log only;
// RagError.message is safe to show to a user.
async function call(method, path, body, timeoutMs) {
  let res
  try {
    res = await fetch(`${serviceUrl()}${path}`, {
      method,
      headers: serviceHeaders(Boolean(body)),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    console.error(`Vector service unreachable (${method} ${path}):`, err.message)
    throw new RagError('The embedding service is currently unavailable. Please try again later.', 503, 'EMBEDDING_SERVICE_UNAVAILABLE')
  }

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    console.error(`Vector service error (${method} ${path}) ${res.status}:`, data?.detail)
    if (res.status === 401 || res.status === 403) {
      throw new RagError('The search service rejected this server. An administrator must check EMBEDDING_SERVICE_TOKEN.', 502, 'VECTOR_SERVICE_MISCONFIGURED')
    }
    if (data?.detail === 'embedding_failed') {
      throw new RagError('The embedding service could not process the text. Please try again later.', 503, 'EMBEDDING_FAILED')
    }
    if (data?.detail === 'chroma_failed') {
      throw new RagError('The vector database failed. Please try again later.', 502, 'VECTOR_STORE_FAILED')
    }
    throw new RagError('The search service could not complete the request. Please try again later.', 502, 'VECTOR_STORE_FAILED')
  }
  return data
}

// Splits the document into chunks and stores them (replacing any earlier chunks of the
// same document). doc needs: id, companyId, originalName, extractedText.
// Returns the number of chunks stored. Throws RagError if nothing was stored.
export async function indexDocument(doc) {
  const chunks = chunkDocument(doc)
  if (chunks.length === 0) {
    console.error('Indexing skipped: document', doc.id, 'produced 0 chunks (extracted text length', doc.extractedText?.length ?? 0, ')')
    throw new RagError('This document has no text to index.', 422, 'NO_TEXT')
  }
  console.log(`[index] document=${doc.id} textLength=${doc.extractedText.length} chunks=${chunks.length}`)

  const data = await call(
    'POST',
    '/index',
    {
      companyId: doc.companyId,
      documentId: doc.id,
      documentName: doc.originalName,
      chunks: chunks.map(({ chunkIndex, text, startChar, endChar }) => ({ chunkIndex, text, startChar, endChar })),
    },
    indexTimeoutMs()
  )

  // Only report success if the service says everything was stored.
  if (data?.chunksStored !== chunks.length) {
    console.error('Vector service stored an unexpected number of chunks:', data?.chunksStored, 'expected', chunks.length)
    throw new RagError('The document could not be fully indexed. Please try again later.', 502, 'VECTOR_STORE_FAILED')
  }
  console.log(`[index] document=${doc.id} vectorsStored=${data.chunksStored}`)
  return data.chunksStored
}

// Nearest chunks for a query, restricted to one company by the vector database itself.
// Returns [{ text, documentId, documentName, chunkIndex, startChar, endChar, distance, score }]
// best match first. distance is cosine distance (0 = identical); score = 1 - distance.
export async function searchChunks(companyId, query, limit) {
  const data = await call('POST', '/search', { companyId, query, topK: limit }, SEARCH_TIMEOUT_MS)
  if (!Array.isArray(data?.results)) {
    throw new RagError('The search service returned an unexpected response.', 502, 'VECTOR_STORE_FAILED')
  }

  // score = 1 - distance is only correct for COSINE distance (0..2). A larger distance means the
  // collection uses another metric (e.g. squared L2), which would silently reject relevant chunks.
  if (data.results.some((r) => typeof r.distance !== 'number' || r.distance > 2.0001)) {
    console.error('[search] distance outside the cosine range 0..2 - the ChromaDB collection is probably not cosine. Rebuild it (see embedding-service README).')
  }
  console.log(`[search] results=${data.results.length} topK=${limit} distances=[${data.results.map((r) => Number(r.distance).toFixed(3)).join(', ')}]`)

  return data.results.map(({ text, metadata, distance }) => ({
    text,
    documentId: metadata.documentId,
    documentName: metadata.documentName,
    chunkIndex: metadata.chunkIndex,
    // Character offsets into the document's extracted text (no page numbers are stored at upload)
    startChar: metadata.startChar ?? null,
    endChar: metadata.endChar ?? null,
    distance,
    score: 1 - distance,
  }))
}

// Removes every stored chunk of one document (only inside the given company).
export async function deleteDocumentChunks(companyId, documentId) {
  await call(
    'DELETE',
    `/documents/${encodeURIComponent(documentId)}?companyId=${encodeURIComponent(companyId)}`,
    null,
    DELETE_TIMEOUT_MS
  )
}
