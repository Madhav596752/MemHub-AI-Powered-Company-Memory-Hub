import { Router } from 'express'
import prisma from '../prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { askLimiter } from '../middleware/rateLimit.js'
import { searchChunks, RagError, MAX_SEARCH_LIMIT } from '../utils/vectorStore.js'
import { LlmError, assertLlmConfigured, buildPrompt, callLlm, parseModelAnswer } from '../utils/llm.js'
import { graphSettings, mergeGraphIntoContext, retrieveGraphFacts } from '../utils/graphRetrieval.js'

const router = Router()

const MAX_QUESTION_LENGTH = 1000

// Three different "no answer" situations, so the user is told the real reason:
//   not_indexed        - nothing searchable exists for this company (no upload yet, or indexing failed)
//   no_relevant_match  - documents are indexed, but no chunk was similar enough to the question
//   not_enough_info    - relevant excerpts were found, but they do not answer the question
const NOT_INDEXED_MESSAGE = "I couldn't search your documents because none of them are indexed yet. If you already uploaded one, its indexing may have failed: re-upload it or retry indexing, then ask again."
const NO_DOCUMENTS_MESSAGE = "I couldn't find any relevant information in your company's indexed documents."
const NOT_ENOUGH_MESSAGE = "Your company's indexed documents don't contain enough information to answer this question."

