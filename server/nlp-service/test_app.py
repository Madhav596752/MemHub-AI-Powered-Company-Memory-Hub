"""Tests for the NLP service contract and HTTP layer.  Run:  python -m pytest -q   (in server/nlp-service)"""
import os

os.environ["NLP_SERVICE_TOKEN"] = "test-token"

from fastapi.testclient import TestClient  # noqa: E402

import app as service  # noqa: E402
from ai.nlp.schemas import Entity, GraphReadyOutput, Relation  # noqa: E402
from contract import build_chunk_result  # noqa: E402

client = TestClient(service.app)
AUTH = {"X-Internal-Token": "test-token"}
TEXT = "Priya resolved the authentication issue in Project Phoenix."


def body(text=TEXT, chunk_id="doc-1:0", index=0, start=0):
    return {"documentId": "doc-1", "chunks": [{"chunkId": chunk_id, "chunkIndex": index, "text": text, "startChar": start, "endChar": start + len(text)}]}


def test_health_is_public_and_reports_ner_mode():
    r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "ok" and data["nerMode"] in ("spacy-ner", "heuristic-fallback")
    assert "RESOLVED" in data["relationTypes"]


def test_extract_requires_the_shared_secret():
    assert client.post("/extract", json=body()).status_code == 401
    assert client.post("/extract", json=body(), headers={"X-Internal-Token": "wrong"}).status_code == 401


def test_entity_and_relation_extraction_contract():
    r = client.post("/extract", json=body(start=500), headers=AUTH)
    assert r.status_code == 200
    res = r.json()["results"][0]
    assert res["documentId"] == "doc-1" and res["chunkId"] == "doc-1:0" and res["chunkIndex"] == 0
    types = {e["text"]: e["type"] for e in res["entities"]}
    assert types["Priya"] == "PERSON" and types["Project Phoenix"] == "PROJECT"
    ents = {e["id"]: e for e in res["entities"]}
    rel = next(x for x in res["relationships"] if x["type"] == "RESOLVED")
    assert ents[rel["source"]]["text"] == "Priya" and ents[rel["target"]]["text"] == "authentication issue"
    assert rel["evidence"] in TEXT and 0 < rel["confidence"] <= 1
    # offsets: chunk-relative AND document-relative (chunk starts at 500)
    priya = ents[rel["source"]]
    assert TEXT[priya["startChar"]:priya["endChar"]] == "Priya"
    assert priya["documentStartChar"] == 500 + priya["startChar"]


def test_empty_and_whitespace_text():
    for text in ("", "   \n "):
        r = client.post("/extract", json=body(text=text), headers=AUTH)
        assert r.status_code == 200
        res = r.json()["results"][0]
        assert res["entities"] == [] and res["relationships"] == []


def test_payload_validation():
    assert client.post("/extract", json={"documentId": "d", "chunks": []}, headers=AUTH).status_code == 422
    assert client.post("/extract", json={"chunks": [{"chunkId": "c", "chunkIndex": 0, "text": "x"}]}, headers=AUTH).status_code == 422
    assert client.post("/extract", json=body(text="x" * (service.MAX_CHUNK_CHARS + 1)), headers=AUTH).status_code == 422
    bad = body(); bad["chunks"][0]["chunkIndex"] = -1
    assert client.post("/extract", json=bad, headers=AUTH).status_code == 422
    too_many = {"documentId": "d", "chunks": [{"chunkId": f"c{i}", "chunkIndex": i, "text": "x"} for i in range(service.MAX_CHUNKS + 1)]}
    assert client.post("/extract", json=too_many, headers=AUTH).status_code == 422


def test_repeated_processing_is_deterministic():
    a = client.post("/extract", json=body(), headers=AUTH).json()["results"][0]
    b = client.post("/extract", json=body(), headers=AUTH).json()["results"][0]
    assert a == b


def test_one_failing_chunk_does_not_fail_the_document(monkeypatch):
    real = service.pipeline.process_chunk

    def flaky(text, document_id="d", chunk_id="c", metadata=None):
        if chunk_id.endswith(":1"):
            raise RuntimeError("secret document text must not be logged")
        return real(text, document_id=document_id, chunk_id=chunk_id, metadata=metadata)

    monkeypatch.setattr(service.pipeline, "process_chunk", flaky)
    two = {"documentId": "doc-1", "chunks": [
        {"chunkId": "doc-1:0", "chunkIndex": 0, "text": TEXT},
        {"chunkId": "doc-1:1", "chunkIndex": 1, "text": TEXT}]}
    data = client.post("/extract", json=two, headers=AUTH).json()
    assert [r["chunkId"] for r in data["results"]] == ["doc-1:0"]
    assert data["failed"] == [{"chunkId": "doc-1:1", "code": "nlp_failed"}]


def test_malformed_pipeline_output_is_dropped_not_trusted():
    chunk = {"chunkId": "c:0", "chunkIndex": 0, "text": "Priya fixed the login issue.", "startChar": 0}
    out = GraphReadyOutput(
        document_id="d", chunk_id="c:0",
        entities=[
            Entity(id="entity_1", text="Priya", type="PERSON", start_char=0, end_char=5, confidence=0.9),
            Entity(id="entity_2", text="login issue", type="ISSUE", start_char=16, end_char=27, confidence=0.9),
            Entity(id="entity_3", text="Mystery", type="NOT_A_TYPE"),            # unknown entity type
            Entity(id="entity_4", text="", type="PERSON"),                       # empty text
            Entity(id="entity_5", text="Bad", type="PERSON", start_char=900, end_char=950),  # offsets outside chunk
        ],
        relationships=[
            Relation(source="entity_1", relation="RESOLVED", target="entity_2", confidence=0.9, evidence="Priya fixed the login issue"),
            Relation(source="entity_1", relation="INVENTED", target="entity_2", confidence=0.9, evidence="Priya fixed"),   # unknown type
            Relation(source="entity_1", relation="RESOLVED", target="entity_99", confidence=0.9, evidence="Priya fixed"),  # missing endpoint
            Relation(source="entity_1", relation="RESOLVED", target="entity_1", confidence=0.9, evidence="Priya"),         # self loop
            Relation(source="entity_1", relation="CREATED", target="entity_2", confidence=0.9, evidence="never in the text"),  # evidence not in chunk
            Relation(source="entity_1", relation="WORKED_ON", target="entity_2", confidence=7, evidence="Priya fixed"),    # bad confidence
        ],
    )
    res = build_chunk_result(out, chunk, "d")
    assert [e["id"] for e in res["entities"]] == ["entity_1", "entity_2", "entity_5"]
    assert "startChar" not in next(e for e in res["entities"] if e["id"] == "entity_5")
    assert [r["type"] for r in res["relationships"]] == ["RESOLVED"]
    assert res["metadata"]["droppedEntities"] == 2 and res["metadata"]["droppedRelationships"] == 5
