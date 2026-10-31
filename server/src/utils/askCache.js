// Response cache for POST /api/ask (Phase 9, Module 9.2).
//
// This module does NOT answer questions. routes/ask.js still runs the one and only RAG pipeline
// (vector search -> PostgreSQL ownership check -> graph facts -> Groq -> sources). All this file does is let
// that route skip the pipeline when an identical, still-valid answer is already in Redis.
//
// HOW A KEY IS BUILT (every part is mandatory; see buildKey):
//
//   memhub:cache:<companyId>:ask:v<schema>:<kbVersion>:<scopeHash>:<configHash>:<questionHash>
//
//   companyId     first, so one company's keys can never match another's. Also stored inside the entry and
//                 compared on every read (defence in depth).
//   schema        bump ASK_CACHE_SCHEMA_VERSION when the response shape or this key layout changes.
//   kbVersion     "<counter>.<epoch>.<fingerprint>": the knowledge base of this company as it is RIGHT NOW (see below).
//   scopeHash     SHA-256 of the authorization scope the answer was produced under (see askScopeHash).
//   configHash    SHA-256 of everything that changes what retrieval / generation returns (top-k, min score,
//                 context budgets, graph limits, whether the graph is on, the LLM model).
//   questionHash  SHA-256 of the NORMALIZED question. Questions can be long and sensitive, so the text itself
//                 never appears in a Redis key.
//
// KNOWLEDGE-BASE VERSION (Module 9.4, utils/knowledgeVersion.js) = "<counter>.<epoch>.<fingerprint>":
//   counter      Company.knowledgeVersion in PostgreSQL: durable, advanced atomically when an upload, delete, reindex or
//                graph reprocess has CHANGED what a question can return. A failed change that wrote nothing does not advance it.
//   epoch        a random token in Redis, rotated together with the counter (Module 9.2).
//   fingerprint  derived from PostgreSQL on every request: document count + newest Document.updatedAt + graph-ingestion
//                count + newest GraphIngestion.updatedAt (Module 9.2). Catches changes made outside the application.
//   While a change is IN FLIGHT (PostgreSQL, ChromaDB and Neo4j do not share a transaction, so they may disagree) the
//   version is not available at all: prepareAskCache() returns null and the request runs the plain pipeline, so an answer
//   built from half-written data is never cached and a cached answer is never served over data that is being changed.
//   The version is read BEFORE retrieval starts and the entry is stored under that same version. If the knowledge base
//   changes while a question is being answered, the answer lands under the OLD version, which nobody asks for any more.
//   A stale answer can therefore never be served as current.
//
// WHAT IS CACHED: only a complete, grounded, successful answer. See isCacheableAskResponse.
//
// Redis is an optimisation: every function here either returns a safe "no cache" value or swallows its error.

import { createHash } from 'node:crypto'
import { cacheGet, cacheSet, cacheKey, getRedisStatus, defaultTtlSeconds } from './redisCache.js'
import { knowledgeBaseVersion } from './knowledgeVersion.js'

// The version lives in knowledgeVersion.js (Module 9.4). Re-exported here because the answer cache, the graph cache
// and their tests have always imported these two names from this file.
export { knowledgeBaseVersion, invalidateCompanyKnowledge } from './knowledgeVersion.js'

export const ASK_CACHE_SCHEMA_VERSION = 1

const MAX_TTL_SECONDS = 30 * 24 * 60 * 60
const MAX_ENTRY_CHARS = 256 * 1024 // a larger answer is simply not cached

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// ---------- configuration ----------

// ASK_CACHE_ENABLED=false switches only the answer cache off (Redis stays available to everything else).
export function askCacheEnabled() {
  const raw = (process.env.ASK_CACHE_ENABLED || '').trim().toLowerCase()
  return !['false', '0', 'off', 'no'].includes(raw)
}

// ASK_CACHE_TTL (seconds, 1 - 2592000). Not set or invalid -> REDIS_CACHE_TTL (default 300).
export function askCacheTtlSeconds() {
  const value = Number.parseInt((process.env.ASK_CACHE_TTL || '').trim(), 10)
  return Number.isInteger(value) && value >= 1 && value <= MAX_TTL_SECONDS ? value : defaultTtlSeconds()
}

// ---------- key components ----------

// "What is our Refund policy?" and "  what is our refund   policy " are the same question. NFKC folds look-alike
// characters (full-width letters, ligatures), whitespace is collapsed, case is folded and trailing ? ! . are
// dropped. Nothing else is touched: different words are different questions. '' means "nothing to cache".
export function normalizeQuestion(question) {
  return String(question ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s?!.]+$/u, '')
}

