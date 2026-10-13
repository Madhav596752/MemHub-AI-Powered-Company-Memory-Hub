import { Router } from 'express'
import prisma from '../prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { searchChunks, RagError, MAX_SEARCH_LIMIT } from '../utils/vectorStore.js'
import { LlmError, assertLlmConfigured, buildPrompt, callLlm, parseModelAnswer } from '../utils/llm.js'

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

function notGrounded(reason, message) {
  return { success: true, grounded: false, reason, answer: message, sources: [] }
}

// ---------- POST /api/ask ----------
// Body: { "question": "What is our refund policy?" }
// The company comes from the JWT (req.user.companyId). A companyId in the body is ignored.
router.post('/', requireAuth, async (req, res) => {
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

    // A nearest-neighbour search always returns something when the company has ANY vectors,
    // so zero valid hits means nothing searchable exists for this company.
    if (validHits.length === 0) {
      console.warn(`[ask] retrieved=${hits.length} validForCompany=0 -> nothing indexed for this company`)
      return res.json(notGrounded('not_indexed', NOT_INDEXED_MESSAGE))
    }

    // 3. Keep only relevant chunks, best first, within the context budget.
    const context = []
    let usedChars = 0
    for (const hit of validHits) {
      if (hit.score < minScore) continue
      if (context.length > 0 && usedChars + hit.text.length > maxContextChars) break
      usedChars += hit.text.length
      context.push({
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

    // No useful chunks: do not call the LLM at all.
    if (context.length === 0) {
      return res.json(notGrounded('no_relevant_match', NO_DOCUMENTS_MESSAGE))
    }

    // 4. Ask the LLM, with only the question and the retrieved excerpts.
    const raw = await callLlm(buildPrompt(question, context))
    const parsed = parseModelAnswer(raw, context.map((c) => c.ref))

    // The model said it cannot answer, or it answered without citing anything real:
    // never present that as a grounded answer.
    if (!parsed.answerable || parsed.refs.length === 0) {
      if (parsed.answerable) console.error('[ask] LLM gave an answer without any valid citation - treated as not grounded')
      return res.json(notGrounded('not_enough_info', NOT_ENOUGH_MESSAGE))
    }

    // 5. Sources are built from the retrieved chunks themselves, looked up by the cited numbers.
    const sources = parsed.refs.map((ref) => {
      const c = context[ref - 1]
      return {
        ref: c.ref,
        documentId: c.documentId,
        documentName: c.documentName,
        chunkIndex: c.chunkIndex,
        text: c.text,
        startChar: c.startChar,
        endChar: c.endChar,
        score: c.score,
      }
    })

    console.log(`[ask] answered with ${sources.length} cited source(s)`)
    res.json({ success: true, grounded: true, answer: parsed.answer, sources })
  } catch (err) {
    if (err instanceof RagError || err instanceof LlmError) {
      return res.status(err.status).json({ success: false, message: err.message, code: err.code })
    }
    console.error('Ask error:', err)
    res.status(500).json({ success: false, message: 'Something went wrong' })
  }
})

export default router
