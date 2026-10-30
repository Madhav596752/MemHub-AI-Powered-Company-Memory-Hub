// Document -> NLP -> Neo4j, as a step AFTER the existing vector indexing.
//
//   chunkDocument(doc)  (the same chunker the vector index uses, so chunk numbers match)
//     -> NLP service /extract  -> validated entities + relationships
//     -> one Neo4j transaction that replaces this document's graph contribution
//
// processDocumentGraph() NEVER throws: a failure here must not break upload or vector indexing.
// The outcome is returned and stored (GraphIngestion table) so it can be shown and retried with
// POST /api/graph/documents/:id/reprocess. Nothing is written to the graph unless every chunk was
// processed, so a failed run leaves the previous graph state untouched.
import prisma from '../prisma.js'
import { chunkDocument } from './chunker.js'
import { chunkIdFor } from './graphIdentity.js'
import { buildIngestPayload, replaceDocumentGraph } from './graphStore.js'
import { GraphError, isNeo4jConfigured } from './neo4j.js'
import { NlpError, extractChunks, isNlpConfigured } from './nlpClient.js'

const PIPELINE = 'memhub-nlp-v1-hybrid'
const inFlight = new Map() // one run per document at a time

async function recordStatus(doc, result) {
  try {
    const base = { companyId: doc.companyId, status: result.status, errorCode: result.code ?? null }
    if (result.status === 'processed') {
      const data = {
        ...base,
        entityCount: result.entities ?? 0,
        relationshipCount: result.relationships ?? 0,
        pipeline: PIPELINE,
        processedAt: new Date(),
      }
      await prisma.graphIngestion.upsert({ where: { documentId: doc.id }, create: { documentId: doc.id, ...data }, update: data })
    } else {
      // A failed or skipped run wrote NOTHING to the graph (see run()), so the document's earlier graph
      // contribution is still there. Only the status changes; the counts and processedAt of the last
      // successful run stay, instead of being reset to 0 while the graph still shows those entities.
      await prisma.graphIngestion.upsert({
        where: { documentId: doc.id },
        create: { documentId: doc.id, ...base, entityCount: 0, relationshipCount: 0, pipeline: null, processedAt: null },
        update: base,
      })
    }
  } catch (err) {
    // e.g. the migration was not applied yet. The graph itself is still correct.
    console.error('[graph] could not store the processing status:', err?.code || err?.message)
  }
}

function describe(err) {
  if (err instanceof NlpError || err instanceof GraphError) return { code: err.code, message: err.message }
  console.error('[graph] unexpected error:', err?.name, err?.message)
  return { code: 'GRAPH_PROCESSING_FAILED', message: 'The document could not be added to the knowledge graph.' }
}

async function run(doc) {
  const empty = { entities: 0, relationships: 0, relationshipStatus: 'not_run', chunks: 0 }
  let result
  try {
    if (!isNeo4jConfigured()) {
      result = { status: 'skipped', code: 'GRAPH_NOT_CONFIGURED', message: 'The knowledge graph is not configured.', ...empty }
    } else if (!isNlpConfigured()) {
      result = { status: 'skipped', code: 'NLP_NOT_CONFIGURED', message: 'The NLP service is not configured.', ...empty }
    } else {
      const chunks = chunkDocument(doc).map((c) => ({ ...c, chunkId: chunkIdFor(doc.id, c.chunkIndex) }))
      if (chunks.length === 0) {
        result = { status: 'skipped', code: 'NO_TEXT', message: 'This document has no text to analyse.', ...empty }
      } else {
        const { extractions, failedChunkIds, dropped } = await extractChunks(doc.id, chunks)
        if (failedChunkIds.length > 0) {
          console.error(`[graph] document=${doc.id} NLP failed for ${failedChunkIds.length} of ${chunks.length} chunk(s); graph left unchanged`)
          result = { status: 'failed', code: 'NLP_CHUNK_FAILED', message: 'Some parts of the document could not be analysed. Reprocess it to try again.', ...empty, chunks: chunks.length }
        } else {
          const payload = buildIngestPayload(doc.companyId, doc, chunks, extractions)
          await replaceDocumentGraph(doc.companyId, doc, payload)
          // 'processed' means entity extraction AND the graph write succeeded. relationshipStatus says whether
          // the text actually stated any relationship: 'none' is a true result for a text without them, not a failure.
          result = {
            status: 'processed',
            entities: payload.stats.entities,
            relationships: payload.stats.relationships,
            relationshipStatus: payload.stats.relationships > 0 ? 'extracted' : 'none',
            chunks: chunks.length,
          }
          console.log(`[graph] document=${doc.id} entities=${payload.stats.entities} mentions=${payload.stats.mentions} relationships=${payload.stats.relationships} droppedByValidation=${dropped} selfLoopsSkipped=${payload.stats.skippedRelationships}`)
        }
      }
    }
  } catch (err) {
    result = { status: 'failed', ...describe(err), ...empty }
  }
  console.log(`[graph] document=${doc.id} status=${result.status} relationships=${result.relationshipStatus}${result.code ? ` code=${result.code}` : ''}`)
  await recordStatus(doc, result)
  return result
}

// doc: { id, companyId, originalName, extractedText }
export function processDocumentGraph(doc) {
  const key = `${doc.companyId}:${doc.id}`
  if (inFlight.has(key)) return inFlight.get(key) // the same run is already going: join it, do not start a second
  const promise = run(doc).finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}
