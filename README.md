# MemHub — Frontend

MemHub is a company knowledge/memory platform. This is the frontend: an AI assistant that
answers questions with cited sources, a document library with upload + indexing status, a
knowledge graph to explore how docs/people/projects connect, and basic usage analytics.

This repo is just the UI — it currently runs on mock data (see `src/data/mockData.js`) so it
can be developed and demoed without a backend.

## Tech stack

- React 19 + Vite
- React Router for routing
- Tailwind CSS (with the shadcn/ui-style component pattern under `src/components/ui`)
- Radix UI primitives (dialog, dropdown, tooltip, etc.) under the hood of those components
- Recharts for the dashboard/analytics charts
- Sonner for toast notifications

## Project structure

```
src/
  components/     shared UI (Sidebar, TopBar, StatCard, etc.) and components/ui (button, input, ...)
  pages/          one file per route (Dashboard, AIAssistant, Documents, Search, ...)
  contexts/       ThemeContext (light/dark/system)
  data/           mockData.js — all the fake data the UI runs on right now
  lib/            small utils (cn helper)
  App.jsx         routes
  main.jsx        entry point
```

## Getting started

```bash
npm install
npm run dev
```

The app runs at `http://localhost:5173`. `/` is the marketing landing page, `/login` and
`/register` are real auth screens (Phase 1B), and everything under `/app` is the actual product
and requires login.

Other scripts:

```bash
npm run build     # production build
npm run preview   # preview the production build locally
npm run lint      # oxlint
```

## Backend (Phase 1A foundation)

A minimal Express + PostgreSQL + Prisma backend lives in `server/`. Setup:

```bash
cd server
npm install
cp .env.example .env        # then fill in DATABASE_URL, PORT, FRONTEND_URL
npx prisma generate
npx prisma migrate dev --name init
npm run dev                 # API at http://localhost:5000, health: /api/health
```

In development Vite proxies `/api/*` to `http://localhost:5000` (see `vite.config.js`).
The frontend pages still run on mock data and are not wired to the API yet.

## Authentication (Phase 1B)

Add these to `server/.env` (see `server/.env.example`):

```env
JWT_ACCESS_SECRET=<long random string>
JWT_REFRESH_SECRET=<a different long random string>
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
```

Endpoints: `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/refresh`,
`POST /api/auth/logout`, `POST /api/auth/logout-all`,
`GET /api/auth/me` (needs `Authorization: Bearer <access-token>`).

### Sessions, logout and refresh-token revocation

- Every login/registration starts a **session**. The refresh token is tracked in the `RefreshToken` table
  (**only a keyed hash is stored, never the token**) -> run `cd server && npx prisma migrate deploy`
  (dev: `npx prisma migrate dev`) and `npx prisma generate`.
- Refresh tokens are **single-use**. `POST /api/auth/refresh` returns a new `accessToken` **and a new `refreshToken`**
  (the frontend stores it automatically). Replaying an already-used token is rejected; if it happens after
  `REFRESH_REUSE_GRACE_SECONDS` (default 10) the whole session is revoked (theft detection).
  A replay inside the grace window (two tabs refreshing at once) is only rejected.
- `POST /api/auth/logout` `{ "refreshToken": "..." }` revokes that one session (works with an expired access token, safe to call twice).
  `POST /api/auth/logout-all` (needs the access token) revokes every session of the signed-in user.
- A session keeps its original expiry (`JWT_REFRESH_EXPIRES_IN` after login). Rotation does not extend it.
- **After deploying, everybody must log in once**: refresh tokens issued before this change are not tracked and are rejected.
- Limitation: access tokens are stateless, so an access token stays valid until it expires (`JWT_ACCESS_EXPIRES_IN`, 15 min)
  even after logout. Keep that value short.

### Rate limiting

Limits apply to register, login (failed attempts only, per IP and per IP+email), refresh/logout, and `/api/ask` (per signed-in user).
They are configured with `RATE_LIMIT_*` variables (see `server/.env.example`) and answer `429` with a `Retry-After` header.

- **One backend instance:** nothing to do, counters live in memory (reset on restart).
- **Several instances / production:** set `REDIS_URL`. Without it every instance counts on its own, so the real limit is
  *N x* the configured one. Set `RATE_LIMIT_REQUIRE_REDIS=true` to refuse to start in production without Redis.
  If Redis is unreachable the limiter fails open (requests are allowed, the error is logged) and recovers by itself.
