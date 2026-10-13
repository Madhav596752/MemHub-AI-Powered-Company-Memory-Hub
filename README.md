MemHub — AI-Powered Company Memory Hub
MemHub is a multi-tenant web app that lets a company upload its PDFs/documents and then ask questions in plain English. Answers come only from the company's own documents and always include citations to the source document and passage. If the documents don't contain the answer, MemHub says so instead of making something up.
Features
Company workspaces with users (register, login, JWT access + refresh tokens, roles)
Strict multi-tenancy: every request is scoped to the company in the signed JWT
PDF/document upload (stored in Cloudinary) with text extraction
Text chunking, embeddings (Sentence Transformers `all-MiniLM-L6-v2`) and vector storage (ChromaDB)
Semantic search across the company's documents
RAG AI assistant (Groq LLM) with cited sources and honest "not found" answers
Clear error reporting (embedding service down, indexing failed, LLM failure, expired login, …)
Re-index button for documents whose indexing failed
Architecture
```
React (Vite)  ──►  Node.js / Express API  ──►  PostgreSQL (Neon) via Prisma   users, companies, documents, extracted text
 :5173               :5000                 ──►  Cloudinary                      original files
                                           ──►  Python FastAPI service :8001    embeddings + ChromaDB (vectors)
                                           ──►  Groq API                        answer generation
```
Question flow: upload PDF → extract text → split into chunks → embed → store in ChromaDB (tagged with `companyId`) → on a question, embed it, search only that company's vectors, keep chunks above the relevance threshold, send them to the LLM, return the answer with sources.
Tenant isolation: the company always comes from `req.user.companyId` (the verified JWT), never from the request body, query string or frontend. The Python service is internal-only and requires a shared secret (`EMBEDDING_SERVICE_TOKEN`) on every call.
Tech stack
React 19, Vite, Tailwind CSS, React Router · Node.js, Express, Prisma · PostgreSQL (Neon) · Python, FastAPI, Sentence Transformers, ChromaDB · Cloudinary · Groq
Project structure
```
src/                          React frontend (pages, components, contexts, api.js)
server/
  src/
    routes/                   auth, documents, search, ask, health
    utils/                    chunker, textExtractor, embeddings, vectorStore, llm
    middleware/               JWT auth
    pipeline.test.js          end-to-end PDF → answer tests
  prisma/                     schema.prisma + migrations
  scripts/reindex-all.js      rebuild all vectors from stored text
  embedding-service/          Python FastAPI service (app.py, test_app.py)
```
Prerequisites
Node.js 20+, Python 3.10+, a PostgreSQL database (e.g. Neon), a Cloudinary account, a Groq API key.
Setup
1. Backend
```bash
cd server
npm install
cp .env.example .env        # Windows: copy .env.example .env
```
Fill in `server/.env`: `DATABASE_URL`, two different `JWT_*_SECRET` values, Cloudinary keys, `GROQ_API_KEY`, and `EMBEDDING_SERVICE_TOKEN` (any long random string — generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
```bash
npx prisma generate
npm run dev                 # http://localhost:5000
```
2. Python embedding service
```bash
cd server/embedding-service
python -m venv .venv
.venv\Scripts\activate      # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```
Set the same token as in `server/.env`, then start it:
```bash
# PowerShell
$env:EMBEDDING_SERVICE_TOKEN="<same value as server/.env>"
# macOS/Linux
export EMBEDDING_SERVICE_TOKEN="<same value as server/.env>"

uvicorn app:app --host 127.0.0.1 --port 8001
```
The first start downloads the model. The log shows the ChromaDB path, distance metric (`cosine`) and chunk count. Check `http://127.0.0.1:8001/health`.
> If it refuses to start with *"uses distance 'l2', not 'cosine'"*, an old ChromaDB folder is incompatible. Rename `server/embedding-service/chroma_data`, restart the service, then run `cd server && npm run reindex` to rebuild all vectors from the text stored in PostgreSQL.
3. Frontend
```bash
npm install                 # in the repository root
npm run dev                 # http://localhost:5173
```
Using it
Register — without an invite code this creates a new company and makes you its admin. Others join with the company ID shown in Settings → Workspace.
Upload a PDF on Documents. You should see "uploaded and indexed". If indexing fails you'll see a warning with Retry (or use Re-index in the document details).
Ask questions in AI Assistant; answers show their sources.
API (all under `/api`, JWT required unless noted)
Method	Endpoint	Purpose
GET	`/health`	Server status (public)
POST	`/auth/register`, `/auth/login`, `/auth/refresh`	Auth (public)
GET	`/auth/me`	Current user
GET / POST	`/documents`	List / upload a document
GET / DELETE	`/documents/:id`	Details / delete (also removes vectors)
POST	`/documents/:id/reindex`	Rebuild a document's vectors
POST	`/search`	Semantic search
POST	`/ask`	RAG question answering with citations
Errors include a `code` (e.g. `EMBEDDING_SERVICE_UNAVAILABLE`, `VECTOR_STORE_FAILED`, `LLM_FAILED`, `NO_TEXT`). "No answer" responses carry a `reason`: `not_indexed`, `no_relevant_match` or `not_enough_info`.
Tests
```bash
cd server && npm test                                   # Node tests (some need a live DB and are skipped)
cd server/embedding-service && pip install pytest httpx && python -m pytest -q
npm test                                                # frontend (vitest), from the repo root
```
Database migrations
Use `npx prisma migrate deploy` against a shared/production database. Avoid `prisma migrate dev` on Neon if migration history is out of sync — it may propose a reset. Never run `prisma migrate reset` on data you want to keep.
Security notes
Never commit `.env` files (they are in `.gitignore`); only `.env.example` is tracked.
Keep `EMBEDDING_SERVICE_TOKEN`, `GROQ_API_KEY`, JWT secrets and Cloudinary keys private.
The embedding service must only listen on `127.0.0.1` / a private network.
Known limitations
Scanned (image-only) PDFs are rejected — no OCR yet.
Dashboard / Knowledge Base / Graph pages still show mock data.
No per-document "indexed" status column yet.
