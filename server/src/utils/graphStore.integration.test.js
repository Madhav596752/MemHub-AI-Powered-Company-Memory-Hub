// Runs the REAL Cypher against a REAL Neo4j. Skipped unless NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD
// are set (use a throw-away database: it creates and removes data of two random test companies).
//
//   NEO4J_URI=bolt://localhost:7687 NEO4J_USERNAME=neo4j NEO4J_PASSWORD=... npm run test:neo4j
//
// The unit tests (graphStore.test.js) only check which statements run; THIS file is what proves the
// Cypher itself: constraints, idempotent ingestion, shared entities, deletion cleanup, company scoping.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { RELATION_TYPES } from './graphIdentity.js'
import { closeDriver, ensureGraphSchema, isNeo4jConfigured, readQuery, writeTx } from './neo4j.js'
import { buildIngestPayload, deleteDocumentGraph, findGraphFacts, getEntityDetail, getGraphOverview, replaceDocumentGraph } from './graphStore.js'

const skip = !isNeo4jConfigured() && 'Neo4j is not configured (set NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD)'

const A = `it-A-${randomUUID()}`
const B = `it-B-${randomUUID()}`
const chunks = [{ chunkIndex: 0, startChar: 0, endChar: 80 }]
const ent = (id, text, type, normalized) => ({ id, text, type, normalized: normalized ?? text, confidence: 0.9, startChar: null, endChar: null })
const extraction = (docId, issue = 'issue #402') => [{
  documentId: docId, chunkId: `${docId}:0`, chunkIndex: 0,
  entities: [ent('entity_1', 'Project Phoenix', 'PROJECT'), ent('entity_2', issue, 'ISSUE', 'Issue #402'), ent('entity_3', 'Redis', 'TECHNOLOGY')],
  relationships: [
    { source: 'entity_2', target: 'entity_1', type: 'BELONGS_TO', confidence: 0.94, evidence: `${issue} in Project Phoenix`, trigger: 't' },
    { source: 'entity_1', target: 'entity_3', type: 'USED', confidence: 0.95, evidence: 'Project Phoenix uses Redis', trigger: 't' },
  ],
}]
const ingest = (company, docId) => replaceDocumentGraph(company, { id: docId, originalName: `${docId}.txt` }, buildIngestPayload(company, { id: docId }, chunks, extraction(docId)))
const count = async (company, label) => (await readQuery(`MATCH (n:${label} {companyId: $company}) RETURN count(n) AS n`, { company }))[0].n
const relCount = async (company) => (await readQuery('MATCH (:Entity {companyId: $company})-[r]->(:Entity {companyId: $company}) WHERE type(r) IN $types RETURN count(r) AS n', { company, types: [...RELATION_TYPES] }))[0].n

test.after(async () => {
  if (skip) return
  for (const company of [A, B]) await writeTx((tx) => tx.run('MATCH (n {companyId: $company}) DETACH DELETE n', { company }))
  await closeDriver()
})

test('constraints can be created twice (idempotent)', { skip }, async () => {
  await ensureGraphSchema()
  await ensureGraphSchema()
})

test('ingest, re-ingest (no duplicates), shared entity survives deleting one document', { skip }, async () => {
  await ingest(A, 'doc1')
  const first = { entities: await count(A, 'Entity'), chunks: await count(A, 'Chunk'), rels: await relCount(A) }
  assert.deepEqual(first, { entities: 3, chunks: 1, rels: 2 })

  await ingest(A, 'doc1') // same document again
  assert.deepEqual({ entities: await count(A, 'Entity'), chunks: await count(A, 'Chunk'), rels: await relCount(A) }, first)

  await ingest(A, 'doc2') // second document: shares Project Phoenix / Issue #402 / Redis (company-wide identity)
  assert.equal(await count(A, 'Entity'), 3, 'shared entities are merged, not duplicated')
  assert.equal(await relCount(A), 4, 'but every document keeps its own evidence edge')

  await deleteDocumentGraph(A, 'doc1')
  assert.equal(await count(A, 'Entity'), 3, 'entities still referenced by doc2 survive')
  assert.equal(await relCount(A), 2)
  assert.equal((await readQuery('MATCH ()-[r]->() WHERE r.documentId = $d AND r.companyId = $c RETURN count(r) AS n', { d: 'doc1', c: A }))[0].n, 0)

  await deleteDocumentGraph(A, 'doc2')
  assert.deepEqual({ entities: await count(A, 'Entity'), chunks: await count(A, 'Chunk'), docs: await count(A, 'Document'), rels: await relCount(A) }, { entities: 0, chunks: 0, docs: 0, rels: 0 })
})

test('company isolation: same names in another company are separate nodes and never visible', { skip }, async () => {
  await ingest(A, 'docA')
  await ingest(B, 'docB')
  assert.equal(await count(A, 'Entity'), 3)
  assert.equal(await count(B, 'Entity'), 3)

  const overviewA = await getGraphOverview(A, { docIds: ['docA'], limit: 50 })
  assert.equal(overviewA.nodes.length, 3)
  assert.ok(overviewA.nodes.every((n) => n.id.startsWith(`${A}:`)))
  // asking for company B's document ids through company A returns nothing
  assert.equal((await getGraphOverview(A, { docIds: ['docB'], limit: 50 })).nodes.length, 0)

  const [phoenixB] = (await getGraphOverview(B, { docIds: ['docB'], limit: 50 })).nodes.filter((n) => n.label === 'Project Phoenix')
  assert.equal(await getEntityDetail(A, phoenixB.id, { docIds: ['docA', 'docB'] }), null, 'company A cannot read company B\'s node')

  const facts = await findGraphFacts(A, { chunkUids: [`${B}:docB:0`], keys: ['redis'] })
  assert.ok(facts.facts.length > 0)
  assert.ok(facts.facts.every((f) => f.fromUid.startsWith(`${A}:`) && f.toUid.startsWith(`${A}:`) && f.documentId === 'docA'))
})

test('graph facts carry their evidence and document', { skip }, async () => {
  const { facts } = await findGraphFacts(A, { chunkUids: [`${A}:docA:0`] })
  const used = facts.find((f) => f.rel === 'USED')
  assert.equal(used.evidence, 'Project Phoenix uses Redis')
  assert.equal(used.documentId, 'docA')
  assert.equal(used.chunkIndex, 0)
})
