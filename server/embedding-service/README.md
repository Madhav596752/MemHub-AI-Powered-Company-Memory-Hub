# MemHub embedding + vector service

Runs `sentence-transformers/all-MiniLM-L6-v2` (384 dimensions) and stores document chunks in a
persistent **ChromaDB** collection (embedded mode: no separate Chroma server to start).
The model is loaded once at start-up. Needs Python 3.9+ (3.10+ recommended) and internet the first
time (~90 MB model download, cached afterwards).

```bash
cd server/embedding-service
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# The shared secret is REQUIRED: use the same value as EMBEDDING_SERVICE_TOKEN in server/.env
export EMBEDDING_SERVICE_TOKEN="<same long random value as in server/.env>"   # PowerShell: $env:EMBEDDING_SERVICE_TOKEN="..."
uvicorn app:app --host 127.0.0.1 --port 8001
```

Environment variables (set in the terminal that runs uvicorn):

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMBEDDING_SERVICE_TOKEN` | (required) | Shared secret. Every endpoint except `/health` needs it in the `X-Internal-Token` header; Node sends it automatically |
| `CHROMA_PATH` | `<this folder>/chroma_data` | Folder where ChromaDB persists its data (always resolved to an absolute path) |
| `EMBEDDING_MAX_BATCH` | `64` | Max texts per `/embed` request / per internal batch |

Endpoints (called only by the Express server; keep the service on 127.0.0.1):
`GET /health`, `POST /embed`, `POST /index`, `POST /search`, `DELETE /documents/{id}?companyId=...`.
The default storage folder no longer depends on where uvicorn is started. On start-up the service logs the
collection, distance metric, absolute path and number of stored chunks.

**If it refuses to start with "uses distance 'l2', not 'cosine'"**: an older ChromaDB folder holds a collection
that was created without cosine distance (Chroma cannot change that afterwards), which makes every similarity
score wrong. The vectors are only a cache of text stored in PostgreSQL, so: stop the service, *rename* the
`chroma_data` folder, start the service again, then run `npm run reindex` in `server/` to rebuild all vectors.

Tests (offline, stub embedder, real ChromaDB): `pip install pytest httpx && python -m pytest -q`