- **Behind a reverse proxy / load balancer:** set `TRUST_PROXY` to the number of proxy hops (e.g. `1`). Otherwise all users
  share the proxy's IP. `TRUST_PROXY=true` is refused (it would let clients spoof their IP).

### Security headers

Helmet is enabled (JSON-only CSP `default-src 'none'`, `nosniff`, frame denial, no `X-Powered-By`, HSTS in production
without `includeSubDomains`), and `Cache-Control: no-store` is set on `/api/auth/*`. CORS is unchanged
(`FRONTEND_URL` only, no cookies are used). If you serve the React build from the same host, add the HTTPS redirect and
the frontend's own CSP at that web server.

### Redis cache (Phase 9)

With `REDIS_URL` set, MemHub also caches complete `/api/ask` answers and the two knowledge-graph reads
(`GET /api/graph`, `GET /api/graph/nodes/:id`). Without it nothing is cached and the app behaves as before; a Redis outage
never stops it (reads become misses, the connection is retried in the background). Responses carry `X-Cache: HIT|MISS`
only while caching is active for the request.

- Every key starts with the company id and contains the company's **knowledge-base version** (`Company.knowledgeVersion`
  in PostgreSQL, advanced by upload, delete, reindex and graph reprocess). Apply the migration first:
  `cd server && npx prisma migrate deploy`. Until it is applied both caches stay off.
- Answers are additionally keyed by the caller's role (read from PostgreSQL, not from the token) and by the retrieval
  configuration. Errors, "not grounded" answers and answers built while Neo4j was down are never cached.
- Switches and lifetimes: `ASK_CACHE_ENABLED`, `ASK_CACHE_TTL`, `GRAPH_CACHE_ENABLED`, `GRAPH_CACHE_TTL`,
  `REDIS_CACHE_TTL`, `REDIS_CONNECT_TIMEOUT`, `KB_CHANGE_LEASE_SECONDS`, `KB_UNCERTAIN_GRACE_SECONDS` (see `server/.env.example`).
- Local Redis: `docker run -d --name memhub-redis -p 6379:6379 redis:7` (or `sudo apt install redis-server`), then
  `REDIS_URL=redis://localhost:6379` in `server/.env`.

### Tests

```bash
cd server && npm test            # all backend tests; Redis is faked, no database needed
cd server && npm run test:redis  # tests against a REAL Redis: starts its own `redis-server` on a free port
                                 # (needs the redis-server binary; skipped without it). The two older files
                                 # (rate limiter, redisCache.redis.test.js) also use REDIS_URL, e.g.
                                 # REDIS_URL=redis://127.0.0.1:6379 npm run test:redis
cd .. && npm test                # frontend tests
```

## Documents (Phase 2)

Users can upload PDF, DOCX and TXT files (max 10 MB). The file is stored in **Cloudinary**;
PostgreSQL stores only the metadata, the Cloudinary URL/public ID and the **extracted text**
(prepared for later NLP/RAG phases). Every document belongs to a company and is always
filtered by `req.user.companyId` from the JWT — never by anything the frontend sends.

Add your Cloudinary credentials to `server/.env` (see `server/.env.example`):

```env
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

Then install the new packages and apply the database migration:

```bash
cd server
npm install
npx prisma migrate dev      # applies prisma/migrations/*_phase2_documents
```

Endpoints (all need `Authorization: Bearer <access-token>`):

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/documents` | Upload (`multipart/form-data`, field name `file`) |
| `GET` | `/api/documents` | List the company's documents |
| `GET` | `/api/documents/:id` | Document info + text preview |
| `DELETE` | `/api/documents/:id` | Delete from Cloudinary and PostgreSQL |

Responses look like `{ "success": true, "document": {...} }` or `{ "success": false, "message": "..." }`.

Requires Node 20.16+ / 22.3+ (needed by `pdf-parse`).

## Notes

- Documents are real from Phase 2 on. Search, analytics, the knowledge graph and the AI assistant
  still run on mock data (later phases).

## Phase 3 — Part 1: RAG foundation

- `server/src/utils/chunker.js` — splits `Document.extractedText` into ordered, overlapping chunks
  (`CHUNK_SIZE` / `CHUNK_OVERLAP`, defaults 1000 / 200 characters).
- `server/src/utils/embeddings.js` — Node client for the embedding service.
- `server/embedding-service/` — Python service running `sentence-transformers/all-MiniLM-L6-v2`
  (384 dimensions). See its README for install/run steps.
