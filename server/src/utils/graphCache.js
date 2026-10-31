// Read cache for the Neo4j knowledge-graph queries behind GET /api/graph and GET /api/graph/nodes/:id
// (Phase 9, Module 9.3). Built on the Redis layer of Module 9.1 (redisCache.js) and the conventions of
// Module 9.2 (askCache.js): company id first in every key, a knowledge-base version in every key, TTL from
// the environment, Redis is an optimisation and never a dependency.
//
// This module does NOT query Neo4j and does NOT change what a query returns. Routes still call
// getGraphOverview() / getEntityDetail() exactly as before; cachedGraphRead() only lets them skip that call
// when an identical, still-valid, COMPLETE result is already in Redis.
//
// WHAT IS CACHED (kind):
//   overview   getGraphOverview()  4 Cypher statements; the totals + degree counts scan every entity of the company
//   entity     getEntityDetail()   3 Cypher statements; repeated every time a node is opened in the graph view
// NOT cached on purpose:
//   - findGraphFacts() (hybrid retrieval inside /api/ask): already skipped as a whole by the Module 9.2 answer
//     cache, and its inputs (the retrieved chunk ids + question phrases) rarely repeat on their own.
//   - GET /api/graph/status: it is a live health check, a cached "connected" would hide an outage.
//   - every mutation (replaceDocumentGraph, deleteDocumentGraph, reprocess): writes never touch this module.
//
// HOW A KEY IS BUILT (every part is mandatory):
//
//   memhub:cache:<companyId>:graph:<kind>:v<schema>:<kbVersion>:<configHash>:<paramsHash>
//
//   companyId   first, so one company's keys can never match another's. Also stored inside the entry and
//               compared on every read, and every entity id inside the value must start with it.
//   kind        which query ('overview' | 'entity').
//   schema      bump GRAPH_CACHE_SCHEMA_VERSION when a Cypher statement or the shape of a result changes.
//   kbVersion   the company's knowledge-base version ("<counter>.<epoch>.<fingerprint>", Module 9.4,
//               knowledgeVersion.js: the SAME value the /api/ask cache uses). Upload, delete, reindex and graph
//               reprocess advance it once their Neo4j / ChromaDB / PostgreSQL changes have settled, so every cached
//               graph read of that company becomes unreachable at once. While such a change is in flight the version
//               is not available (null) and graph reads simply go to Neo4j.
//               The version is read BEFORE Neo4j is queried and the result is stored under that same version,
//               so a graph that changes mid-request can only land under a version nobody asks for any more.
//   configHash  SHA-256 of what else decides the result: relationship types, Neo4j database + server (hashed,
//               never stored in clear), the authorization scope, the schema version.
//   paramsHash  SHA-256 of the query parameters (limit, document filter, entity id, per-query limits).
//
// WHAT MAY BE CACHED: only a successful, complete result (see the isComplete* functions). A query that throws
// is never cached (the error propagates exactly as before). Empty results, 404s (null), results whose
// numbers do not add up, and anything containing another company's entity id are never written.
//
// Redis is an optimisation: every failure here becomes a plain call to compute() (the real Neo4j query).

import { createHash } from 'node:crypto'
import { cacheGet, cacheSet, cacheKey, getRedisStatus, defaultTtlSeconds } from './redisCache.js'
import { knowledgeBaseVersion, stableStringify } from './askCache.js'
import { RELATION_TYPES } from './graphIdentity.js'

export const GRAPH_CACHE_SCHEMA_VERSION = 1

const MAX_TTL_SECONDS = 30 * 24 * 60 * 60
const MAX_ENTRY_CHARS = 1024 * 1024 // a larger result is simply not cached (the biggest overview is well below this)

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// ---------- configuration ----------

// GRAPH_CACHE_ENABLED=false switches only the graph cache off (Redis stays available to everything else).
export function graphCacheEnabled() {
  const raw = (process.env.GRAPH_CACHE_ENABLED || '').trim().toLowerCase()
  return !['false', '0', 'off', 'no'].includes(raw)
}

// GRAPH_CACHE_TTL (seconds, 1 - 2592000). Not set or invalid -> REDIS_CACHE_TTL (default 300).
// The TTL is only an upper bound: correctness comes from the knowledge-base version in the key.
export function graphCacheTtlSeconds() {
  const value = Number.parseInt((process.env.GRAPH_CACHE_TTL || '').trim(), 10)
  return Number.isInteger(value) && value >= 1 && value <= MAX_TTL_SECONDS ? value : defaultTtlSeconds()
}

// What else (besides the parameters) decides a graph read. The Neo4j URI is hashed so it never appears in
// clear; it is here so pointing the server at another Neo4j instance cannot serve the old instance's graph.
function configHash() {
  return sha256(stableStringify({
    schema: GRAPH_CACHE_SCHEMA_VERSION,
    relationTypes: [...RELATION_TYPES],
    database: (process.env.NEO4J_DATABASE || '').trim(),
    server: sha256((process.env.NEO4J_URI || '').trim()),
    // Today every member of a company may see the whole company graph (the routes only require a valid login).
    // If per-role or per-document visibility is ever added, put it here and cached graphs cannot cross roles.
    visibility: 'company-documents',
  })).slice(0, 32)
}

const paramsHash = (params) => sha256(stableStringify(params)).slice(0, 32)

// ---------- knowledge-base version ----------

