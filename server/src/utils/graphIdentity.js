// Knowledge-graph vocabulary and identity rules. Pure functions, no I/O.
//
// The entity and relationship types below are EXACTLY the enums of the NLP pipeline
// (server/nlp-service/ai/nlp/schemas.py). Relationship types are the only strings that are ever
// placed inside a Cypher query as a relationship label, and only after assertRelationType().
import { createHash } from 'node:crypto'

export const ENTITY_TYPES = Object.freeze([
  'PERSON', 'ORGANIZATION', 'TEAM', 'PROJECT', 'ISSUE', 'DECISION', 'MEETING',
  'DOCUMENT', 'TECHNOLOGY', 'PRODUCT', 'SERVICE', 'LOCATION', 'DATE',
])
export const RELATION_TYPES = Object.freeze([
  'RESOLVED', 'WORKED_ON', 'BELONGS_TO', 'CREATED', 'ASSIGNED_TO', 'DECIDED',
  'AFFECTED', 'PART_OF', 'USED', 'DEPENDS_ON', 'MIGRATED_TO', 'MENTIONED_IN',
])
const ENTITY_TYPE_SET = new Set(ENTITY_TYPES)
const RELATION_TYPE_SET = new Set(RELATION_TYPES)

export const isEntityType = (v) => typeof v === 'string' && ENTITY_TYPE_SET.has(v)
export const isRelationType = (v) => typeof v === 'string' && RELATION_TYPE_SET.has(v)

export function assertRelationType(value) {
  if (!isRelationType(value)) throw new Error('Unsupported relationship type')
  return value
}

// ---------- ids ----------

// The vector store ids a chunk as "<companyId>:<documentId>:<chunkIndex>"; the graph uses the
// same ids, so a graph fact and a vector hit for the same chunk are recognisably the same chunk.
export const chunkIdFor = (documentId, chunkIndex) => `${documentId}:${chunkIndex}`
export const chunkUid = (companyId, documentId, chunkIndex) => `${companyId}:${documentId}:${chunkIndex}`
export const documentUid = (companyId, documentId) => `${companyId}:${documentId}`

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 32)

// "The  Core Platform Team." -> "core platform team". Used for identity and for matching questions.
export function normalizeKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the\s+/, '')
    .replace(/^[\s"'`([{]+/, '')
    .replace(/[\s"'`)\]}.,;:!?]+$/, '')
}

// How far an entity of this kind may be merged.
//   'company'  : the same (type, normalized name) in different documents is ONE entity.
//   'document' : the name alone does not identify it, so it stays private to its document and is
//                never merged with a same-named entity elsewhere ("Alex", "Adopt Redis", "login issue").
// This is the single place to change the policy.
const GENERIC_TEAM_NAMES = new Set(['team', 'squad', 'guild', 'working group'])

export function identityScope({ type, key }) {
  switch (type) {
    case 'PERSON':
      return key.includes(' ') ? 'company' : 'document' // first names are ambiguous
    case 'DECISION':
    case 'MEETING':
      return 'document' // free-text / recurring: the words do not identify one specific item
    case 'ISSUE':
      return /^issue #/.test(key) ? 'company' : 'document' // only explicit ticket numbers are shared
    case 'TEAM':
      return GENERIC_TEAM_NAMES.has(key) ? 'document' : 'company' // "the team" is not one team
    case 'DATE':
      return /\d/.test(key) ? 'company' : 'document' // "Yesterday" differs per document
    default:
      return 'company'
  }
}

// Stable global id: company + type + normalized name (+ the document, for 'document' scope).
// The NLP run's own ids ("entity_1") are local to one chunk and are never used here.
export function entityIdentity(companyId, { type, normalized, text }, documentId) {
  const key = normalizeKey(normalized || text)
  const scope = identityScope({ type, key })
  const hash = sha(`${companyId}|${type}|${key}|${scope === 'document' ? documentId : ''}`)
  return { uid: `${companyId}:${type}:${hash}`, key, scope }
}

export const relationUid = (cUid, sourceUid, type, targetUid) => sha(`${cUid}|${sourceUid}|${type}|${targetUid}`)

// Shape check for an entity id coming from a URL. The company prefix is checked separately.
export const ENTITY_UID_REGEX = /^[\w-]{1,64}:[A-Z_]{3,20}:[0-9a-f]{32}$/
export const entityUidBelongsTo = (uid, companyId) =>
  typeof uid === 'string' && ENTITY_UID_REGEX.test(uid) && uid.startsWith(`${companyId}:`)

// ---------- matching a question against entity names ----------

const STOPWORDS = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'what', 'who', 'whom', 'which', 'when', 'where', 'why', 'how', 'do', 'does', 'did', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'with', 'about', 'our', 'we', 'us', 'it', 'its', 'this', 'that', 'by', 'from', 'at', 'be', 'me', 'my', 'tell', 'show', 'give', 'any', 'has', 'have', 'had'])

// Candidate entity keys from a question: every 1-4 word phrase, normalized like entity names.
// Single stopwords and very short words are skipped. Exact matching only, so a short word cannot
// pull in unrelated entities.
export function questionKeys(question, { max = 60 } = {}) {
  const tokens = (String(question ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}#][\p{L}\p{N}#.+_-]*/gu) || [])
    .map((t) => t.replace(/[.,;:!?]+$/, ''))
    .filter(Boolean)
  const keys = new Set()
  for (let size = 4; size >= 1; size -= 1) {
    for (let i = 0; i + size <= tokens.length; i += 1) {
      const words = tokens.slice(i, i + size)
      if (size === 1 && (STOPWORDS.has(words[0]) || words[0].length < 3)) continue
      if (STOPWORDS.has(words[0]) && size > 1 && STOPWORDS.has(words[words.length - 1])) continue
      keys.add(normalizeKey(words.join(' ')))
      if (keys.size >= max) return [...keys]
    }
  }
  return [...keys]
}
