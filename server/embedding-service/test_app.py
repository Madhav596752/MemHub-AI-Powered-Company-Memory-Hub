"""Tests for the embedding + vector service (app.py).

Real FastAPI app + real persistent ChromaDB in a temp folder. The ONLY fake is the embedding
model: sentence_transformers is replaced by a small deterministic bag-of-words hasher, so the
tests run offline and fast. They therefore prove the plumbing (persistence, cosine scoring,
company filtering, auth, error codes) - NOT the quality of all-MiniLM-L6-v2 itself.

Run:  cd server/embedding-service && pip install pytest httpx && python -m pytest -q
"""
import hashlib
import importlib
import math
import os
import re
import sys
import types

import pytest
from fastapi.testclient import TestClient

TOKEN = "test-internal-token"
HEADERS = {"X-Internal-Token": TOKEN}


class FakeModel:
    """384-d, L2-normalised bag-of-words vectors: texts sharing words have higher cosine similarity."""

    fail = False

    def __init__(self, name):
        pass

    def get_sentence_embedding_dimension(self):
        return 384

    def encode(self, texts, normalize_embeddings=True):
        if FakeModel.fail:
            raise RuntimeError("model exploded")
        out = []
        for text in texts:
            vec = [0.0] * 384
            for word in re.findall(r"[a-z0-9]+", text.lower()):
                vec[int(hashlib.md5(word.encode()).hexdigest(), 16) % 384] += 1.0
            norm = math.sqrt(sum(v * v for v in vec)) or 1.0
            out.append([v / norm for v in vec])
        return types.SimpleNamespace(tolist=lambda: out)


def load_app(chroma_path, token=TOKEN):
    """Import a fresh copy of app.py that uses the given Chroma folder."""
    fake = types.ModuleType("sentence_transformers")
    fake.SentenceTransformer = FakeModel
    sys.modules["sentence_transformers"] = fake
    os.environ["CHROMA_PATH"] = str(chroma_path)
    if token is None:
        os.environ.pop("EMBEDDING_SERVICE_TOKEN", None)
    else:
        os.environ["EMBEDDING_SERVICE_TOKEN"] = token
    sys.modules.pop("app", None)
    sys.path.insert(0, os.path.dirname(__file__))
    try:
        return importlib.import_module("app")
    finally:
        sys.path.pop(0)


@pytest.fixture
def svc(tmp_path):
    FakeModel.fail = False
    module = load_app(tmp_path / "chroma")
    return module, TestClient(module.app)


def chunks(*texts):
    return [{"chunkIndex": i, "text": t, "startChar": i * 100, "endChar": i * 100 + len(t)} for i, t in enumerate(texts)]


def index(client, company, doc, texts, name="doc.pdf"):
    return client.post("/index", headers=HEADERS, json={"companyId": company, "documentId": doc, "documentName": name, "chunks": chunks(*texts)})


def search(client, company, query, top_k=5):
    return client.post("/search", headers=HEADERS, json={"companyId": company, "query": query, "topK": top_k})


# ---------- start-up checks ----------

def test_refuses_to_start_without_token(tmp_path):
    with pytest.raises(RuntimeError, match="EMBEDDING_SERVICE_TOKEN"):
        load_app(tmp_path / "chroma", token=None)


def test_refuses_existing_non_cosine_collection(tmp_path):
    import chromadb

    path = tmp_path / "old"
    chromadb.PersistentClient(path=str(path)).get_or_create_collection(name="memhub_chunks")  # default = l2
    with pytest.raises(RuntimeError, match="not 'cosine'"):
        load_app(path)


def test_default_chroma_path_is_absolute_and_independent_of_cwd(tmp_path, monkeypatch):
    seen = {}
    import chromadb

    real = chromadb.PersistentClient
    monkeypatch.setattr(chromadb, "PersistentClient", lambda path: seen.setdefault("path", path) and real(path=str(tmp_path / "x")))
    monkeypatch.chdir(tmp_path)
    fake = types.ModuleType("sentence_transformers")
    fake.SentenceTransformer = FakeModel
    sys.modules["sentence_transformers"] = fake
    os.environ.pop("CHROMA_PATH", None)
    os.environ["EMBEDDING_SERVICE_TOKEN"] = TOKEN
    sys.modules.pop("app", None)
    sys.path.insert(0, os.path.dirname(__file__))
    try:
        importlib.import_module("app")
    finally:
        sys.path.pop(0)
    assert os.path.isabs(seen["path"])
    assert seen["path"] == os.path.join(os.path.dirname(os.path.abspath(__file__)), "chroma_data")


# ---------- authentication ----------

