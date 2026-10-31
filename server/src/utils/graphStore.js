// Neo4j persistence and queries for the knowledge graph.
//
// GRAPH MODEL
//   (:Document {uid, companyId, documentId, name})
//        -[:HAS_CHUNK]-> (:Chunk {uid, companyId, documentId, chunkId, chunkIndex, startChar, endChar})
//        -[:MENTIONS {surfaces, startChars, endChars, confidence, documentId}]-> (:Entity {uid, companyId, type, name, normalizedKey, scope})
//   (:Entity)-[:RESOLVED|WORKED_ON|...  {relId, companyId, documentId, chunkId, chunkIndex, evidence, confidence, trigger}]->(:Entity)
//
//   * One typed edge per extracted fact AND per supporting chunk. A fact stated in three documents is
//     three edges, each carrying its own evidence text and documentId, so no fact loses its source and
//     deleting one document removes exactly that document's edges.
//   * Entities are shared (company-wide) where the name identifies them; see identityScope().
//   * Chunk text is NOT copied here: it lives in PostgreSQL / ChromaDB. The graph holds ids, offsets
//     and the short evidence sentence of each relationship.
//
// SAFETY
//   * Every statement filters on $companyId, which always comes from the authenticated user.
//   * Relationship types are written into Cypher only through assertRelationType() (fixed list from
//     the NLP schema). Everything else is passed as a query parameter.
import { RELATION_TYPES, assertRelationType, chunkIdFor, chunkUid, documentUid, entityIdentity, relationUid } from './graphIdentity.js'
import { GraphError, int, isNeo4jConfigured, readTx, rows, writeTx } from './neo4j.js'

const BATCH = 500
const MAX_MENTIONS_PER_DOCUMENT = 100000

function* slices(list, size = BATCH) {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size)
}

// ---------- pure: NLP output -> rows to write ----------

// extractions: validated results of nlpClient.extractChunks()  [{ chunkId, chunkIndex, entities, relationships }]
// Entity ids ("entity_1") only mean something inside their own chunk, so they are translated to
// global uids here, once, per chunk.
export function buildIngestPayload(companyId, doc, chunks, extractions) {
  const documentId = doc.id
  const chunkByIndex = new Map(chunks.map((c) => [c.chunkIndex, c]))
  const chunkRows = chunks.map((c) => ({
    uid: chunkUid(companyId, documentId, c.chunkIndex),
    chunkId: chunkIdFor(documentId, c.chunkIndex),
    chunkIndex: c.chunkIndex,
    startChar: c.startChar,
    endChar: c.endChar,
  }))

  const entityRows = new Map()
  const mentionRows = new Map()
  const relsByType = new Map()
  const relSeen = new Set()
  let skippedRelationships = 0

  for (const ex of extractions) {
    const chunk = chunkByIndex.get(ex.chunkIndex)
    if (!chunk) continue // an answer for a chunk we never sent: ignore
    const cUid = chunkUid(companyId, documentId, ex.chunkIndex)
    const local = new Map() // "entity_1" -> global uid, for THIS chunk only

    for (const ent of ex.entities) {
      const { uid, key, scope } = entityIdentity(companyId, ent, documentId)
      local.set(ent.id, uid)
      if (!entityRows.has(uid)) entityRows.set(uid, { uid, type: ent.type, name: ent.normalized || ent.text, key, scope })

      const mKey = `${cUid}|${uid}`
      const m = mentionRows.get(mKey) || { chunkUid: cUid, entityUid: uid, surfaces: [], startChars: [], endChars: [], confidence: 0 }
      if (!m.surfaces.includes(ent.text)) m.surfaces.push(ent.text)
      if (ent.startChar !== null && ent.endChar !== null) {
        m.startChars.push(ent.startChar)
        m.endChars.push(ent.endChar)
      }
      m.confidence = Math.max(m.confidence, ent.confidence ?? 0)
      mentionRows.set(mKey, m)
    }

    for (const rel of ex.relationships) {
      const s = local.get(rel.source)
      const t = local.get(rel.target)
      // Two mentions that resolve to the same entity ("Postgres" / "PostgreSQL") would make a self-loop.
      if (!s || !t || s === t) { skippedRelationships += 1; continue }
      try { assertRelationType(rel.type) } catch { skippedRelationships += 1; continue }
      const relId = relationUid(cUid, s, rel.type, t)
      if (relSeen.has(relId)) continue
      relSeen.add(relId)
      if (!relsByType.has(rel.type)) relsByType.set(rel.type, [])
      relsByType.get(rel.type).push({
        relId, sourceUid: s, targetUid: t,
        chunkId: chunkIdFor(documentId, ex.chunkIndex), chunkIndex: ex.chunkIndex,
        evidence: rel.evidence, confidence: rel.confidence, trigger: rel.trigger ?? null,
      })
    }
  }

  const relationshipCount = [...relsByType.values()].reduce((n, list) => n + list.length, 0)
  return {
    docUid: documentUid(companyId, documentId),
    chunkRows,
    entityRows: [...entityRows.values()],
    mentionRows: [...mentionRows.values()],
    relsByType: Object.fromEntries(relsByType),
    stats: { entities: entityRows.size, mentions: mentionRows.size, relationships: relationshipCount, skippedRelationships },
  }
}

