import test from 'node:test'
import assert from 'node:assert/strict'
import { clearGraphEnv, makeFakeDriver, setGraphEnv } from '../test-helpers/fakeNeo4j.js'
import { GraphError, SCHEMA_STATEMENTS, setDriverForTests } from './neo4j.js'
import { buildIngestPayload, deleteDocumentGraph, getGraphOverview, relationshipCypher, replaceDocumentGraph } from './graphStore.js'

setGraphEnv()
test.after(() => { setDriverForTests(null); clearGraphEnv() })

const doc = { id: 'doc-1', originalName: 'plan.txt' }
const chunks = [
  { chunkIndex: 0, startChar: 0, endChar: 60 },
  { chunkIndex: 1, startChar: 40, endChar: 120 },
]
const ent = (id, text, type, normalized, extra = {}) => ({ id, text, type, normalized: normalized ?? text, confidence: 0.9, startChar: null, endChar: null, ...extra })
const rel = (source, target, type, evidence = 'ev') => ({ source, target, type, confidence: 0.95, evidence, trigger: 't' })
const extractions = () => [
  { documentId: 'doc-1', chunkId: 'doc-1:0', chunkIndex: 0,
    entities: [ent('entity_1', 'Priya Rao', 'PERSON', undefined, { startChar: 0, endChar: 9 }), ent('entity_2', 'login issue', 'ISSUE'), ent('entity_3', 'Project Phoenix', 'PROJECT')],
    relationships: [rel('entity_1', 'entity_2', 'RESOLVED', 'Priya Rao resolved the login issue'), rel('entity_2', 'entity_3', 'BELONGS_TO')] },
  // "entity_1" here is a DIFFERENT entity: ids are local to a chunk
  { documentId: 'doc-1', chunkId: 'doc-1:1', chunkIndex: 1,
    entities: [ent('entity_1', 'Project Phoenix', 'PROJECT'), ent('entity_2', 'Postgres', 'TECHNOLOGY', 'PostgreSQL'), ent('entity_3', 'PostgreSQL', 'TECHNOLOGY')],
    relationships: [rel('entity_1', 'entity_2', 'USED'), rel('entity_2', 'entity_3', 'MIGRATED_TO') /* both resolve to ONE entity -> self loop */] },
]

// ---------- payload ----------
test('payload: chunk-local ids are translated to global ids; shared entities are merged; mentions keep every surface form', () => {
  const p = buildIngestPayload('c1', doc, chunks, extractions())
  const byName = Object.fromEntries(p.entityRows.map((e) => [e.name, e]))
  assert.equal(p.entityRows.length, 4) // Priya Rao, login issue, Project Phoenix (merged across chunks), PostgreSQL (two mentions merged)
  assert.equal(p.entityRows.filter((e) => e.name === 'Project Phoenix').length, 1)
  assert.equal(byName.PostgreSQL.type, 'TECHNOLOGY')
  const pg = p.mentionRows.filter((m) => m.entityUid === byName.PostgreSQL.uid)
  assert.deepEqual(pg[0].surfaces, ['Postgres', 'PostgreSQL']) // two mentions, one entity, both traceable
  const priya = p.mentionRows.find((m) => m.entityUid === byName['Priya Rao'].uid)
  assert.deepEqual([priya.startChars, priya.endChars], [[0], [9]])
  assert.equal(p.stats.skippedRelationships, 1) // the self loop
  assert.equal(p.relsByType.MIGRATED_TO, undefined)
  assert.deepEqual(Object.keys(p.relsByType).sort(), ['BELONGS_TO', 'RESOLVED', 'USED'])
  const resolved = p.relsByType.RESOLVED[0]
  assert.equal(resolved.evidence, 'Priya Rao resolved the login issue')
  assert.equal(resolved.chunkId, 'doc-1:0')
})

test('payload: ambiguous entities stay per document, same-named entities of another company never collide', () => {
  const ex = [{ documentId: 'doc-1', chunkId: 'doc-1:0', chunkIndex: 0, entities: [ent('entity_1', 'Alex', 'PERSON')], relationships: [] }]
  const a1 = buildIngestPayload('c1', { id: 'doc-1' }, chunks, ex).entityRows[0].uid
  const a2 = buildIngestPayload('c1', { id: 'doc-2' }, chunks, ex).entityRows[0].uid
  const b1 = buildIngestPayload('c2', { id: 'doc-1' }, chunks, ex).entityRows[0].uid
  assert.equal(new Set([a1, a2, b1]).size, 3)
})