// -> the knowledge-base version of this company, or null ("do not use the cache for this request") when the cache is
// switched off, Redis is not connected, the caller is not confirmed, a knowledge change is in flight, or the version
// could not be determined. When the first two apply no PostgreSQL query is made at all. Never throws.
// Call it BEFORE reading the graph.
//
// AUTHORIZATION (Module 9.4): like /api/ask, the cache is only used for a caller PostgreSQL still confirms as a member of
// this company. A removed user, or one moved to another company, whose access token is still valid gets no cached
// graph (the route then answers exactly as it did before caching existed). `user` is req.user and is REQUIRED: without
// it nothing is cached. Visibility is company-wide today (see configHash), so the role is not part of the key; if a
// per-role rule is ever added, put the role (current.role) into the scope in configHash().
export async function graphCacheVersion(prisma, companyId, user) {
  try {
    if (!graphCacheEnabled() || getRedisStatus().status !== 'ok') return null
    if (typeof companyId !== 'string' || !companyId) return null
    if (typeof user?.userId !== 'string' || !user.userId || user.companyId !== companyId) return null
    const current = await prisma.user.findUnique({ where: { id: user.userId }, select: { id: true, companyId: true, role: true } })
    if (!current || current.companyId !== companyId || !current.role) {
      console.warn('[graph-cache] caller not confirmed in PostgreSQL - cache bypassed')
      return null
    }
    return await knowledgeBaseVersion(prisma, companyId)
  } catch {
    return null
  }
}

// ---------- what may be cached ----------

const ownsUid = (uid, companyId) => typeof uid === 'string' && uid.startsWith(`${companyId}:`)
const isCount = (n) => Number.isInteger(n) && n >= 0

// getGraphOverview() result: { nodes, edges, stats: { entities, relationships }, truncated }
// Complete = internally consistent. An EMPTY graph is not cached (a company that has not been processed yet
// is cheap to answer and the state is temporary). `truncated` is only true when more entities exist than were
// returned, which is the normal, deterministic meaning of "limit" and part of the key.
export function isCompleteOverview(value, { companyId }) {
  if (!value || typeof value !== 'object') return false
  const { nodes, edges, stats, truncated } = value
  if (!Array.isArray(nodes) || nodes.length === 0 || !Array.isArray(edges)) return false
  if (!stats || !isCount(stats.entities) || !isCount(stats.relationships)) return false
  if (typeof truncated !== 'boolean' || truncated !== stats.entities > nodes.length) return false
  if (stats.entities < nodes.length) return false

  const ids = new Set()
  for (const n of nodes) {
    if (!n || !ownsUid(n.id, companyId) || typeof n.label !== 'string' || ids.has(n.id)) return false
    ids.add(n.id)
  }
  // Every edge must connect two returned nodes (the query restricts both ends to them).
  return edges.every((e) => e && ids.has(e.source) && ids.has(e.target) && typeof e.type === 'string')
}

// getEntityDetail() result: { node, edges, mentions }. null (= "not found") is never cached.
export function isCompleteEntityDetail(value, { companyId, params }) {
  if (!value || typeof value !== 'object') return false
  const { node, edges, mentions } = value
  if (!node || node.id !== params.uid || !ownsUid(node.id, companyId) || typeof node.label !== 'string') return false
  if (!Array.isArray(edges) || !Array.isArray(mentions)) return false
  return edges.every((e) => e && ownsUid(e.otherId, companyId))
}

const COMPLETENESS = { overview: isCompleteOverview, entity: isCompleteEntityDetail }

// ---------- the cached read ----------

// cachedGraphRead({ companyId, kb, kind, params, compute })
//   kb       the value of graphCacheVersion(), obtained BEFORE any graph data was read. null -> no caching.
//   params   everything that makes this read different from another one (limit, sorted document ids, entity id ...).
//   compute  the real query, e.g. () => getGraphOverview(companyId, { docIds, limit }).
// -> { value, cache: 'HIT' | 'MISS' | 'BYPASS' }
//   HIT     served from Redis (compute was not called)
//   MISS    caching was active, compute ran (its result is stored when it is complete)
//   BYPASS  caching was not active for this request, compute ran
// compute() runs at most once. If it throws, the error propagates unchanged and nothing is stored. Everything
// that can go wrong in the cache itself is swallowed and becomes a plain compute().
export async function cachedGraphRead({ companyId, kb, kind, params, compute }) {
  const check = COMPLETENESS[kind]
  let entryKey = null
  let meta = null

  try {
    if (check && kb && typeof companyId === 'string' && companyId && graphCacheEnabled() && getRedisStatus().status === 'ok') {
      meta = { v: GRAPH_CACHE_SCHEMA_VERSION, companyId, kind, kb, config: configHash(), params: paramsHash(params) }
      entryKey = cacheKey(companyId, 'graph', kind, `v${meta.v}`, meta.kb, meta.config, meta.params)
    }
  } catch (err) {
    console.warn('[graph-cache] disabled for this request:', err?.code || err?.message)
    entryKey = null
  }

  if (entryKey) {
    const entry = await cacheGet(entryKey) // never throws; null on a miss or when Redis fails
    if (entry && typeof entry === 'object') {
      const matches = Object.keys(meta).every((k) => entry[k] === meta[k])
      if (matches && check(entry.value, { companyId, params })) return { value: entry.value, cache: 'HIT' }
      console.warn('[graph-cache] entry failed validation - treated as a miss')
    }
  }

  const value = await compute() // the real Neo4j query; a failure here is not cached and not hidden

  if (!entryKey) return { value, cache: 'BYPASS' }

  try {
    if (check(value, { companyId, params })) {
      const entry = { ...meta, storedAt: new Date().toISOString(), value }
      if (JSON.stringify(entry).length <= MAX_ENTRY_CHARS) await cacheSet(entryKey, entry, { ttlSeconds: graphCacheTtlSeconds() })
    }
  } catch {
    // storing is best-effort
  }
  return { value, cache: 'MISS' }
}