- Add to `server/.env`: `EMBEDDING_SERVICE_URL=http://localhost:8001`
- Tests: `cd server && npm test`

## Run everything (3 terminals)

Prerequisites: Node 20.16+/22.3+, PostgreSQL running, Python 3.9+, a Cloudinary account.

```bash
# 0) one-time setup
cd server
cp .env.example .env            # fill DATABASE_URL, JWT secrets, CLOUDINARY_*
npm install
npx prisma generate
npx prisma migrate deploy       # (or: npx prisma migrate dev)
cd ..
npm install                     # frontend deps

# Terminal 1 - API (http://localhost:5000)
cd server && npm run dev

# Terminal 2 - frontend (http://localhost:5173)
npm run dev

# Terminal 3 - embedding service (http://localhost:8001)
cd server/embedding-service
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8001

# Tests
cd server && npm test
```

## Phase 3 — Part 2: RAG retrieval pipeline

Flow: upload -> text extracted (Phase 2) -> `chunker.js` -> Python service embeds each chunk with
MiniLM -> chunks + vectors stored in ChromaDB (persistent, `CHROMA_PATH`) -> searchable.

- `server/src/utils/vectorStore.js` — Node client: `indexDocument`, `searchChunks`, `deleteDocumentChunks`.
- `server/src/routes/search.js` — `POST /api/search` with `{ "query": "...", "limit": 5 }` (limit 1–20, optional).
  Returns `{ success, query, results: [{ text, documentId, documentName, chunkIndex, startChar, endChar, distance, score }] }`.
  `distance` is cosine distance (0 = identical), `score = 1 - distance`. No page numbers are returned
  because uploads do not record them; `startChar/endChar` point into the document's extracted text.
- `POST /api/documents` now also indexes the new document and returns `indexing: { status, chunks | message }`.
  If indexing fails the document is still saved and `status` is `"failed"`.
- `POST /api/documents/:id/reindex` retries / rebuilds a document's chunks (replaces, never duplicates).
- `DELETE /api/documents/:id` also deletes the document's vectors first.
- Every query and delete is filtered by `req.user.companyId` from the JWT, inside the Chroma call.

Run the tests: `cd server && npm test` (fast tests, need no services).
End-to-end test (needs PostgreSQL + the running Python service, use a throw-away vector store):
`CHROMA_PATH=./chroma_test_data uvicorn app:app --port 8001`, then `RAG_INTEGRATION=1 npm test`.

## Phase 3 — Part 3: RAG question answering with citations

Flow: question -> `POST /api/ask` (JWT) -> `searchChunks(req.user.companyId, ...)` -> chunks re-checked
against PostgreSQL for the same company -> low-similarity chunks dropped -> question + excerpts sent
to the LLM -> answer + citations returned. The LLM is called from the server only.

- `server/src/routes/ask.js` — `POST /api/ask` with `{ "question": "..." }` (max 1000 characters).
  Any `companyId` in the request is ignored; the company always comes from the JWT.
  Returns `{ success, grounded, answer, sources: [{ ref, documentId, documentName, chunkIndex, text, startChar, endChar, score }] }`.
  `grounded: false` means nothing relevant was found or the context was not enough; `sources` is then `[]`.
- `server/src/utils/llm.js` — Groq chat-completions client (plain `fetch`), prompt, JSON parsing and citation checks.
- Citations are built from the retrieved chunks, looked up by the excerpt numbers the model cites.
  A number that was not sent to the model is discarded; an answer with no valid citation is not shown as grounded.
- Frontend: `src/pages/AIAssistant.jsx` (question box, loading state, error, answer, sources panel).

Add to `server/.env` (never commit real keys):

```env
GROQ_API_KEY=<your key>
LLM_MODEL=llama-3.3-70b-versatile   # any model available to your Groq key
# optional: LLM_TIMEOUT_MS=30000  RAG_TOP_K=5  RAG_MIN_SCORE=0.25  RAG_MAX_CONTEXT_CHARS=6000
```

`npm test` now runs with `--experimental-test-module-mocks` (the route tests replace Prisma with an
in-memory table). End-to-end test: `RAG_INTEGRATION=1 node --test src/ask.integration.test.js`
(same prerequisites as the Part 2 end-to-end test; the LLM is faked, no API key needed).

## Knowledge graph and hybrid GraphRAG

See [INTEGRATION.md](INTEGRATION.md) for the NLP service, Neo4j graph, setup, API and tests.
