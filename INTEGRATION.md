# MemHub: NLP + Knowledge Graph + Hybrid GraphRAG

```
Upload -> text extraction -> chunking (JS) -> embeddings + ChromaDB          (unchanged)
                                   |
                                   +-> NLP service (Python, localhost, token) -> entities + relationships
                                         -> Neo4j (company-scoped, with evidence + document/chunk provenance)

Question -> /api/ask -> ChromaDB chunks ---------------+
                     -> Neo4j facts around their entities  -> PostgreSQL ownership check
                        and around entities named in the question -> dedupe, limit -> ONE Groq call -> answer + citations
```

The graph is **optional**. Without `NEO4J_*` / `NLP_SERVICE_TOKEN` everything else works exactly as before.

## Setup

1. `cd server && npm install` (adds `neo4j-driver`)
2. Apply the new table: `npx prisma migrate deploy` (migration `20261014000000_graph_ingestion`), then `npx prisma generate`
3. Neo4j 5.x (Community is enough), e.g. Docker: `docker run -p 7687:7687 -p 7474:7474 -e NEO4J_AUTH=neo4j/<password> neo4j:5`
4. `server/.env`: set `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NLP_SERVICE_URL`, `NLP_SERVICE_TOKEN` (see `.env.example`)
5. Constraints/indexes: created automatically at server start; or `npm run graph:setup`
6. NLP service: see `server/nlp-service/README.md`
7. Existing documents: `npm run graph:reprocess` (safe to repeat)

## Run (4 terminals)

```bash
# 1 embedding service (unchanged)    cd server/embedding-service && EMBEDDING_SERVICE_TOKEN=... uvicorn app:app --host 127.0.0.1 --port 8001
# 2 NLP service                      cd server/nlp-service && NLP_SERVICE_TOKEN=... uvicorn app:app --host 127.0.0.1 --port 8002
# 3 API                              cd server && npm run dev
# 4 frontend                         npm run dev
```

## Graph model

`(:Document)-[:HAS_CHUNK]->(:Chunk)-[:MENTIONS {surfaces, startChars, endChars, confidence}]->(:Entity {uid, companyId, type, name, normalizedKey})`
and `(:Entity)-[:RESOLVED|WORKED_ON|BELONGS_TO|CREATED|ASSIGNED_TO|DECIDED|AFFECTED|PART_OF|USED|DEPENDS_ON|MIGRATED_TO|MENTIONED_IN {documentId, chunkId, chunkIndex, evidence, confidence}]->(:Entity)`
(exactly the 12 relationship types of the NLP pipeline; one edge per supporting chunk, so each fact keeps its own evidence and document).

Entity identity = company + type + normalized name. **Not merged across documents** (kept per document): first-name-only
people, decisions, meetings, descriptive issues ("login issue"), generic "the team", relative dates. Merged company-wide:
technologies, organisations, projects, multi-word people, named teams, ticket numbers, absolute dates.
Limitation: two genuinely different projects with the same name in one company are merged (mentions stay traceable).

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/graph?limit=80` | most connected entities + relationships (company from JWT) |
| GET | `/api/graph/status` | graph enabled/connected, per-status document counts |
| GET | `/api/graph/nodes/:id` | one entity: relationships with evidence + documents, mentions |
| POST | `/api/graph/documents/:id/reprocess` | re-run NLP + graph for one document (**ADMIN only**) |
| POST | `/api/ask` | unchanged shape + `sources[].kind` (`chunk`/`graph`), `graphFacts`, `retrieval` |
| POST | `/api/documents` | response gains `graph: { status, entities, relationships }` |

## Roles and permissions (RBAC)

Roles are the Prisma `Role` enum (`ADMIN`, `MEMBER`). The rules live in ONE place: `server/src/middleware/permissions.js`
(`PERMISSIONS` + `requirePermission(name)`, built on `requireRole`). An unknown permission name throws when the route is defined.

| | MEMBER | ADMIN |
|---|---|---|
| Upload, list, read documents; search; ask; read the graph; list teammates (`GET /api/users`) | yes | yes |
| `DELETE /api/documents/:id`, `POST /api/documents/:id/reindex`, `POST /api/graph/documents/:id/reprocess` | no (403) | yes |
| `PATCH /api/users/:id/role`, `DELETE /api/users/:id` | no (403) | yes |
| Reserved for routes that do not exist yet: `company:configure`, `integration:manage` (meetings, GitHub), `credentials:manage` | no | yes |

- Role is never read from a request body. It is set only at registration (`MEMBER` when joining, `ADMIN` only for the creator of a NEW company) and by `PATCH /api/users/:id/role`.
- Privileged routes check the role in the JWT **and** re-read role + company from PostgreSQL, so a demoted or removed user loses these powers immediately (not after the 15-minute token expiry).
- A role never grants access across companies: every resource is looked up by id AND `req.user.companyId`; another company's document or user is `404`.
- A company always keeps at least one `ADMIN` (last-admin demotion is `409`; you cannot remove yourself).
- `scripts/reindex-all.js` and `scripts/reprocess-graph.js` are operator tools run on the server with database access; they are not reachable over HTTP.

## Tests

```bash
cd server && npm test                 # node:test (unit + route tests; Neo4j tests are skipped without a database)
cd server && npm run test:neo4j       # REAL Neo4j: set NEO4J_* first (throw-away database)
cd server/nlp-service && python -m pytest -q
npm test && npm run build             # frontend (vitest) + production build
```

## Not done (see final report)
Meeting transcription, BiLSTM classifier, Redis, GitHub ingestion.
