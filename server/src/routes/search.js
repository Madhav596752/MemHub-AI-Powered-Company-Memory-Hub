import { Router } from 'express'
import prisma from '../prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { searchChunks, RagError, MAX_SEARCH_LIMIT } from '../utils/vectorStore.js'

const router = Router()

const MAX_QUERY_LENGTH = 1000

function defaultLimit() {
  const value = Number.parseInt(process.env.SEARCH_DEFAULT_LIMIT ?? '', 10)
  return Number.isInteger(value) && value >= 1 && value <= MAX_SEARCH_LIMIT ? value : 5
}

// ---------- POST /api/search ----------
// Body: { "query": "what is our refund policy?", "limit": 5 }   (limit is optional)
// The company comes from the JWT (req.user.companyId). A companyId in the body is ignored.
router.post('/', requireAuth, async (req, res) => {
  try {
    const companyId = req.user?.companyId
    if (typeof companyId !== 'string' || !companyId) {
      return res.status(401).json({ success: false, message: 'Authentication required' })
    }

    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : ''
    if (!query) {
      return res.status(400).json({ success: false, message: 'Search query is required' })
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return res.status(400).json({ success: false, message: `Search query is too long (maximum ${MAX_QUERY_LENGTH} characters)` })
    }

    let limit = defaultLimit()
    if (req.body.limit !== undefined) {
      limit = req.body.limit
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
        return res.status(400).json({ success: false, message: `limit must be a whole number from 1 to ${MAX_SEARCH_LIMIT}` })
      }
    }

    const hits = await searchChunks(companyId, query, limit)

    // Second safety net on top of the vector-level company filter: only keep chunks whose
    // document still exists in PostgreSQL for THIS company. This also hides chunks left
    // behind by a document that was deleted, and gives us the current document name.
    const ids = [...new Set(hits.map((hit) => hit.documentId))]
    const docs = ids.length
      ? await prisma.document.findMany({ where: { id: { in: ids }, companyId }, select: { id: true, originalName: true } })
      : []
    const names = new Map(docs.map((doc) => [doc.id, doc.originalName]))

    const results = hits
      .filter((hit) => names.has(hit.documentId))
      .map((hit) => ({
        text: hit.text,
        documentId: hit.documentId,
        documentName: names.get(hit.documentId),
        chunkIndex: hit.chunkIndex,
        startChar: hit.startChar,
        endChar: hit.endChar,
        distance: hit.distance,
        score: hit.score,
      }))

    res.json({ success: true, query, results })
  } catch (err) {
    if (err instanceof RagError) {
      return res.status(err.status).json({ success: false, message: err.message, code: err.code })
    }
    console.error('Search error:', err)
    res.status(500).json({ success: false, message: 'Something went wrong' })
  }
})

export default router