// JSON with sorted keys, so equal objects always hash equal no matter how they were built.
// Exported so the graph cache (Module 9.3) builds its key hashes the same way.
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// The authorization scope an answer was produced under.
// Today every member of a company may see every document of that company, so the scope is
// "company-documents". The ROLE is part of it anyway, taken from PostgreSQL (never from the request): if
// per-role or per-document visibility is ever added, entries produced for one role cannot be served to another.
// To add a finer rule later (department, document ACL, ...) put it in this object; no other code changes.
// Authorization changes (Module 9.4): a role change selects another scope hash (= another key) by itself, and a removed
// or moved user fails the PostgreSQL check in prepareAskCache() before any entry is read. Neither needs the
// knowledge-base version to advance, so they never flush the other members' cached answers.
export function askScopeHash({ role }) {
  return sha256(stableStringify({ visibility: 'company-documents', role: String(role) })).slice(0, 32)
}

// config = { topK, minScore, maxContextChars, graph: { enabled, maxFacts, maxContextChars, evidenceChars }, model }
export function retrievalConfigHash(config) {
  return sha256(stableStringify(config)).slice(0, 32)
}

export const questionHash = (normalizedQuestion) => sha256(normalizedQuestion)

// ---------- what may be cached ----------

// Only a complete, grounded, successful answer.
//  - not grounded (not_indexed / no_relevant_match / not_enough_info): never cached. They are cheap to
//    recompute, and "not indexed" in particular is temporary.
//  - retrieval.graph.status 'unavailable': the answer is vector-only because Neo4j failed. That is an incomplete
//    retrieval and must not be served after Neo4j is back. ('disabled' = graph not configured = complete.)
//  - errors (authorization, Groq, vector service) never reach this function: the route responds from its catch.
export function isCacheableAskResponse(body) {
  if (!body || typeof body !== 'object') return false
  if (body.success !== true || body.grounded !== true) return false
  if (typeof body.answer !== 'string' || !body.answer.trim()) return false
  if (!Array.isArray(body.sources) || body.sources.length === 0) return false
  if (!body.sources.every((s) => s && typeof s.documentId === 'string' && typeof s.text === 'string')) return false
  const r = body.retrieval
  if (!r || typeof r !== 'object') return false
  if (r.vector?.status !== 'ok') return false
  if (!['ok', 'disabled'].includes(r.graph?.status)) return false
  return true
}

// ---------- the per-request handle ----------

// Returns null (= "no caching for this request, run the pipeline") unless EVERYTHING below succeeds:
//   1. caching is enabled and Redis is connected;
//   2. the caller still exists in PostgreSQL and still belongs to the company in the token (this is the
//      authorization check; it also supplies the role used in the scope). A removed or moved user gets no cache
//      and no cache write; the route then behaves exactly as it did before Module 9.2;
//   3. the knowledge-base version could be determined.
// Otherwise returns { lookup(), store(body) }. Neither throws. The handle only exists AFTER step 2, so a
// cached answer cannot be read before authorization.
export async function prepareAskCache({ prisma, user, question, config }) {
  try {
    if (!askCacheEnabled() || getRedisStatus().status !== 'ok') return null
    const companyId = user?.companyId
    if (typeof companyId !== 'string' || !companyId || typeof user?.userId !== 'string') return null

    const normalized = normalizeQuestion(question)
    if (!normalized) return null

    const current = await prisma.user.findUnique({ where: { id: user.userId }, select: { id: true, companyId: true, role: true } })
    if (!current || current.companyId !== companyId || !current.role) {
      console.warn('[ask-cache] caller not confirmed in PostgreSQL - cache bypassed')
      return null
    }

    const kb = await knowledgeBaseVersion(prisma, companyId)
    if (!kb) return null

    const parts = {
      companyId,
      kb,
      scope: askScopeHash({ role: current.role }),
      config: retrievalConfigHash(config),
      question: questionHash(normalized),
    }
    const key = cacheKey(companyId, 'ask', `v${ASK_CACHE_SCHEMA_VERSION}`, parts.kb, parts.scope, parts.config, parts.question)

    return {
      // -> the stored response body, or null (miss, Redis trouble, or an entry that fails any check)
      async lookup() {
        const entry = await cacheGet(key)
        if (!entry || typeof entry !== 'object') return null
        const matches =
          entry.v === ASK_CACHE_SCHEMA_VERSION &&
          entry.companyId === parts.companyId &&
          entry.kb === parts.kb &&
          entry.scope === parts.scope &&
          entry.config === parts.config &&
          entry.question === parts.question
        if (!matches || !isCacheableAskResponse(entry.response)) {
          console.warn('[ask-cache] entry failed validation - treated as a miss')
          return null
        }
        return entry.response
      },
      // -> true when stored. Only eligible responses are written.
      async store(body) {
        try {
          if (!isCacheableAskResponse(body)) return false
          const entry = { v: ASK_CACHE_SCHEMA_VERSION, ...parts, storedAt: new Date().toISOString(), response: body }
          if (JSON.stringify(entry).length > MAX_ENTRY_CHARS) return false
          return await cacheSet(key, entry, { ttlSeconds: askCacheTtlSeconds() })
        } catch {
          return false
        }
      },
    }
  } catch (err) {
    console.warn('[ask-cache] disabled for this request:', err?.code || err?.message)
    return null
  }
}
