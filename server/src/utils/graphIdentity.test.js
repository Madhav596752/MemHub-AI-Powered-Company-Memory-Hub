import test from 'node:test'
import assert from 'node:assert/strict'
import { RELATION_TYPES, assertRelationType, entityIdentity, entityUidBelongsTo, identityScope, normalizeKey, questionKeys } from './graphIdentity.js'

const id = (companyId, type, text, documentId = 'doc-1', normalized) => entityIdentity(companyId, { type, text, normalized }, documentId)

test('relationship types: only the NLP schema types pass; anything else (injection included) is rejected', () => {
  assert.equal(RELATION_TYPES.length, 12)
  for (const t of RELATION_TYPES) assert.equal(assertRelationType(t), t)
  for (const bad of ['resolved', 'RELATES_TO', 'RESOLVED`) DETACH DELETE (n', '', null, undefined, 42, {}]) {
    assert.throws(() => assertRelationType(bad), /Unsupported relationship type/)
  }
})

test('same company + type + normalized name -> same stable id, regardless of casing and spacing', () => {
  const a = id('c1', 'TECHNOLOGY', 'postgres', 'doc-1', 'PostgreSQL')
  const b = id('c1', 'TECHNOLOGY', 'PostgreSQL', 'doc-2', 'PostgreSQL')
  const c = id('c1', 'TECHNOLOGY', '  postgresql ', 'doc-3')
  assert.equal(a.uid, b.uid)
  assert.equal(a.uid, c.uid)
  assert.match(a.uid, /^c1:TECHNOLOGY:[0-9a-f]{32}$/)
})

test('the same name in two companies never shares an id', () => {
  assert.notEqual(id('company-A', 'PROJECT', 'Project Phoenix').uid, id('company-B', 'PROJECT', 'Project Phoenix').uid)
})

test('the same name with a different type is a different entity', () => {
  assert.notEqual(id('c1', 'PROJECT', 'Phoenix').uid, id('c1', 'PRODUCT', 'Phoenix').uid)
})

test('ambiguous entities are NOT merged across documents', () => {
  // first names, free-text decisions, generic issues, "the team", relative dates
  for (const [type, text] of [['PERSON', 'Alex'], ['DECISION', 'Adopt Redis'], ['ISSUE', 'login issue'], ['TEAM', 'the team'], ['DATE', 'Yesterday'], ['MEETING', 'Architecture Review meeting']]) {
    assert.equal(identityScope({ type, key: normalizeKey(text) }), 'document', `${type} ${text}`)
    assert.notEqual(id('c1', type, text, 'doc-1').uid, id('c1', type, text, 'doc-2').uid, `${type} ${text} must stay per document`)
    assert.equal(id('c1', type, text, 'doc-1').uid, id('c1', type, text, 'doc-1').uid, 'but stay stable inside one document')
  }
})

test('identifying entities ARE merged across documents', () => {
  for (const [type, text, norm] of [['PERSON', 'Rahul Sharma'], ['PROJECT', 'Project Apollo'], ['TEAM', 'The Core Platform team'], ['ISSUE', 'issue #402', 'Issue #402'], ['DATE', 'October 8, 2026'], ['ORGANIZATION', 'Stripe']]) {
    assert.equal(id('c1', type, text, 'doc-1', norm).uid, id('c1', type, text, 'doc-2', norm).uid, `${type} ${text}`)
  }
})

test('entity id from a URL must carry the caller\'s company prefix', () => {
  const { uid } = id('company-A', 'PROJECT', 'Project Apollo')
  assert.equal(entityUidBelongsTo(uid, 'company-A'), true)
  assert.equal(entityUidBelongsTo(uid, 'company-B'), false)
  assert.equal(entityUidBelongsTo(uid, 'company'), false)
  for (const bad of ['', 'x', 'company-A:PROJECT:short', "company-A:PROJECT:zzzz'; MATCH (n) DETACH DELETE n //", null, 5]) assert.equal(entityUidBelongsTo(bad, 'company-A'), false)
})

test('questionKeys: phrases normalised like entity names, stopwords skipped, bounded', () => {
  const keys = questionKeys('What did the Core Platform team decide about Postgres and issue #402?')
  for (const k of ['core platform team', 'postgres', 'issue #402', 'core platform']) assert.ok(keys.includes(k), k)
  for (const k of ['what', 'the', 'did', 'and']) assert.ok(!keys.includes(k), `stopword ${k}`)
  assert.deepEqual(questionKeys(''), [])
  assert.ok(questionKeys('word '.repeat(500)).length <= 60)
})
