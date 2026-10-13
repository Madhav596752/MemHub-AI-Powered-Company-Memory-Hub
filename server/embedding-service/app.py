"""Embedding + vector storage service for MemHub.

- Serves sentence-transformers/all-MiniLM-L6-v2 (384 dimensions). The model is loaded ONCE
  at start-up and reused for every request. Vectors are L2-normalised.
- Stores document chunks in a persistent ChromaDB collection (embedded mode: no separate
  Chroma server, data lives in CHROMA_PATH on disk).

Endpoints:
  GET    /health                 service + vector store status
  POST   /embed                  {texts}                       -> embeddings   (unchanged from Part 1)
  POST   /index                  {companyId, documentId, ...}  -> replaces ALL chunks of one document
  POST   /search                 {companyId, query, topK}      -> nearest chunks of that company only
  DELETE /documents/{id}?companyId=...                         -> removes one document's chunks

Only the Express backend should call this service (bind it to 127.0.0.1). Express takes the
company ID from the verified JWT and passes it here; this service never talks to browsers.

Being on localhost is not a security boundary (any local process, or anything that can reach the
port, could pass any companyId), so every endpoint except /health requires the shared secret in
the X-Internal-Token header. Set the SAME EMBEDDING_SERVICE_TOKEN for this service and for Node.

Errors use a short machine-readable `detail`: "embedding_failed" (the model could not embed) or
"chroma_failed" (the vector database failed). Node turns these into different HTTP errors.
"""
import hmac
import logging
import os
from pathlib import Path

import chromadb
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"  # fixed on purpose; do not change
DIMENSIONS = 384
MAX_TEXTS = int(os.getenv("EMBEDDING_MAX_BATCH", "64"))
MAX_TOP_K = 20
COLLECTION_NAME = "memhub_chunks"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("memhub.vector")

# Always an ABSOLUTE path. The default sits next to this file, so it no longer depends on the
# folder uvicorn was started from (a relative path used to create a second, empty database).
CHROMA_PATH = os.path.abspath(os.getenv("CHROMA_PATH") or str(Path(__file__).resolve().parent / "chroma_data"))

SERVICE_TOKEN = os.getenv("EMBEDDING_SERVICE_TOKEN", "").strip()
if not SERVICE_TOKEN:
    raise RuntimeError(
        "EMBEDDING_SERVICE_TOKEN is not set. Set the same long random value for this service "
        "and for the Node server (server/.env) so only the Express backend can call it."
    )

model = SentenceTransformer(MODEL_NAME)  # downloads once, then cached
if model.get_sentence_embedding_dimension() != DIMENSIONS:
    raise RuntimeError("Unexpected embedding dimension for " + MODEL_NAME)

chroma = chromadb.PersistentClient(path=CHROMA_PATH)
# cosine distance: 0 = identical, larger = less similar. We always supply our own embeddings,
# so Chroma never loads a second embedding model.
collection = chroma.get_or_create_collection(name=COLLECTION_NAME, metadata={"hnsw:space": "cosine"})


def collection_space(col) -> str | None:
    """The distance metric the collection REALLY uses (Chroma 1.x: configuration, older: metadata)."""
    try:
        return col.configuration["hnsw"]["space"]
    except Exception:
        return (col.metadata or {}).get("hnsw:space")


# get_or_create_collection(metadata=...) does NOT change an EXISTING collection. A collection that
# was first created without cosine keeps squared-L2, and Node's score = 1 - distance would then be
# wrong for every chunk (relevant chunks fall under RAG_MIN_SCORE). Refuse to run on it.
_space = collection_space(collection)
if _space != "cosine":
    raise RuntimeError(
        f"ChromaDB collection '{COLLECTION_NAME}' at {CHROMA_PATH} uses distance '{_space}', not 'cosine'. "
        "Scores would be wrong. The vectors are only a cache of text stored in PostgreSQL: stop this "
        "service, move that folder away (rename it, do not delete it until you have checked), start the "
        "service again and run `npm run reindex` in server/ to rebuild every document's vectors."
    )

logger.info(
    "Vector store ready: collection=%s space=%s path=%s chunks=%d model=%s",
    COLLECTION_NAME, _space, CHROMA_PATH, collection.count(), MODEL_NAME,
)

app = FastAPI(title="MemHub embedding service")


def require_token(x_internal_token: str | None = Header(default=None)) -> None:
    """Only the Express backend knows the shared secret (constant-time comparison)."""
    if not x_internal_token or not hmac.compare_digest(x_internal_token, SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="invalid internal token")


def embed_texts(texts: list[str]) -> list[list[float]]:
    try:
        return model.encode(texts, normalize_embeddings=True).tolist()
    except Exception:
        logger.exception("Embedding failed for %d text(s)", len(texts))
        raise HTTPException(status_code=503, detail="embedding_failed")


def chroma_call(label: str, fn):
    """Run one ChromaDB operation; any failure becomes a clear 500 'chroma_failed' (full error is logged)."""
    try:
        return fn()
    except HTTPException:
        raise
    except Exception:
        logger.exception("ChromaDB %s failed (collection=%s path=%s)", label, COLLECTION_NAME, CHROMA_PATH)
        raise HTTPException(status_code=500, detail="chroma_failed")


def require_id(value: str, name: str) -> str:
    if not value or not value.strip():
        raise HTTPException(status_code=400, detail=f"{name} is required")
    return value.strip()


