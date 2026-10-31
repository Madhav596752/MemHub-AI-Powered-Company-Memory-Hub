import { Router } from 'express'
import prisma from '../prisma.js'
import { requireAuth } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { entityUidBelongsTo } from '../utils/graphIdentity.js'
import { getEntityDetail, getGraphOverview } from '../utils/graphStore.js'
import { processDocumentGraph } from '../utils/graphIngest.js'
import { GraphError, checkNeo4jHealth, isNeo4jConfigured } from '../utils/neo4j.js'
import { beginKnowledgeChange, graphResultEffect } from '../utils/knowledgeVersion.js'
import { cachedGraphRead, graphCacheVersion } from '../utils/graphCache.js'

const router = Router()

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_DOCS = 5000
const DEFAULT_LIMIT = 80
const MAX_LIMIT = 200
// Per-node limits. These are getEntityDetail()'s own defaults, passed explicitly so they are part of the cache key.
const ENTITY_EDGE_LIMIT = 40
const ENTITY_MENTION_LIMIT = 20

// The company ALWAYS comes from the verified JWT. Nothing in the query string or body can change it.
function companyOf(req, res) {
  const companyId = req.user?.companyId
  if (typeof companyId !== 'string' || !companyId) {
    res.status(401).json({ success: false, message: 'Authentication required' })
    return null
  }
  return companyId
}

// The documents that exist in PostgreSQL for this company. Graph reads only count facts that come
// from these documents, so nothing from a deleted or foreign document can be shown.
async function companyDocuments(companyId) {
  return prisma.document.findMany({ where: { companyId }, select: { id: true, originalName: true }, take: MAX_DOCS })
}

// Read cache (Module 9.3, utils/graphCache.js). X-Cache is set only when caching was active for the request.
const sortedIds = (ids) => [...ids].sort()
function markCache(res, cache) {
  if (cache !== 'BYPASS') res.set('X-Cache', cache)
}

function fail(res, label, err) {
  if (err instanceof GraphError) {
    return res.status(err.status).json({ success: false, message: err.message, code: err.code })
  }
  console.error(label, err)
  res.status(500).json({ success: false, message: 'Something went wrong' })
}

// ---------- GET /api/graph?limit=80 ----------
// The most connected entities of the company, and the relationships between them.
// Optional: ?documentId=<uuid> limits the graph to one of the company's documents.
router.get('/', requireAuth, async (req, res) => {
  try {
    const companyId = companyOf(req, res)
    if (!companyId) return

    let limit = DEFAULT_LIMIT
    if (req.query.limit !== undefined) {
      limit = Number(req.query.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        return res.status(400).json({ success: false, message: `limit must be a whole number from 1 to ${MAX_LIMIT}` })
      }
    }

    if (!isNeo4jConfigured()) {
      return res.json({ success: true, enabled: false, nodes: [], edges: [], stats: { entities: 0, relationships: 0 }, truncated: false })
    }

    const docs = await companyDocuments(companyId)
    let docIds = docs.map((d) => d.id)
    // Optional filter to ONE document. It is checked against the company's own documents, so another
    // company's document id (or any unknown id) is rejected exactly like a missing one.
    const only = req.query.documentId
    if (only !== undefined) {
      if (typeof only !== 'string' || !UUID_REGEX.test(only)) {
        return res.status(400).json({ success: false, message: 'Invalid document ID' })
      }
      if (!docIds.includes(only)) return res.status(404).json({ success: false, message: 'Document not found' })
      docIds = [only]
    }
    // The cache version is read right BEFORE Neo4j is queried, never after (null = no caching; see graphCache.js).
    const kb = await graphCacheVersion(prisma, companyId, req.user)
    const { value: graph, cache } = await cachedGraphRead({
      companyId, kb, kind: 'overview',
      params: { limit, docIds: sortedIds(docIds) },
      compute: () => getGraphOverview(companyId, { docIds, limit }),
    })
    markCache(res, cache)
    res.json({ success: true, enabled: true, ...graph, documents: docs.map((d) => ({ id: d.id, name: d.originalName })) })
  } catch (err) {
    fail(res, 'Graph overview error:', err)
  }
})

// ---------- GET /api/graph/status ----------
// Is the graph on and reachable, and how many of the company's documents have been processed?
router.get('/status', requireAuth, async (req, res) => {
  try {
    const companyId = companyOf(req, res)
    if (!companyId) return

    const [total, grouped, health, noRelationships] = await Promise.all([
      prisma.document.count({ where: { companyId } }),
      prisma.graphIngestion.groupBy({ by: ['status'], where: { companyId }, _count: { _all: true } }),
      checkNeo4jHealth(),
      // processed = entities were extracted and stored; this counts the ones whose text stated no relationship
      prisma.graphIngestion.count({ where: { companyId, status: 'processed', relationshipCount: 0 } }),
    ])
    const by = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]))
    const processed = by.processed || 0
    const failed = by.failed || 0
    const skipped = by.skipped || 0
    res.json({
      success: true,
      enabled: health.configured,
      connected: health.status === 'ok',
      documents: { total, processed, failed, skipped, notProcessed: Math.max(0, total - processed - failed - skipped), processedWithoutRelationships: noRelationships },
    })
  } catch (err) {
    fail(res, 'Graph status error:', err)
  }
})