// ---------- write: cleanup + ingest (all inside ONE transaction) ----------

const Q_DOC_ENTITY_UIDS = `
MATCH (:Chunk {companyId: $companyId, documentId: $documentId})-[:MENTIONS]->(e:Entity {companyId: $companyId})
RETURN collect(DISTINCT e.uid) AS uids`

const Q_DELETE_DOC_RELS = `
MATCH (:Chunk {companyId: $companyId, documentId: $documentId})-[:MENTIONS]->(e:Entity {companyId: $companyId})
WITH DISTINCT e
MATCH (e)-[r]->(:Entity {companyId: $companyId})
WHERE r.documentId = $documentId AND type(r) IN $relTypes
DELETE r`

const Q_DELETE_DOC_CHUNKS = `
MATCH (c:Chunk {companyId: $companyId, documentId: $documentId})
DETACH DELETE c`

const Q_DELETE_DOC_NODE = `
MATCH (d:Document {uid: $docUid, companyId: $companyId})
DETACH DELETE d`

// Only entities that no chunk mentions any more are removed: a shared entity survives as long as
// ANY other document still mentions it.
const Q_DELETE_ORPHANS = `
UNWIND $uids AS uid
MATCH (e:Entity {uid: uid, companyId: $companyId})
WHERE NOT (e)<-[:MENTIONS]-(:Chunk)
DETACH DELETE e`

const Q_MERGE_DOCUMENT = `
MERGE (d:Document {uid: $docUid, companyId: $companyId})
SET d.documentId = $documentId, d.name = $name, d.updatedAt = datetime()`

const Q_MERGE_CHUNKS = `
UNWIND $chunks AS ch
MERGE (c:Chunk {uid: ch.uid, companyId: $companyId})
SET c.documentId = $documentId, c.chunkId = ch.chunkId, c.chunkIndex = ch.chunkIndex,
    c.startChar = ch.startChar, c.endChar = ch.endChar
WITH c
MATCH (d:Document {uid: $docUid, companyId: $companyId})
MERGE (d)-[:HAS_CHUNK]->(c)`

const Q_MERGE_ENTITIES = `
UNWIND $entities AS ent
MERGE (e:Entity {uid: ent.uid, companyId: $companyId})
ON CREATE SET e.name = ent.name, e.createdAt = datetime()
SET e.type = ent.type, e.normalizedKey = ent.key, e.scope = ent.scope, e.updatedAt = datetime()`

