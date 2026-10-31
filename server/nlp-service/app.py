"""Internal NLP service for MemHub (entity + relationship extraction).

Wraps the teammate's rule-based/spaCy pipeline (ai/nlp) behind a small HTTP API. It does NOT
train or run any neural model of its own: entities come from spaCy NER (if en_core_web_sm is
installed) plus rule/gazetteer patterns; relationships come from linguistic trigger patterns.

Endpoints:
  GET  /health     status + which NER mode is active (the only unauthenticated endpoint)
  POST /extract    {documentId, chunks:[{chunkId, chunkIndex, text, startChar?, endChar?}]}
                   -> per-chunk entities/relationships (see contract.py)

Security: bind to 127.0.0.1 and send the shared secret in X-Internal-Token. Without
NLP_SERVICE_TOKEN the service refuses to start. Chunk text is never written to the logs.
"""
import hmac
import logging
import os
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from ai.nlp.pipeline import create_pipeline
from contract import PIPELINE_NAME, RELATION_TYPES, build_chunk_result

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("memhub.nlp")

def _load_env_file(allowed: set) -> None:
    """Reads ONLY the listed keys from server/.env when they are not already in the environment.

    Node loads server/.env through dotenv, but a Python process never does, so a token that sits
    in .env was invisible here and the two sides disagreed (401). A value exported in the terminal
    always wins. Nothing is logged except WHICH keys were taken from the file, never their values.
    """
    path = Path(__file__).resolve().parent.parent / ".env"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    taken = []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[7:].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].strip()
        if key in allowed and value and not os.environ.get(key, "").strip():
            os.environ[key] = value
            taken.append(key)
    if taken:
        logging.getLogger("memhub.env").info("Loaded %s from %s", ", ".join(taken), path.name)


_load_env_file({"NLP_SERVICE_TOKEN", "NLP_MAX_CHUNKS", "NLP_MAX_CHUNK_CHARS"})
SERVICE_TOKEN = os.getenv("NLP_SERVICE_TOKEN", "").strip()
if not SERVICE_TOKEN:
    raise RuntimeError(
        "NLP_SERVICE_TOKEN is not set (neither in this terminal nor in server/.env). Set the same long "
        "random value for this service and for the Node server so only the Express backend can call it."
    )

MAX_CHUNKS = int(os.getenv("NLP_MAX_CHUNKS", "100"))
MAX_CHUNK_CHARS = int(os.getenv("NLP_MAX_CHUNK_CHARS", "5000"))

pipeline = create_pipeline()


def ner_mode() -> dict:
    nlp = getattr(pipeline.entity_extractor.base_extractor, "nlp", None)
    if nlp is not None and "ner" in getattr(nlp, "pipe_names", []):
        meta = getattr(nlp, "meta", {}) or {}
        return {"nerMode": "spacy-ner", "spacyModel": f"{meta.get('lang', '')}_{meta.get('name', '')}".strip("_")}
    return {"nerMode": "heuristic-fallback", "spacyModel": None}


logger.info("NLP pipeline ready: %s", ner_mode())

app = FastAPI(title="MemHub NLP service")


def require_token(x_internal_token: str | None = Header(default=None)) -> None:
    sent = (x_internal_token or "").strip()
    if not sent:
        # The caller sent no token at all: NLP_SERVICE_TOKEN is empty on the Node side.
        logger.warning("Rejected request: X-Internal-Token header missing or empty (is NLP_SERVICE_TOKEN set in server/.env?)")
        raise HTTPException(status_code=401, detail="missing internal token")
    if not hmac.compare_digest(sent.encode(), SERVICE_TOKEN.encode()):
        # Never log either value. Different values on the two sides is the usual cause.
        logger.warning("Rejected request: X-Internal-Token does not match this service's NLP_SERVICE_TOKEN")
        raise HTTPException(status_code=401, detail="invalid internal token")


class ChunkIn(BaseModel):
    chunkId: str = Field(min_length=1, max_length=200)
    chunkIndex: int = Field(ge=0)
    text: str = Field(max_length=MAX_CHUNK_CHARS)
    startChar: int | None = Field(default=None, ge=0)
    endChar: int | None = Field(default=None, ge=0)


class ExtractRequest(BaseModel):
    documentId: str = Field(min_length=1, max_length=200)
    chunks: list[ChunkIn] = Field(min_length=1, max_length=MAX_CHUNKS)


@app.get("/health")
def health():
    return {"status": "ok", "pipeline": PIPELINE_NAME, "relationTypes": sorted(RELATION_TYPES), **ner_mode()}


@app.post("/extract", dependencies=[Depends(require_token)])
def extract(req: ExtractRequest):
    results, failed = [], []
    for chunk in req.chunks:
        if not chunk.text.strip():
            # Nothing to extract; still reported so Node can see every chunk was handled.
            results.append(
                {
                    "documentId": req.documentId, "chunkId": chunk.chunkId, "chunkIndex": chunk.chunkIndex,
                    "entities": [], "relationships": [],
                    "metadata": {"pipeline": PIPELINE_NAME, "entityCount": 0, "relationshipCount": 0,
                                 "droppedEntities": 0, "droppedRelationships": 0},
                }
            )
            continue
        try:
            output = pipeline.process_chunk(chunk.text, document_id=req.documentId, chunk_id=chunk.chunkId)
            results.append(build_chunk_result(output, chunk.model_dump(), req.documentId))
        except Exception as exc:  # one bad chunk must not fail the whole document
            # Only ids and the exception class are logged, never document text.
            logger.error("NLP failed for document=%s chunk=%s (%s)", req.documentId, chunk.chunkId, type(exc).__name__)
            failed.append({"chunkId": chunk.chunkId, "code": "nlp_failed"})
    logger.info("Extracted document=%s chunks=%d failed=%d", req.documentId, len(results), len(failed))
    return {"pipeline": PIPELINE_NAME, "results": results, "failed": failed}
