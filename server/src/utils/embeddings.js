// Client for the local embedding service (server/embedding-service), which runs
// sentence-transformers/all-MiniLM-L6-v2. Documents and queries both go through here,
// so they always use the same model.
export const EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
export const EMBEDDING_DIMENSIONS = 384

const BATCH_SIZE = 32
const TIMEOUT_MS = 60000

function serviceUrl() {
  return (process.env.EMBEDDING_SERVICE_URL || 'http://localhost:8001').replace(/\/+$/, '')
}

async function post(path, body) {
  let res
  try {
    res = await fetch(`${serviceUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': process.env.EMBEDDING_SERVICE_TOKEN || '' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(`Embedding service unreachable at ${serviceUrl()} (${err.message})`)
  }

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(`Embedding service error ${res.status}: ${data?.detail || 'unknown error'}`)
  }

  // Never accept a different model or size: vectors from two models cannot be compared.
  if (data?.model !== EMBEDDING_MODEL || data?.dimensions !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding service is running ${data?.model} (${data?.dimensions}), expected ${EMBEDDING_MODEL} (${EMBEDDING_DIMENSIONS})`)
  }
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== body.texts.length) {
    throw new Error('Embedding service returned an unexpected number of vectors')
  }
  if (data.embeddings.some((v) => !Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS)) {
    throw new Error('Embedding service returned a vector with the wrong size')
  }
  return data.embeddings
}

// embedTexts(['a', 'b']) -> [[384 numbers], [384 numbers]]  (same order as the input)
export async function embedTexts(texts) {
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string' || !t.trim())) {
    throw new Error('embedTexts needs an array of non-empty strings')
  }
  const vectors = []
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    vectors.push(...(await post('/embed', { texts: texts.slice(i, i + BATCH_SIZE) })))
  }
  return vectors
}

// embedQuery('what is our refund policy?') -> [384 numbers]
export async function embedQuery(query) {
  return (await embedTexts([query]))[0]
}