def test_health_is_open_but_everything_else_needs_the_token(svc):
    _, client = svc
    assert client.get("/health").status_code == 200
    body = {"companyId": "A", "query": "x", "topK": 1}
    for headers in ({}, {"X-Internal-Token": "wrong"}):
        assert client.post("/embed", headers=headers, json={"texts": ["a"]}).status_code == 401
        assert client.post("/search", headers=headers, json=body).status_code == 401
        assert client.post("/index", headers=headers, json={"companyId": "A", "documentId": "d", "chunks": chunks("a")}).status_code == 401
        assert client.delete("/documents/d?companyId=A", headers=headers).status_code == 401


# ---------- indexing + search ----------

def test_index_then_search_returns_the_relevant_chunk_with_cosine_distance(svc):
    module, client = svc
    r = index(client, "A", "doc-1", [
        "The quarterly offsite is held in Lisbon and the secret passphrase is PURPLE-OTTER-4417.",
        "Office kitchen rules: wash your own dishes and label food in the shared fridge.",
    ], name="handbook.pdf")
    assert r.status_code == 200 and r.json()["chunksStored"] == 2
    assert module.collection.count() == 2

    hits = search(client, "A", "what is the secret passphrase for the offsite").json()["results"]
    assert len(hits) == 2
    assert "PURPLE-OTTER-4417" in hits[0]["text"]
    assert hits[0]["metadata"]["documentName"] == "handbook.pdf"
    assert hits[0]["metadata"]["documentId"] == "doc-1"
    # cosine distance of unit vectors is within [0, 2]; the relevant chunk must be the closest one
    assert 0 <= hits[0]["distance"] < hits[1]["distance"] <= 2
    # identical text -> distance ~0 (proves the distance really is cosine, not squared L2 of a different scale)
    same = search(client, "A", "Office kitchen rules: wash your own dishes and label food in the shared fridge.").json()["results"][0]
    assert same["distance"] == pytest.approx(0.0, abs=1e-5)


def test_reindex_replaces_old_chunks(svc):
    module, client = svc
    index(client, "A", "doc-1", ["one one one", "two two two", "three three three"])
    assert module.collection.count() == 3
    index(client, "A", "doc-1", ["only chunk now"])
    assert module.collection.count() == 1


def test_vectors_survive_a_restart(tmp_path):
    first = load_app(tmp_path / "chroma")
    c1 = TestClient(first.app)
    index(c1, "A", "doc-1", ["persistent fact: the vault code is ZEBRA-9"])
    second = load_app(tmp_path / "chroma")  # new process, same folder
    hits = search(TestClient(second.app), "A", "vault code").json()["results"]
    assert hits and "ZEBRA-9" in hits[0]["text"]


def test_search_with_nothing_indexed_returns_an_empty_list(svc):
    _, client = svc
    r = search(client, "A", "anything at all")
    assert r.status_code == 200 and r.json() == {"results": []}


# ---------- tenant isolation ----------

def test_company_filter_isolates_vectors(svc):
    _, client = svc
    index(client, "A", "doc-a", ["Company A refund policy: refunds within 14 days."], name="a.pdf")
    index(client, "B", "doc-b", ["Company B secret salary bands: engineers earn 120 thousand."], name="b.pdf")

    a = search(client, "A", "salary bands engineers earn", top_k=20).json()["results"]
    b = search(client, "B", "refund policy refunds days", top_k=20).json()["results"]
    assert [h["metadata"]["companyId"] for h in a] == ["A"]
    assert [h["metadata"]["companyId"] for h in b] == ["B"]
    assert all("Company B" not in h["text"] for h in a)
    assert all("Company A" not in h["text"] for h in b)


def test_other_company_cannot_overwrite_or_delete_a_document_by_id(svc):
    module, client = svc
    index(client, "A", "shared-id", ["Company A original text about invoices"])
    # B reuses A's document id: must neither replace nor delete A's chunk
    index(client, "B", "shared-id", ["Company B text about holidays"])
    client.delete("/documents/shared-id?companyId=B", headers=HEADERS)
    a = search(client, "A", "invoices").json()["results"]
    assert len(a) == 1 and "Company A original" in a[0]["text"]
    assert module.collection.count() == 1


# ---------- failure reporting ----------

def test_embedding_failure_is_reported_as_embedding_failed(svc):
    _, client = svc
    FakeModel.fail = True
    r = index(client, "A", "doc-1", ["text"])
    assert r.status_code == 503 and r.json()["detail"] == "embedding_failed"
    assert search(client, "A", "text").json()["detail"] == "embedding_failed"


def test_chroma_failure_is_reported_as_chroma_failed(svc, monkeypatch):
    module, client = svc

    def boom(*a, **k):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(module.collection, "query", boom)
    r = search(client, "A", "text")
    assert r.status_code == 500 and r.json()["detail"] == "chroma_failed"
    assert "disk on fire" not in r.text  # internal details never leave the service