const Q_MERGE_MENTIONS = `
UNWIND $mentions AS m
MATCH (c:Chunk {uid: m.chunkUid, companyId: $companyId})
MATCH (e:Entity {uid: m.entityUid, companyId: $companyId})
MERGE (c)-[r:MENTIONS]->(e)
SET r.documentId = $documentId, r.surfaces = m.surfaces, r.startChars = m.startChars,
    r.endChars = m.endChars, r.confidence = m.confidence`

// The ONLY place a label is put into Cypher text, and only after the allow-list check.
export function relationshipCypher(type) {
  const safe = assertRelationType(type)
  return `
UNWIND $rels AS rel
MATCH (s:Entity {uid: rel.sourceUid, companyId: $companyId})
MATCH (t:Entity {uid: rel.targetUid, companyId: $companyId})
MERGE (s)-[r:\`${safe}\` {relId: rel.relId}]->(t)
SET r.companyId = $companyId, r.documentId = $documentId, r.chunkId = rel.chunkId,
    r.chunkIndex = rel.chunkIndex, r.evidence = rel.evidence, r.confidence = rel.confidence,
    r.trigger = rel.trigger`
}

async function removeDocumentFromGraph(tx, companyId, documentId) {
  const touched = rows(await tx.run(Q_DOC_ENTITY_UIDS, { companyId, documentId }))
  await tx.run(Q_DELETE_DOC_RELS, { companyId, documentId, relTypes: [...RELATION_TYPES] })
  await tx.run(Q_DELETE_DOC_CHUNKS, { companyId, documentId })
  await tx.run(Q_DELETE_DOC_NODE, { companyId, documentId, docUid: documentUid(companyId, documentId) })
  return touched[0]?.uids ?? []
}

async function removeOrphans(tx, companyId, uids) {
  for (const part of slices(uids)) await tx.run(Q_DELETE_ORPHANS, { companyId, uids: part })
}

// Replaces EVERYTHING this document contributed to the graph with `payload`, atomically:
// either the old state or the complete new state is visible, never a mix. Running it twice with
// the same payload gives the same graph (MERGE on deterministic ids), so reprocessing never
// creates duplicates. Other documents' facts and shared entities are untouched.
export async function replaceDocumentGraph(companyId, doc, payload) {
  if (payload.stats.mentions > MAX_MENTIONS_PER_DOCUMENT) {
    throw new GraphError('This document produced too many graph entries to store.', 422, 'GRAPH_TOO_LARGE')
  }
  const documentId = doc.id
  const base = { companyId, documentId }

  await writeTx(async (tx) => {
    const touched = await removeDocumentFromGraph(tx, companyId, documentId)

    await tx.run(Q_MERGE_DOCUMENT, { ...base, docUid: payload.docUid, name: doc.originalName })
    for (const part of slices(payload.chunkRows)) await tx.run(Q_MERGE_CHUNKS, { ...base, docUid: payload.docUid, chunks: part })
    for (const part of slices(payload.entityRows)) await tx.run(Q_MERGE_ENTITIES, { companyId, entities: part })
    for (const part of slices(payload.mentionRows)) await tx.run(Q_MERGE_MENTIONS, { ...base, mentions: part })
    for (const [type, list] of Object.entries(payload.relsByType)) {
      const cypher = relationshipCypher(type) // throws for anything outside the allow-list
      for (const part of slices(list)) await tx.run(cypher, { ...base, rels: part })
    }

    // Entities this document used before but not any more (and nobody else mentions) are dropped.
    await removeOrphans(tx, companyId, touched)
  })
}

// Removes a document's contribution. Shared entities stay if any other document still mentions them.
// No-op (returns { skipped: true }) when Neo4j is not configured.
export async function deleteDocumentGraph(companyId, documentId) {
  if (!isNeo4jConfigured()) return { skipped: true }
  await writeTx(async (tx) => {
    const touched = await removeDocumentFromGraph(tx, companyId, documentId)
    await removeOrphans(tx, companyId, touched)
  })
  return { skipped: false }
}

// ---------- reads (all company-scoped; docIds = the company's documents that exist in PostgreSQL) ----------

