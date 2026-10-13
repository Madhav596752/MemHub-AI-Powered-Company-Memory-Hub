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
`GET /api/auth/me` (needs `Authorization: Bearer <access-token>`).
No schema change was needed, so there is no new Prisma migration.

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