function readNumber(name, fallback, { min, max, integer = true }) {
  const value = integer ? Number.parseInt(process.env[name] ?? '', 10) : Number.parseFloat(process.env[name] ?? '')
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

// How many chunks to retrieve, how similar they must be, and how much text may go to the LLM.
// All of it is read per request so a .env change only needs a restart, not a code change.
function retrievalSettings() {
  return {
    topK: readNumber('RAG_TOP_K', 5, { min: 1, max: MAX_SEARCH_LIMIT }),
    // score = 1 - cosine distance. Chunks scoring below this are treated as "not relevant".
    minScore: readNumber('RAG_MIN_SCORE', 0.25, { min: -1, max: 1, integer: false }),
    maxContextChars: readNumber('RAG_MAX_CONTEXT_CHARS', 6000, { min: 500, max: 50000 }),
  }
}

function notGrounded(reason, message, retrieval) {
  return { success: true, grounded: false, reason, answer: message, sources: [], retrieval }
}

// ---------- POST /api/ask ----------
// Body: { "question": "What is our refund policy?" }
// The company comes from the JWT (req.user.companyId). A companyId in the body is ignored.
//
// HYBRID retrieval: vector chunks (ChromaDB) + knowledge-graph facts (Neo4j, one hop around the
// entities in those chunks and in the question). Both are filtered by the authenticated company and
// every source document is checked against PostgreSQL before it can reach the prompt or a citation.
// The response has the same shape as before plus `retrieval`, which states honestly what each side did:
//   retrieval.graph.status = 'ok' | 'disabled' (Neo4j not configured) | 'unavailable' (it failed -> vector-only answer)
router.post('/', requireAuth, askLimiter, async (req, res) => {
  try {
    const companyId = req.user?.companyId
    if (typeof companyId !== 'string' || !companyId) {
      return res.status(401).json({ success: false, message: 'Authentication required' })
    }

    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : ''
    if (!question) {
      return res.status(400).json({ success: false, message: 'A question is required' })
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      return res.status(400).json({ success: false, message: `The question is too long (maximum ${MAX_QUESTION_LENGTH} characters)` })
    }

    // Fail early with a clear message instead of pretending an answer was generated.
    assertLlmConfigured()

    const { topK, minScore, maxContextChars } = retrievalSettings()

    // 1. Retrieve. The vector database filters by this company itself ...
    const hits = await searchChunks(companyId, question, topK)

    // 2. ... and we check again against PostgreSQL: only chunks whose document exists for THIS
    // company may continue. A chunk from another company (or a deleted document) is dropped
    // here, before anything reaches the LLM prompt or a citation.
    const ids = [...new Set(hits.map((hit) => hit.documentId))]
    const docs = ids.length
      ? await prisma.document.findMany({ where: { id: { in: ids }, companyId }, select: { id: true, originalName: true } })
      : []
    const names = new Map(docs.map((doc) => [doc.id, doc.originalName]))
    const validHits = hits.filter((hit) => names.has(hit.documentId))

    // 3. Keep only relevant chunks, best first, within the context budget.
    const context = []
    let usedChars = 0
    for (const hit of validHits) {
      if (hit.score < minScore) continue
      if (context.length > 0 && usedChars + hit.text.length > maxContextChars) break
      usedChars += hit.text.length
      context.push({
        kind: 'chunk',
        ref: context.length + 1, // the number the LLM cites, e.g. [1]
        documentId: hit.documentId,
        documentName: names.get(hit.documentId), // from PostgreSQL, not from the vector metadata
        chunkIndex: hit.chunkIndex,
        text: hit.text,
        startChar: hit.startChar,
        endChar: hit.endChar,
        score: hit.score,
      })
    }

    console.log(
      `[ask] retrieved=${hits.length} validForCompany=${validHits.length} minScore=${minScore} ` +
        `scores=[${validHits.map((h) => h.score.toFixed(3)).join(', ')}] keptAsContext=${context.length}`
    )

    // 3b. Knowledge graph: facts around the entities of the kept chunks and of the question.
    // It never throws; if Neo4j is down the answer is vector-only and `retrieval` says so.
    const graph = await retrieveGraphFacts({ companyId, question, chunks: context })
    if (graph.status === 'unavailable') {
      console.warn(`[ask] graph retrieval unavailable (${graph.code}) -> vector-only answer`)
    }
    if (graph.facts.length > 0) {
      // Same ownership rule as for chunks: a fact whose document is not this company's PostgreSQL
      // document is dropped before it reaches the prompt or a citation.
      const unknown = [...new Set(graph.facts.map((f) => f.documentId).filter((id) => typeof id === 'string' && !names.has(id)))]
      if (unknown.length) {
        const more = await prisma.document.findMany({ where: { id: { in: unknown }, companyId }, select: { id: true, originalName: true } })
        for (const doc of more) names.set(doc.id, doc.originalName)
      }
    }
    const merged = mergeGraphIntoContext(context, graph.facts, names, graphSettings())
    const full = merged.context // vector excerpts first, then graph-only evidence; refs are consecutive
    const retrieval = {
      vector: { status: 'ok', chunks: context.length },
      graph: { status: graph.status, facts: merged.factsUsed },
    }
    console.log(`[ask] graph=${graph.status} seeds=${graph.seeds} factsRetrieved=${graph.facts.length} factsUsed=${merged.factsUsed} contextItems=${full.length}`)

    // Nothing at all to answer from. Same two reasons as before:
    //  - no vector chunk of this company existed (and the graph added nothing) -> nothing is indexed
    //  - chunks existed but none was similar enough -> no relevant match
    if (full.length === 0) {
      if (validHits.length === 0) {
        console.warn(`[ask] retrieved=${hits.length} validForCompany=0 -> nothing indexed for this company`)
        return res.json(notGrounded('not_indexed', NOT_INDEXED_MESSAGE, retrieval))
      }
      return res.json(notGrounded('no_relevant_match', NO_DOCUMENTS_MESSAGE, retrieval))
    }

    // 4. Ask the LLM ONCE, with only the question and the retrieved excerpts / graph evidence.
    const raw = await callLlm(buildPrompt(question, full))
    const parsed = parseModelAnswer(raw, full.map((c) => c.ref))

    // The model said it cannot answer, or it answered without citing anything real:
    // never present that as a grounded answer.
    if (!parsed.answerable || parsed.refs.length === 0) {
      if (parsed.answerable) console.error('[ask] LLM gave an answer without any valid citation - treated as not grounded')
      return res.json(notGrounded('not_enough_info', NOT_ENOUGH_MESSAGE, retrieval))
    }

    // 5. Sources are built from the retrieved items themselves, looked up by the cited numbers, so a
    // citation can never point at something that was not retrieved. kind = 'chunk' (vector excerpt)
    // or 'graph' (evidence sentence of a graph fact: no score and no offsets, none were stored).
    const sources = parsed.refs.map((ref) => {
      const c = full[ref - 1]
      return {
        ref: c.ref,
        kind: c.kind,
        documentId: c.documentId,
        documentName: c.documentName,
        chunkIndex: c.chunkIndex,
        text: c.text,
        startChar: c.startChar,
        endChar: c.endChar,
        score: c.score,
        ...(c.graphFacts?.length ? { graphFacts: c.graphFacts } : {}),
      }
    })

    console.log(`[ask] answered with ${sources.length} cited source(s)`)
    res.json({ success: true, grounded: true, answer: parsed.answer, sources, retrieval })
  } catch (err) {
    if (err instanceof RagError || err instanceof LlmError) {
      return res.status(err.status).json({ success: false, message: err.message, code: err.code })
    }
    console.error('Ask error:', err)
    res.status(500).json({ success: false, message: 'Something went wrong' })
  }
})

export default router
