// Client for the internal Python NLP service (server/nlp-service).
//
// The service answer is validated again here: it is a separate process, so it is not trusted.
// Only known entity/relationship types, relationships between two different entities of the same
// chunk, and relationships that carry evidence text survive. Identity (documentId, chunkId,
// chunkIndex) always comes from OUR chunk list, never from the service's answer.
import { ENTITY_TYPES, RELATION_TYPES, isEntityType, isRelationType } from './graphIdentity.js'

// status: 503 = service down / timed out, 502 = rejected / bad answer, 422 = nothing to process
export class NlpError extends Error {
  constructor(message, status = 502, code = 'NLP_FAILED') {
    super(message)
    this.name = 'NlpError'
    this.status = status
    this.code = code
  }
}

const MAX_TEXT = 300
const MAX_EVIDENCE = 500

export function nlpConfig() {
  const timeout = Number.parseInt(process.env.NLP_TIMEOUT_MS ?? '', 10)
  const batch = Number.parseInt(process.env.NLP_BATCH_SIZE ?? '', 10)
  return {
    url: (process.env.NLP_SERVICE_URL || 'http://localhost:8002').replace(/\/+$/, ''),
    token: (process.env.NLP_SERVICE_TOKEN || '').trim(),
    timeoutMs: Number.isInteger(timeout) && timeout > 0 ? timeout : 30000,
    batchSize: Number.isInteger(batch) && batch >= 1 && batch <= 100 ? batch : 25,
  }
}

export const isNlpConfigured = () => Boolean(nlpConfig().token)

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const unit = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? Number(v.toFixed(3)) : null)
const offset = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null)

// raw: the parsed JSON of POST /extract.  sent: the chunks that were sent [{chunkId, chunkIndex, text, ...}]
// -> { extractions: [{ documentId, chunkId, chunkIndex, entities, relationships }], failedChunkIds, dropped }
export function validateExtraction(raw, documentId, sent) {
  if (!isObj(raw) || !Array.isArray(raw.results) || !(raw.failed === undefined || Array.isArray(raw.failed))) {
    throw new NlpError('The NLP service returned an unexpected response.', 502, 'NLP_BAD_RESPONSE')
  }
  const byId = new Map(sent.map((c) => [c.chunkId, c]))
  const extractions = []
  const done = new Set()
  let dropped = 0

  for (const res of raw.results) {
    if (!isObj(res) || !byId.has(res.chunkId) || done.has(res.chunkId)) {
      throw new NlpError('The NLP service returned an unexpected response.', 502, 'NLP_BAD_RESPONSE')
    }
    done.add(res.chunkId)
    const chunk = byId.get(res.chunkId)
    const entities = []
    const ids = new Set()
    for (const e of Array.isArray(res.entities) ? res.entities : []) {
      const t = text(e?.text, MAX_TEXT)
      if (!isObj(e) || typeof e.id !== 'string' || !e.id || ids.has(e.id) || !isEntityType(e.type) || !t) { dropped += 1; continue }
      ids.add(e.id)
      entities.push({
        id: e.id,
        text: t,
        type: e.type,
        normalized: text(e.normalized, MAX_TEXT) || t,
        confidence: unit(e.confidence),
        // character offsets inside the DOCUMENT's extracted text, only if they are plausible
        startChar: offset(e.documentStartChar, Number.MAX_SAFE_INTEGER),
        endChar: offset(e.documentEndChar, Number.MAX_SAFE_INTEGER),
      })
    }
    const relationships = []
    for (const r of Array.isArray(res.relationships) ? res.relationships : []) {
      const evidence = text(r?.evidence, MAX_EVIDENCE)
      const conf = unit(r?.confidence)
      if (!isObj(r) || !isRelationType(r.type) || !ids.has(r.source) || !ids.has(r.target) || r.source === r.target || !evidence || conf === null) { dropped += 1; continue }
      relationships.push({ source: r.source, target: r.target, type: r.type, confidence: conf, evidence, trigger: text(r.trigger, 60) })
    }
    extractions.push({ documentId, chunkId: chunk.chunkId, chunkIndex: chunk.chunkIndex, entities, relationships })
  }

  const failedChunkIds = (raw.failed || []).map((f) => f?.chunkId).filter((id) => byId.has(id))
  // Every chunk that was sent must be accounted for: either extracted or reported as failed.
  const missing = sent.filter((c) => !done.has(c.chunkId) && !failedChunkIds.includes(c.chunkId))
  if (missing.length) throw new NlpError('The NLP service did not process every chunk.', 502, 'NLP_BAD_RESPONSE')
  return { extractions, failedChunkIds, dropped }
}

async function post(path, body) {
  const { url, token, timeoutMs } = nlpConfig()
  let res
  try {
    res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    console.error(`NLP service unreachable (${path}):`, err?.name, err?.message)
    throw new NlpError('The language-processing service is currently unavailable.', 503, 'NLP_SERVICE_UNAVAILABLE')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    console.error(`NLP service error (${path}) ${res.status}`)
    if (res.status === 401 || res.status === 403) {
      throw new NlpError('The NLP service rejected this server. NLP_SERVICE_TOKEN must have the same value in server/.env and for the NLP service.', 502, 'NLP_SERVICE_MISCONFIGURED')
    }
    throw new NlpError('The language-processing service could not process the document.', 502, 'NLP_FAILED')
  }
  return data
}

// chunks: [{ chunkId, chunkIndex, text, startChar, endChar }]
// -> { extractions, failedChunkIds, dropped }   (throws NlpError)
export async function extractChunks(documentId, chunks) {
  if (!isNlpConfigured()) throw new NlpError('The NLP service is not configured (NLP_SERVICE_TOKEN).', 503, 'NLP_NOT_CONFIGURED')
  const { batchSize } = nlpConfig()
  const all = { extractions: [], failedChunkIds: [], dropped: 0 }
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize)
    const raw = await post('/extract', {
      documentId,
      chunks: batch.map(({ chunkId, chunkIndex, text, startChar, endChar }) => ({ chunkId, chunkIndex, text, startChar, endChar })),
    })
    const part = validateExtraction(raw, documentId, batch)
    all.extractions.push(...part.extractions)
    all.failedChunkIds.push(...part.failedChunkIds)
    all.dropped += part.dropped
  }
  return all
}

export { ENTITY_TYPES, RELATION_TYPES }