// ---------- GET /api/graph/nodes/:id ----------
// One entity with its relationships (and the evidence text + document of each) and where it is mentioned.
router.get('/nodes/:id', requireAuth, async (req, res) => {
  try {
    const companyId = companyOf(req, res)
    if (!companyId) return

    // Ids carry the company they belong to; another company's id is "not found", like a missing one.
    if (!entityUidBelongsTo(req.params.id, companyId) || !isNeo4jConfigured()) {
      return res.status(404).json({ success: false, message: 'Node not found' })
    }

    const docs = await companyDocuments(companyId)
    const names = new Map(docs.map((d) => [d.id, d.originalName]))
    const docIds = [...names.keys()]
    const kb = await graphCacheVersion(prisma, companyId, req.user) // right BEFORE Neo4j is queried (see graphCache.js)
    // The cached part is the raw query result. The document-ownership filtering below runs on every request.
    const { value: detail, cache } = await cachedGraphRead({
      companyId, kb, kind: 'entity',
      params: { uid: req.params.id, docIds: sortedIds(docIds), edgeLimit: ENTITY_EDGE_LIMIT, mentionLimit: ENTITY_MENTION_LIMIT },
      compute: () => getEntityDetail(companyId, req.params.id, { docIds, edgeLimit: ENTITY_EDGE_LIMIT, mentionLimit: ENTITY_MENTION_LIMIT }),
    })
    markCache(res, cache)
    if (!detail) return res.status(404).json({ success: false, message: 'Node not found' })

    res.json({
      success: true,
      node: detail.node,
      relationships: detail.edges
        .filter((e) => names.has(e.documentId))
        .map((e) => ({
          type: e.type,
          direction: e.outgoing ? 'out' : 'in',
          other: { id: e.otherId, label: e.otherLabel, type: e.otherType },
          evidence: e.evidence,
          documentId: e.documentId,
          documentName: names.get(e.documentId),
          chunkIndex: e.chunkIndex,
          confidence: e.confidence,
        })),
      mentions: detail.mentions
        .filter((m) => names.has(m.documentId))
        .map((m) => ({ documentId: m.documentId, documentName: names.get(m.documentId), chunkIndex: m.chunkIndex, surfaces: m.surfaces })),
    })
  } catch (err) {
    fail(res, 'Graph node error:', err)
  }
})

// ---------- POST /api/graph/documents/:id/reprocess ----------
// Re-runs NLP + graph ingestion for one document (use it after a failed upload-time run).
// Safe to repeat: the document's graph contribution is replaced, never duplicated.
// ADMIN only (graph:reprocess); the document must still belong to the caller's company.
router.post('/documents/:id/reprocess', requireAuth, requirePermission('graph:reprocess'), async (req, res) => {
  try {
    const companyId = companyOf(req, res)
    if (!companyId) return
    if (!UUID_REGEX.test(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid document ID' })
    }
    // Found by id AND the user's company, so another company's document is "not found"
    const doc = await prisma.document.findFirst({
      where: { id: req.params.id, companyId },
      select: { id: true, companyId: true, originalName: true, extractedText: true },
    })
    if (!doc) return res.status(404).json({ success: false, message: 'Document not found' })

    // Module 9.4: the knowledge-base version advances ONLY if the run really changed the graph. While it runs, cached
    // answers and graph reads of this company are bypassed. A run that failed before writing anything (NLP down, a chunk
    // that could not be analysed, nothing configured) leaves the version, and therefore every valid cache entry, alone.
    // An ambiguous outcome (Neo4j connection lost) advances it and keeps the cache off for a short grace period.
    const change = await beginKnowledgeChange(prisma, companyId, 'graph-reprocess')
    let g
    try {
      g = await processDocumentGraph(doc) // never throws
      change.record(graphResultEffect(g))
    } finally {
      await change.settle() // idempotent; never throws
    }
    res.json({ success: true, graph: { status: g.status, entities: g.entities, relationships: g.relationships, relationshipStatus: g.relationshipStatus, ...(g.code ? { code: g.code, message: g.message } : {}) } })
  } catch (err) {
    fail(res, 'Graph reprocess error:', err)
  }
})

export default router
