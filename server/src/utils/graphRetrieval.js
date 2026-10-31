// Graph side of hybrid retrieval for /api/ask.
//
// retrieveGraphFacts()      asks Neo4j for facts one hop around the entities in the retrieved vector
//                           chunks and in the question. Never throws; reports its own status.
// mergeGraphIntoContext()   (pure) turns facts into prompt context: a fact whose chunk is already in
//                           the vector context is attached to that excerpt, anything else becomes a
//                           small "graph" excerpt made of the fact's own evidence sentence.
import { chunkUid, isRelationType, questionKeys } from './graphIdentity.js'
import { findGraphFacts } from './graphStore.js'
import { isNeo4jConfigured } from './neo4j.js'

function readInt(name, fallback, min, max) {
  const v = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isInteger(v) && v >= min && v <= max ? v : fallback
}

export function graphSettings() {
  return {
    maxFacts: readInt('GRAPH_MAX_FACTS', 8, 1, 30), // facts that may reach the prompt
    // Extra context allowance for graph evidence, ON TOP of RAG_MAX_CONTEXT_CHARS (vector excerpts).
    maxContextChars: readInt('GRAPH_MAX_CONTEXT_CHARS', 1500, 200, 10000),
    evidenceChars: 500,
  }
}

// -> { status: 'disabled' | 'ok' | 'unavailable', seeds, facts, code? }
export async function retrieveGraphFacts({ companyId, question, chunks }) {
  if (!isNeo4jConfigured()) return { status: 'disabled', seeds: 0, facts: [] }
  const { maxFacts } = graphSettings()
  try {
    const { seeds, facts } = await findGraphFacts(companyId, {
      chunkUids: chunks.map((c) => chunkUid(companyId, c.documentId, c.chunkIndex)),
      keys: questionKeys(question),
      factLimit: maxFacts * 4, // headroom: some facts are dropped by validation and de-duplication
    })
    return { status: 'ok', seeds, facts }
  } catch (err) {
    // Reported to the caller as "unavailable" - never presented as a successful (empty) retrieval.
    console.error('[graph] retrieval failed:', err?.code || err?.name)
    return { status: 'unavailable', code: err?.code || 'GRAPH_FAILED', seeds: 0, facts: [] }
  }
}

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim()
const lineCost = (f) => String(f.subject).length + String(f.object).length + f.relationship.length + 8

// context: vector items already selected (kept as they are, only graphFacts may be added)
// facts:   rows from findGraphFacts(), best first
// names:   Map(documentId -> filename) of documents PostgreSQL confirmed for THIS company.
//          A fact whose document is not in it is dropped (source ownership validation).
// -> { context, factsUsed }
export function mergeGraphIntoContext(context, facts, names, { maxFacts, maxContextChars, evidenceChars }) {
  const items = context.map((c) => ({ kind: 'chunk', ...c }))
  const byChunk = new Map(items.map((c) => [`${c.documentId}:${c.chunkIndex}`, c]))
  const byEvidence = new Map()
  const seenFacts = new Set()
  let budget = maxContextChars
  let factsUsed = 0

  for (const f of facts) {
    if (factsUsed >= maxFacts) break
    if (!names.has(f.documentId)) continue
    if (typeof f.evidence !== 'string' || !f.evidence.trim()) continue
    if (!f.fromUid || !f.toUid || !f.fromName || !f.toName || !isRelationType(f.rel)) continue

    const factKey = `${f.fromUid}|${f.rel}|${f.toUid}|${f.documentId}|${f.chunkIndex}`
    if (seenFacts.has(factKey)) continue
    seenFacts.add(factKey)

    const compact = {
      subject: f.fromName, subjectType: f.fromType, relationship: f.rel,
      object: f.toName, objectType: f.toType, confidence: f.confidence ?? null,
    }
    const cost = lineCost(compact)
    const evidence = f.evidence.trim().slice(0, evidenceChars)
    const evKey = `${f.documentId}|${norm(evidence)}`

    // 1) the fact's chunk is already an excerpt  2) another excerpt of that document already
    // contains this sentence (chunks overlap)  3) the same evidence was already added as graph text
    let item = byChunk.get(`${f.documentId}:${f.chunkIndex}`)
    if (!item) item = items.find((c) => c.documentId === f.documentId && norm(c.text).includes(norm(evidence)))
    if (!item) item = byEvidence.get(evKey)

    if (item) {
      if (budget < cost) continue
      budget -= cost
    } else {
      if (budget < evidence.length + cost) continue
      budget -= evidence.length + cost
      item = {
        ref: items.length + 1, kind: 'graph', documentId: f.documentId, documentName: names.get(f.documentId),
        chunkIndex: f.chunkIndex, text: evidence, startChar: null, endChar: null, score: null, graphFacts: [],
      }
      items.push(item)
      byEvidence.set(evKey, item)
      byChunk.set(`${f.documentId}:${f.chunkIndex}`, item)
    }
    item.graphFacts = item.graphFacts || []
    item.graphFacts.push(compact)
    factsUsed += 1
  }
  return { context: items, factsUsed }
}