const Q_OVERVIEW_NODES = `
MATCH (e:Entity {companyId: $companyId})<-[m:MENTIONS]-(:Chunk {companyId: $companyId})
WHERE m.documentId IN $docIds
WITH e, count(DISTINCT m.documentId) AS documentCount, count(m) AS mentionCount
OPTIONAL MATCH (e)-[r]-(:Entity {companyId: $companyId})
WHERE r.documentId IN $docIds AND type(r) IN $relTypes
WITH e, documentCount, mentionCount, count(r) AS degree
ORDER BY degree DESC, mentionCount DESC, e.name ASC
LIMIT $limit
RETURN e.uid AS id, e.name AS label, e.type AS type, degree, documentCount, mentionCount`

const Q_OVERVIEW_EDGES = `
MATCH (a:Entity {companyId: $companyId})-[r]->(b:Entity {companyId: $companyId})
WHERE a.uid IN $uids AND b.uid IN $uids AND type(r) IN $relTypes AND r.documentId IN $docIds
RETURN a.uid AS source, b.uid AS target, type(r) AS type, r.confidence AS confidence
LIMIT $edgeLimit`

const Q_OVERVIEW_TOTALS = `
MATCH (e:Entity {companyId: $companyId})<-[m:MENTIONS]-(:Chunk {companyId: $companyId})
WHERE m.documentId IN $docIds
RETURN count(DISTINCT e) AS entities`

const Q_OVERVIEW_REL_TOTAL = `
MATCH (:Entity {companyId: $companyId})-[r]->(:Entity {companyId: $companyId})
WHERE r.documentId IN $docIds AND type(r) IN $relTypes
RETURN count(r) AS relationships`

// Several stored edges between the same two entities with the same type (one per supporting chunk)
// are shown as ONE logical edge with a supportCount.
function collapseEdges(list) {
  const map = new Map()
  for (const e of list) {
    const id = `${e.source}|${e.type}|${e.target}`
    const cur = map.get(id) || { id, source: e.source, target: e.target, type: e.type, confidence: 0, supportCount: 0 }
    cur.supportCount += 1
    cur.confidence = Math.max(cur.confidence, e.confidence ?? 0)
    map.set(id, cur)
  }
  return [...map.values()]
}

export async function getGraphOverview(companyId, { docIds, limit = 80 }) {
  if (!docIds.length) return { nodes: [], edges: [], stats: { entities: 0, relationships: 0 }, truncated: false }
  const relTypes = [...RELATION_TYPES]
  return readTx(async (tx) => {
    const nodes = rows(await tx.run(Q_OVERVIEW_NODES, { companyId, docIds, relTypes, limit: int(limit) }))
    const [{ entities = 0 } = {}] = rows(await tx.run(Q_OVERVIEW_TOTALS, { companyId, docIds }))
    const [{ relationships = 0 } = {}] = rows(await tx.run(Q_OVERVIEW_REL_TOTAL, { companyId, docIds, relTypes }))
    const uids = nodes.map((n) => n.id)
    const edges = uids.length
      ? collapseEdges(rows(await tx.run(Q_OVERVIEW_EDGES, { companyId, docIds, relTypes, uids, edgeLimit: int(limit * 10) })))
      : []
    return { nodes, edges, stats: { entities, relationships }, truncated: entities > nodes.length }
  })
}

const Q_ENTITY = `
MATCH (e:Entity {uid: $uid, companyId: $companyId})
OPTIONAL MATCH (e)<-[m:MENTIONS]-(:Chunk {companyId: $companyId})
WHERE m.documentId IN $docIds
WITH e, count(DISTINCT m.documentId) AS documentCount, count(m) AS mentionCount
WHERE mentionCount > 0
RETURN e.uid AS id, e.name AS label, e.type AS type, documentCount, mentionCount`