test('payload: building twice gives identical ids (idempotent ingestion)', () => {
  assert.deepEqual(buildIngestPayload('c1', doc, chunks, extractions()), buildIngestPayload('c1', doc, chunks, extractions()))
})

test('payload: an answer for a chunk we did not send, and a relation type outside the list, are ignored', () => {
  const ex = extractions()
  ex.push({ documentId: 'doc-1', chunkId: 'doc-1:9', chunkIndex: 9, entities: [ent('entity_1', 'Ghost', 'PERSON')], relationships: [] })
  ex[0].relationships.push(rel('entity_1', 'entity_3', 'HACKED`) DELETE (x'))
  const p = buildIngestPayload('c1', doc, chunks, ex)
  assert.ok(!p.entityRows.some((e) => e.name === 'Ghost'))
  assert.ok(!Object.keys(p.relsByType).some((t) => t.includes('HACKED')))
})

// ---------- writing ----------
test('relationship Cypher: label only from the allow-list, always backtick-quoted, nothing else interpolated', () => {
  assert.match(relationshipCypher('RESOLVED'), /\[r:`RESOLVED` \{relId: rel\.relId\}\]/)
  for (const bad of ['x`]-() DETACH DELETE (n) //', 'RELATES_TO', '']) assert.throws(() => relationshipCypher(bad))
})

test('replace: ONE transaction, cleanup first, everything scoped by companyId, orphan check last', async () => {
  const fake = makeFakeDriver((cypher) => (cypher.includes('collect(DISTINCT e.uid)') ? [{ uids: ['c1:PERSON:old1', 'c1:PERSON:old2'] }] : []))
  setDriverForTests(fake)
  const payload = buildIngestPayload('c1', doc, chunks, extractions())
  await replaceDocumentGraph('c1', doc, payload)

  assert.equal(fake.state.transactions, 1, 'cleanup and ingest must be atomic')
  const calls = fake.state.calls
  assert.ok(calls.every((c) => c.params.companyId === 'c1'), 'every statement carries the authenticated company')
  assert.ok(calls.every((c) => /companyId/.test(c.cypher)), 'every statement filters on companyId')
  const idx = (needle) => calls.findIndex((c) => c.cypher.includes(needle))
  assert.ok(idx('DELETE r') < idx('MERGE (d:Document'), 'old facts of this document are removed before new ones are written')
  assert.ok(idx('MERGE (d:Document') < idx('MERGE (e:Entity') && idx('MERGE (e:Entity') < idx('MERGE (c)-[r:MENTIONS]'))
  assert.ok(idx('MERGE (c)-[r:MENTIONS]') < idx('`RESOLVED`'))
  const orphan = calls.at(-1)
  assert.match(orphan.cypher, /WHERE NOT \(e\)<-\[:MENTIONS\]-\(:Chunk\)/)
  assert.deepEqual(orphan.params.uids, ['c1:PERSON:old1', 'c1:PERSON:old2'])
  // the stored provenance: document, chunk and evidence travel with each relationship
  const resolved = calls.find((c) => c.cypher.includes('`RESOLVED`'))
  assert.equal(resolved.params.documentId, 'doc-1')
  assert.equal(resolved.params.rels[0].chunkId, 'doc-1:0')
  assert.equal(resolved.params.rels[0].evidence, 'Priya Rao resolved the login issue')
})

test('replace twice with the same input: same statements, same ids (no accumulation)', async () => {
  const run = async () => {
    const fake = makeFakeDriver()
    setDriverForTests(fake)
    await replaceDocumentGraph('c1', doc, buildIngestPayload('c1', doc, chunks, extractions()))
    return fake.state.calls.map((c) => JSON.stringify([c.cypher, c.params]))
  }
  assert.deepEqual(await run(), await run())
})

test('replace: a failing write surfaces as GraphError with a safe message', async () => {
  const fake = makeFakeDriver()
  fake.state.failWith = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:7687 secret-host'), { code: 'ServiceUnavailable' })
  setDriverForTests(fake)
  await assert.rejects(replaceDocumentGraph('c1', doc, buildIngestPayload('c1', doc, chunks, extractions())), (e) => {
    assert.ok(e instanceof GraphError)
    assert.equal(e.status, 503)
    assert.doesNotMatch(e.message, /10\.0\.0\.5|secret-host/)
    return true
  })
})

