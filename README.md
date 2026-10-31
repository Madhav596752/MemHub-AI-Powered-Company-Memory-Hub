# MemHub — AI-Powered Company Memory Hub

MemHub is a company knowledge platform. Teams upload documents (PDF / DOCX / TXT), and MemHub indexes them so anyone can:

- **Ask questions** and get answers with cited sources (RAG)
- **Search** documents semantically
- **Explore a knowledge graph** of people, projects, technologies and decisions extracted from the documents (GraphRAG)
- **Manage users** with role-based access (ADMIN / MEMBER), scoped per company

---

## Table of contents

1. [Architecture](#architecture)
2. [Tech stack](#tech-stack)
3. [Prerequisites](#prerequisites)
4. [One-time setup](#one-time-setup)
5. [Environment variables](#environment-variables)
6. [Run the project (terminal-wise)](#run-the-project-terminal-wise)
7. [Optional services (Neo4j, Redis)](#optional-services-neo4j-redis)
8. [Useful scripts](#useful-scripts)
9. [Tests](#tests)
10. [API reference](#api-reference)
11. [Roles and permissions](#roles-and-permissions)
12. [Project structure](#project-structure)
13. [Troubleshooting](#troubleshooting)

---

## Architecture

```
Upload -> text extraction -> chunking -> embeddings -> ChromaDB (vectors)
                                   |
                                   +-> NLP service -> entities + relationships -> Neo4j (graph)

Question -> /api/ask -> ChromaDB chunks + Neo4j facts -> PostgreSQL ownership check
                     -> ONE Groq LLM call -> answer + citations
```

| Service | Port | Required? |
| --- | --- | --- |
| Frontend (React + Vite) | 5173 | Yes |
| Backend API (Express + Prisma) | 5000 | Yes |
| Embedding service (Python, ChromaDB) | 8001 | Yes |
| NLP service (Python, spaCy) | 8002 | Optional (knowledge graph) |
| PostgreSQL | 5432 | Yes |
| Neo4j | 7687 / 7474 | Optional (knowledge graph) |
| Redis | 6379 | Optional (cache + shared rate limits) |

The knowledge graph and Redis are **optional**: without their env variables everything else works as normal.

---

## Tech stack

- **Frontend:** React 19, Vite, React Router, Tailwind CSS, Radix UI, Recharts, Sonner
- **Backend:** Node.js, Express, Prisma, PostgreSQL, JWT auth (access + rotating refresh tokens), Helmet, rate limiting
- **Storage:** Cloudinary (files), PostgreSQL (metadata + extracted text), ChromaDB (vectors), Neo4j (graph)
- **AI / NLP:** sentence-transformers `all-MiniLM-L6-v2` (embeddings), Groq `llama-3.3-70b-versatile` (answers), spaCy + rule patterns (entities/relations)
- **Optional:** Redis (answer cache, graph cache, distributed rate limiting)

---

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | 20.16+ or 22.3+ |
| npm | comes with Node |
| PostgreSQL | running locally or hosted |
| Python | 3.10+ (3.9 minimum) |
| Cloudinary account | free tier is enough |
| Groq API key | https://console.groq.com |

Check versions:

```bash
node -v
npm -v
python --version        # on Linux/macOS you may need: python3 --version
psql --version
```

Create the database once:

```bash
# Linux / macOS
psql -U postgres -c "CREATE DATABASE memhub;"

# Windows (PowerShell) - same command, psql must be on PATH
psql -U postgres -c "CREATE DATABASE memhub;"
```

---

## One-time setup

Run these once after cloning / unzipping the project. All commands start from the **project root** (the folder that has the root `package.json`).

### Step 1 — Frontend dependencies

```bash
npm install
```

### Step 2 — Backend dependencies + database

```bash
cd server
npm install
```

Create your env file:

```bash
# Linux / macOS / Git Bash
cp .env.example .env

# Windows PowerShell
copy .env.example .env
```

Open `server/.env` and fill it in (see [Environment variables](#environment-variables)), then:

```bash
npx prisma generate
npx prisma migrate deploy
cd ..
```

> For development you can use `npx prisma migrate dev` instead of `migrate deploy`.

### Step 3 — Embedding service (Python)

```bash
cd server/embedding-service
python -m venv .venv
```

Activate the virtual environment:

```bash
# Linux / macOS
source .venv/bin/activate

# Windows PowerShell
.venv\Scripts\Activate.ps1

# Windows CMD
.venv\Scripts\activate.bat
```

Install:

```bash
pip install -r requirements.txt
cd ../..
```

> The first run downloads the ~90 MB MiniLM model (internet needed once, cached after).

### Step 4 — NLP service (Python, optional — only for the knowledge graph)

```bash
cd server/nlp-service
python -m venv .venv
```

Activate it (same commands as Step 3), then:

```bash
pip install -r requirements.txt
python -m spacy download en_core_web_sm
cd ../..
```

> Without `en_core_web_sm`, person detection is much weaker (the service falls back to heuristics).

---

## Environment variables

All backend config lives in **`server/.env`**. The Python services also read their token from this same file, so you only need to set each value once.

### Generate secrets

Run this four times (JWT access, JWT refresh, embedding token, NLP token). **All four must be different.**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Minimum required `server/.env`

```env
# PostgreSQL
DATABASE_URL="postgresql://postgres:password@localhost:5432/memhub?schema=public"

PORT=5000
FRONTEND_URL=http://localhost:5173

# JWT (two DIFFERENT long random strings)
JWT_ACCESS_SECRET=<random-1>
JWT_REFRESH_SECRET=<random-2>
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# Cloudinary
CLOUDINARY_CLOUD_NAME=<your-cloud-name>
CLOUDINARY_API_KEY=<your-api-key>
CLOUDINARY_API_SECRET=<your-api-secret>

# Embedding service
EMBEDDING_SERVICE_URL=http://localhost:8001
EMBEDDING_SERVICE_TOKEN=<random-3>

# LLM (Groq) - server side only
GROQ_API_KEY=<your-groq-key>
LLM_MODEL=llama-3.3-70b-versatile
```

### Add these for the knowledge graph (optional)

```env
NEO4J_URI=bolt://localhost:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=<your-neo4j-password>

NLP_SERVICE_URL=http://localhost:8002
NLP_SERVICE_TOKEN=<random-4>        # must differ from EMBEDDING_SERVICE_TOKEN
```

### Add this for Redis cache (optional)

```env
REDIS_URL=redis://localhost:6379
```

> `.env.example` ends with an empty `REDIS_URL=""` line. If you set a real Redis URL, make sure that empty line is removed or replaced so only one `REDIS_URL` exists.

Never commit `server/.env`. It is already in `.gitignore`.

---

## Run the project (terminal-wise)

Open **4 terminals** (3 if you skip the knowledge graph). Always start from the project root.

### Terminal 1 — Embedding service (port 8001)

```bash
cd server/embedding-service

# Linux / macOS
source .venv/bin/activate
# Windows PowerShell
.venv\Scripts\Activate.ps1

uvicorn app:app --host 127.0.0.1 --port 8001
```

Check: http://127.0.0.1:8001/health

### Terminal 2 — NLP service (port 8002) — optional

```bash
cd server/nlp-service

# Linux / macOS
source .venv/bin/activate
# Windows PowerShell
.venv\Scripts\Activate.ps1

uvicorn app:app --host 127.0.0.1 --port 8002
```

Check: http://127.0.0.1:8002/health (`nerMode` should be `spacy-ner`; `heuristic-fallback` means the spaCy model is missing)

### Terminal 3 — Backend API (port 5000)

```bash
cd server
npm run dev
```

Check: http://localhost:5000/api/health

### Terminal 4 — Frontend (port 5173)

```bash
npm run dev
```

Open: **http://localhost:5173**

- `/` landing page
- `/register` create your account (the first user of a new company becomes ADMIN)
- `/login` sign in
- `/app/...` the product (login required)

Vite automatically proxies `/api/*` to `http://localhost:5000`.

### Start order summary

| # | Terminal | Folder | Command |
| --- | --- | --- | --- |
| 1 | Embedding | `server/embedding-service` | `uvicorn app:app --host 127.0.0.1 --port 8001` |
| 2 | NLP (optional) | `server/nlp-service` | `uvicorn app:app --host 127.0.0.1 --port 8002` |
| 3 | API | `server` | `npm run dev` |
| 4 | Frontend | project root | `npm run dev` |

---

## Optional services (Neo4j, Redis)

### Neo4j (knowledge graph)

```bash
docker run -d --name memhub-neo4j -p 7687:7687 -p 7474:7474 -e NEO4J_AUTH=neo4j/<your-password> neo4j:5
```

Then set `NEO4J_*` and `NLP_SERVICE_*` in `server/.env`, restart the API, and process existing documents:

```bash
cd server
npm run graph:setup        # optional - constraints/indexes are also created automatically at server start
npm run graph:reprocess    # build the graph for already-uploaded documents (safe to repeat)
```

Neo4j browser: http://localhost:7474

### Redis (cache + shared rate limits)

```bash
docker run -d --name memhub-redis -p 6379:6379 redis:7
```

Linux alternative: `sudo apt install redis-server`

Then add `REDIS_URL=redis://localhost:6379` to `server/.env` and restart the API.

Redis caches full `/api/ask` answers and the knowledge-graph reads. Cache keys include a per-company knowledge-base version, so uploads, deletes, reindexing and graph reprocessing invalidate the cache automatically. If Redis goes down, the app keeps working (cache misses only).

---

## Useful scripts

### Frontend (project root)

```bash
npm run dev        # dev server at http://localhost:5173
npm run build      # production build -> dist/
npm run preview    # preview the production build
npm run lint       # oxlint
npm test           # vitest
```

### Backend (`cd server`)

```bash
npm run dev               # API with auto-reload
npm start                 # API without auto-reload
npm run prisma:generate   # prisma generate
npm run prisma:migrate    # prisma migrate dev
npm run prisma:studio     # open Prisma Studio (DB viewer)
npm run reindex           # rebuild ALL vectors from text stored in PostgreSQL (embedding service must be running)
npm run graph:setup       # create Neo4j constraints/indexes
npm run graph:reprocess   # rebuild the knowledge graph for all documents
```

---

## Tests

```bash
# Frontend
npm test

# Backend (Redis is faked, no database needed)
cd server && npm test

# Backend against a REAL Redis (needs the redis-server binary)
cd server && npm run test:redis

# Backend against a REAL Neo4j (set NEO4J_* first, use a throw-away database)
cd server && npm run test:neo4j

# Python - NLP service
cd server/nlp-service
pip install pytest httpx
python -m pytest -q

# Python - embedding service
cd server/embedding-service
pip install pytest httpx
python -m pytest -q

# Frontend production build check
npm run build
```

End-to-end RAG test (needs PostgreSQL + the running embedding service; use a throw-away vector store):

```bash
# Terminal A
cd server/embedding-service
CHROMA_PATH=./chroma_test_data uvicorn app:app --port 8001

# Terminal B
cd server
RAG_INTEGRATION=1 npm test
```

---

## API reference

All routes except `/api/health` and the auth routes need `Authorization: Bearer <access-token>`. The company is **always** taken from the JWT, never from the request body.

### Auth

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create account (new company, or join an existing one) |
| `POST` | `/api/auth/login` | Login, returns access + refresh token |
| `POST` | `/api/auth/refresh` | Single-use refresh token rotation |
| `POST` | `/api/auth/logout` | Revoke one session |
| `POST` | `/api/auth/logout-all` | Revoke all sessions of the user |
| `GET` | `/api/auth/me` | Current user |

### Documents, search, ask

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/documents` | Upload PDF/DOCX/TXT (max 10 MB, field name `file`) |
| `GET` | `/api/documents` | List company documents |
| `GET` | `/api/documents/:id` | Document info + text preview |
| `POST` | `/api/documents/:id/reindex` | Rebuild a document's vectors (**ADMIN**) |
| `DELETE` | `/api/documents/:id` | Delete document + vectors (**ADMIN**) |
| `POST` | `/api/search` | Semantic search `{ "query": "...", "limit": 5 }` |
| `POST` | `/api/ask` | RAG answer with citations `{ "question": "..." }` (max 1000 chars) |

### Knowledge graph

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/graph?limit=80` | Most connected entities + relationships |
| `GET` | `/api/graph/status` | Graph enabled/connected + per-status document counts |
| `GET` | `/api/graph/nodes/:id` | One entity with evidence + documents |
| `POST` | `/api/graph/documents/:id/reprocess` | Re-run NLP + graph for one document (**ADMIN**) |

### Users

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/users` | List teammates |
| `PATCH` | `/api/users/:id/role` | Change role (**ADMIN**) |
| `DELETE` | `/api/users/:id` | Remove user (**ADMIN**) |

### Health

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Backend health check |

---

## Roles and permissions

| Action | MEMBER | ADMIN |
| --- | --- | --- |
| Upload / list / read documents, search, ask, read graph, list teammates | Yes | Yes |
| Delete document, reindex, graph reprocess | No (403) | Yes |
| Change user role, remove user | No (403) | Yes |

- Role is never read from a request body; it is set at registration and via `PATCH /api/users/:id/role`.
- Privileged routes re-check the role in PostgreSQL, so a demoted user loses powers immediately.
- A company always keeps at least one ADMIN.
- Another company's resources always return `404`.

---

## Security notes

- Refresh tokens are single-use and stored only as keyed hashes; reuse after the grace window revokes the whole session.
- Rate limits on register, login (failed attempts), refresh/logout and `/api/ask` (answer `429` + `Retry-After`). Set `REDIS_URL` when running several backend instances.
- Behind a reverse proxy, set `TRUST_PROXY=<number of proxy hops>` (for example `1`). `TRUST_PROXY=true` is refused on purpose.
- With `NODE_ENV=production`, HSTS is enabled and secrets must be at least 32 characters.
- Helmet is enabled with a JSON-only CSP; `Cache-Control: no-store` on `/api/auth/*`.
- Internal Python services must stay bound to `127.0.0.1`.
- Never commit `.env` files or real keys.

---

## Project structure

```
.
├── src/                          # React frontend
│   ├── components/               # Sidebar, TopBar, KnowledgeGraph, ui/ (button, input, dropdown)
│   ├── pages/                    # Landing, Login, Register, Dashboard, AIAssistant,
│   │                             # Documents, Search, KnowledgeBase, KnowledgeGraphPage,
│   │                             # Analytics, Settings
│   ├── contexts/                 # AuthContext, ThemeContext
│   ├── utils/                    # graphLayout, companyOverview
│   ├── api.js                    # API client
│   └── App.jsx / main.jsx
├── server/
│   ├── src/
│   │   ├── routes/               # auth, documents, search, ask, graph, users, health
│   │   ├── middleware/           # auth, permissions (RBAC), rateLimit, security, errorHandler
│   │   ├── utils/                # chunker, embeddings, vectorStore, llm, graph*, redisCache, askCache
│   │   ├── cloudinary.js / prisma.js / index.js
│   ├── prisma/                   # schema.prisma + migrations
│   ├── scripts/                  # reindex-all, graph-setup, reprocess-graph
│   ├── embedding-service/        # Python: MiniLM + ChromaDB (port 8001)
│   ├── nlp-service/              # Python: spaCy + rule-based relations (port 8002)
│   └── .env.example
├── INTEGRATION.md                # deep dive: NLP + knowledge graph + hybrid GraphRAG
├── vite.config.js
└── package.json
```

Database migrations (in `server/prisma/migrations`):

1. `20261008000000_init`
2. `20261014000000_graph_ingestion`
3. `20261025000000_refresh_tokens`
4. `20261031000000_knowledge_versioning`

---

## Troubleshooting

**Backend exits with "Missing JWT_ACCESS_SECRET or JWT_REFRESH_SECRET"**
Fill both in `server/.env`, and make sure they are different.

**Embedding service refuses to start (token)**
`EMBEDDING_SERVICE_TOKEN` is missing. Set it in `server/.env` (no spaces or quotes around the value).

**Embedding service says "uses distance 'l2', not 'cosine'"**
An old ChromaDB folder is being reused. Stop the service, rename `server/embedding-service/chroma_data`, start the service again, then:

```bash
cd server
npm run reindex
```

**Graph shows nothing / `nerMode` is `heuristic-fallback`**
Check `NEO4J_*` and `NLP_SERVICE_*` are all set, the NLP service is running, and the spaCy model is installed:

```bash
python -m spacy download en_core_web_sm
```

Then rebuild the graph for old documents:

```bash
cd server
npm run graph:reprocess
```

**Caches stay off even with `REDIS_URL` set**
Apply the latest migration:

```bash
cd server
npx prisma migrate deploy
```

**Everyone is logged out after an update**
Expected after the refresh-token migration: refresh tokens issued earlier are not tracked, so every user logs in once again.

**PowerShell blocks `Activate.ps1`**
Run once in PowerShell, then activate again:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**`pdf-parse` errors on install/upload**
Use Node 20.16+ or 22.3+.

**Port already in use**
Change `PORT` in `server/.env` (and the proxy target in `vite.config.js`), or use another `--port` for uvicorn (and update `EMBEDDING_SERVICE_URL` / `NLP_SERVICE_URL`).

---

## More documentation

- [INTEGRATION.md](INTEGRATION.md) — NLP service, Neo4j graph model, hybrid GraphRAG, RBAC details
- [server/embedding-service/README.md](server/embedding-service/README.md) — embedding + ChromaDB service
- [server/nlp-service/README.md](server/nlp-service/README.md) — entity/relationship extraction service