class EmbedRequest(BaseModel):
    texts: list[str]


class ChunkIn(BaseModel):
    chunkIndex: int = Field(ge=0)
    text: str
    startChar: int | None = None
    endChar: int | None = None


class IndexRequest(BaseModel):
    companyId: str
    documentId: str
    documentName: str = ""
    chunks: list[ChunkIn]


class SearchRequest(BaseModel):
    companyId: str
    query: str
    topK: int = 5


@app.get("/health")
def health():
    # No secrets here: this endpoint is the only unauthenticated one.
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "dimensions": DIMENSIONS,
        "vectorStore": "chromadb",
        "distanceMetric": collection_space(collection),
        "chunksStored": chroma_call("count", collection.count),
    }


@app.post("/embed", dependencies=[Depends(require_token)])
def embed(req: EmbedRequest):
    if not req.texts:
        raise HTTPException(status_code=400, detail="texts must not be empty")
    if len(req.texts) > MAX_TEXTS:
        raise HTTPException(status_code=400, detail=f"at most {MAX_TEXTS} texts per request")
    if any(not t.strip() for t in req.texts):
        raise HTTPException(status_code=400, detail="texts must not contain empty strings")

    return {"model": MODEL_NAME, "dimensions": DIMENSIONS, "embeddings": embed_texts(req.texts)}


@app.post("/index", dependencies=[Depends(require_token)])
def index_document(req: IndexRequest):
    """Replace every stored chunk of one document with the given chunks.

    Chunk IDs are '<companyId>:<documentId>:<chunkIndex>', so re-indexing can never create
    duplicates and one company can never overwrite another company's chunk IDs.
    Old chunks are deleted first (scoped to companyId AND documentId), so a document that
    now has fewer chunks does not keep stale ones.
    """
    company_id = require_id(req.companyId, "companyId")
    document_id = require_id(req.documentId, "documentId")
    if not req.chunks:
        raise HTTPException(status_code=400, detail="chunks must not be empty")
    if any(not c.text.strip() for c in req.chunks):
        raise HTTPException(status_code=400, detail="chunks must not contain empty text")
    if len({c.chunkIndex for c in req.chunks}) != len(req.chunks):
        raise HTTPException(status_code=400, detail="chunkIndex values must be unique")

    # Embed first: if this fails, the old chunks are still in place.
    embeddings = []
    for i in range(0, len(req.chunks), MAX_TEXTS):
        embeddings.extend(embed_texts([c.text for c in req.chunks[i : i + MAX_TEXTS]]))

    metadatas = []
    for c in req.chunks:
        meta = {
            "companyId": company_id,
            "documentId": document_id,
            "documentName": req.documentName,
            "chunkIndex": c.chunkIndex,
        }
        # Chroma metadata cannot hold None, so only store offsets that exist.
        if c.startChar is not None:
            meta["startChar"] = c.startChar
        if c.endChar is not None:
            meta["endChar"] = c.endChar
        metadatas.append(meta)

    chroma_call(
        "delete-old-chunks",
        lambda: collection.delete(where={"$and": [{"companyId": company_id}, {"documentId": document_id}]}),
    )
    chroma_call(
        "add",
        lambda: collection.add(
            ids=[f"{company_id}:{document_id}:{c.chunkIndex}" for c in req.chunks],
            embeddings=embeddings,
            documents=[c.text for c in req.chunks],
            metadatas=metadatas,
        ),
    )
    total = chroma_call("count", collection.count)
    logger.info("Indexed document=%s chunks=%d (collection=%s now holds %d)", document_id, len(req.chunks), COLLECTION_NAME, total)
    return {"documentId": document_id, "chunksStored": len(req.chunks)}


@app.post("/search", dependencies=[Depends(require_token)])
def search(req: SearchRequest):
    company_id = require_id(req.companyId, "companyId")
    if not req.query.strip():
        raise HTTPException(status_code=400, detail="query must not be empty")
    top_k = max(1, min(req.topK, MAX_TOP_K))

    query_embedding = embed_texts([req.query])
    result = chroma_call(
        "query",
        lambda: collection.query(
            query_embeddings=query_embedding,
            n_results=top_k,
            where={"companyId": company_id},  # the company filter runs INSIDE the vector query
            include=["documents", "metadatas", "distances"],
        ),
    )

    hits = []
    for text, meta, distance in zip(result["documents"][0], result["metadatas"][0], result["distances"][0]):
        # Belt and braces: never return a chunk of another company, whatever Chroma returned.
        if meta.get("companyId") != company_id:
            logger.error("Chroma returned a chunk of another company for document=%s - dropped", meta.get("documentId"))
            continue
        hits.append({"text": text, "metadata": meta, "distance": distance})
    logger.info(
        "Search done: results=%d top_k=%d distances=%s",
        len(hits), top_k, [round(h["distance"], 3) for h in hits],
    )
    return {"results": hits}


@app.delete("/documents/{document_id}", dependencies=[Depends(require_token)])
def delete_document(document_id: str, companyId: str):
    company_id = require_id(companyId, "companyId")
    document_id = require_id(document_id, "documentId")
    chroma_call(
        "delete",
        lambda: collection.delete(where={"$and": [{"companyId": company_id}, {"documentId": document_id}]}),
    )
    logger.info("Deleted chunks of document=%s", document_id)
    return {"documentId": document_id, "deleted": True}