test('delete: removes this document\'s facts, then only entities nobody mentions any more', async () => {
  const fake = makeFakeDriver((cypher) => (cypher.includes('collect(DISTINCT e.uid)') ? [{ uids: ['c1:PROJECT:shared'] }] : []))
  setDriverForTests(fake)
  const out = await deleteDocumentGraph('c1', 'doc-1')
  assert.equal(out.skipped, false)
  assert.equal(fake.state.transactions, 1)
  const calls = fake.state.calls
  assert.ok(calls.every((c) => c.params.companyId === 'c1'))
  const rels = calls.find((c) => c.cypher.includes('DELETE r'))
  assert.match(rels.cypher, /r\.documentId = \$documentId/) // only edges that came from THIS document
  assert.ok(calls.some((c) => /DETACH DELETE d/.test(c.cypher)) && calls.some((c) => /DETACH DELETE c/.test(c.cypher)))
  assert.match(calls.at(-1).cypher, /WHERE NOT \(e\)<-\[:MENTIONS\]-\(:Chunk\)/) // a still-mentioned shared entity survives
  assert.ok(!calls.some((c) => /DETACH DELETE e\b/.test(c.cypher) && !/WHERE NOT/.test(c.cypher)), 'entities are never deleted unconditionally')
})

test('delete is a no-op without Neo4j configuration', async () => {
  clearGraphEnv()
  setDriverForTests(null)
  assert.deepEqual(await deleteDocumentGraph('c1', 'doc-1'), { skipped: true })
  setGraphEnv()
})

// ---------- reading ----------
test('overview: scoped to company and to the given documents; parallel edges collapse with a support count', async () => {
  const fake = makeFakeDriver((cypher) => {
    if (cypher.includes('AS mentionCount')) return [{ id: 'c1:PERSON:a', label: 'A', type: 'PERSON', degree: 2, documentCount: 1, mentionCount: 2 }, { id: 'c1:ISSUE:b', label: 'B', type: 'ISSUE', degree: 2, documentCount: 1, mentionCount: 1 }]
    if (cypher.includes('count(DISTINCT e) AS entities')) return [{ entities: 9 }]
    if (cypher.includes('count(r) AS relationships')) return [{ relationships: 4 }]
    if (cypher.includes('AS source')) return [{ source: 'c1:PERSON:a', target: 'c1:ISSUE:b', type: 'RESOLVED', confidence: 0.9 }, { source: 'c1:PERSON:a', target: 'c1:ISSUE:b', type: 'RESOLVED', confidence: 0.96 }]
    return []
  })
  setDriverForTests(fake)
  const g = await getGraphOverview('c1', { docIds: ['d1', 'd2'], limit: 10 })
  assert.ok(fake.state.calls.every((c) => c.params.companyId === 'c1' && c.params.docIds.join() === 'd1,d2'))
  assert.equal(g.edges.length, 1)
  assert.deepEqual([g.edges[0].supportCount, g.edges[0].confidence], [2, 0.96])
  assert.equal(g.truncated, true) // 9 entities exist, 2 shown
  assert.equal(typeof fake.state.calls[0].params.limit.toNumber, 'function') // LIMIT is sent as a Neo4j integer
})

test('overview with no documents does not even query Neo4j', async () => {
  const fake = makeFakeDriver()
  setDriverForTests(fake)
  const g = await getGraphOverview('c1', { docIds: [], limit: 10 })
  assert.deepEqual(g, { nodes: [], edges: [], stats: { entities: 0, relationships: 0 }, truncated: false })
  assert.equal(fake.state.calls.length, 0)
})

test('schema: uniqueness constraints on uid for every node label, idempotent statements', () => {
  for (const label of ['Entity', 'Document', 'Chunk']) {
    assert.ok(SCHEMA_STATEMENTS.some((s) => s.includes(`FOR (n:${label}) REQUIRE n.uid IS UNIQUE`) && s.includes('IF NOT EXISTS')))
  }
  assert.ok(SCHEMA_STATEMENTS.every((s) => s.includes('IF NOT EXISTS')))
})