const Q_ENTITY_EDGES = `
MATCH (e:Entity {uid: $uid, companyId: $companyId})-[r]-(o:Entity {companyId: $companyId})
WHERE r.documentId IN $docIds AND type(r) IN $relTypes
RETURN type(r) AS type, startNode(r).uid = e.uid AS outgoing, o.uid AS otherId, o.name AS otherLabel,
       o.type AS otherType, r.evidence AS evidence, r.documentId AS documentId,
       r.chunkIndex AS chunkIndex, r.confidence AS confidence
ORDER BY r.confidence DESC
LIMIT $limit`

const Q_ENTITY_MENTIONS = `
MATCH (c:Chunk {companyId: $companyId})-[m:MENTIONS]->(e:Entity {uid: $uid, companyId: $companyId})
WHERE m.documentId IN $docIds
RETURN m.documentId AS documentId, c.chunkIndex AS chunkIndex, m.surfaces AS surfaces
ORDER BY m.documentId, c.chunkIndex
LIMIT $limit`

export async function getEntityDetail(companyId, uid, { docIds, edgeLimit = 40, mentionLimit = 20 }) {
  if (!docIds.length) return null
  const relTypes = [...RELATION_TYPES]
  return readTx(async (tx) => {
    const [node] = rows(await tx.run(Q_ENTITY, { companyId, uid, docIds }))
    if (!node) return null
    const edges = rows(await tx.run(Q_ENTITY_EDGES, { companyId, uid, docIds, relTypes, limit: int(edgeLimit) }))
    const mentions = rows(await tx.run(Q_ENTITY_MENTIONS, { companyId, uid, docIds, limit: int(mentionLimit) }))
    return { node, edges, mentions }
  })
}

// ---------- retrieval for GraphRAG ----------

const Q_SEEDS_FROM_CHUNKS = `
UNWIND $chunkUids AS cu
MATCH (:Chunk {uid: cu, companyId: $companyId})-[:MENTIONS]->(e:Entity {companyId: $companyId})
RETURN DISTINCT e.uid AS uid
LIMIT $seedLimit`

const Q_SEEDS_FROM_QUESTION = `
MATCH (e:Entity {companyId: $companyId})
WHERE e.normalizedKey IN $keys
RETURN e.uid AS uid
LIMIT $seedLimit`

const Q_FACTS = `
MATCH (s:Entity {companyId: $companyId})-[r]-(o:Entity {companyId: $companyId})
WHERE s.uid IN $seedUids AND type(r) IN $relTypes
RETURN r.relId AS relId, type(r) AS rel,
       startNode(r).uid AS fromUid, startNode(r).name AS fromName, startNode(r).type AS fromType,
       endNode(r).uid AS toUid, endNode(r).name AS toName, endNode(r).type AS toType,
       r.evidence AS evidence, r.documentId AS documentId, r.chunkIndex AS chunkIndex, r.confidence AS confidence
ORDER BY r.confidence DESC
LIMIT $factLimit`

// Facts one hop around (a) entities mentioned in the retrieved vector chunks and (b) entities whose
// name appears in the question. Returns { seeds, facts }. The caller must still validate every
// documentId against PostgreSQL before using a fact.
export async function findGraphFacts(companyId, { chunkUids = [], keys = [], seedLimit = 20, factLimit = 40 }) {
  const relTypes = [...RELATION_TYPES]
  return readTx(async (tx) => {
    const seeds = new Set()
    if (chunkUids.length) for (const r of rows(await tx.run(Q_SEEDS_FROM_CHUNKS, { companyId, chunkUids, seedLimit: int(seedLimit) }))) seeds.add(r.uid)
    if (keys.length) for (const r of rows(await tx.run(Q_SEEDS_FROM_QUESTION, { companyId, keys, seedLimit: int(seedLimit) }))) seeds.add(r.uid)
    if (seeds.size === 0) return { seeds: 0, facts: [] }
    const facts = rows(await tx.run(Q_FACTS, { companyId, seedUids: [...seeds].slice(0, seedLimit * 2), relTypes, factLimit: int(factLimit) }))
    return { seeds: seeds.size, facts }
  })
}
