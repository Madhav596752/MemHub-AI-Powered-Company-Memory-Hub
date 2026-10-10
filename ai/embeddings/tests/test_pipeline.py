"""Tests for the MemHub embedding pipeline, top-K semantic search, and Module 1 chunk compatibility."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict

import numpy as np
import pytest

from ai.embeddings.config import EMBEDDING_DIMENSION
from ai.embeddings.exceptions import (
    EmptyTextError,
    InvalidInputError,
    InvalidTopKError,
)
from ai.embeddings.pipeline import (
    embed_chunks,
    embed_text,
    semantic_search,
    semantic_similarity,
)
from ai.embeddings.schemas import (
    BatchEmbeddingResult,
    EmbeddingResult,
    SemanticSearchResult,
)


@dataclass
class MockModule1DocumentChunk:
    """Simulated structured chunk output from Module 1 (ai/document_processor/)."""

    document_id: str
    chunk_id: str
    text: str
    chunk_index: int = 0
    start_char: int = 0
    end_char: int = 50
    token_count: int = 12
    metadata: Dict[str, Any] = field(default_factory=dict)


def test_pipeline_embed_text_and_embed_chunks() -> None:
    """embed_text and embed_chunks should return normalized 384-D vectors and preserve metadata."""
    single = embed_text(
        "Onboarding guide for new backend engineers.",
        document_id="doc_onboard",
        chunk_id="chk_01",
        metadata={"section": "engineering"},
    )
    assert isinstance(single, EmbeddingResult)
    assert single.dimension == EMBEDDING_DIMENSION
    assert single.shape == (EMBEDDING_DIMENSION,)
    assert len(single) == EMBEDDING_DIMENSION
    assert single.document_id == "doc_onboard"
    assert single.chunk_id == "chk_01"
    assert single.metadata["section"] == "engineering"
    assert np.isclose(np.linalg.norm(single), 1.0, atol=1e-5)

    batch = embed_chunks(
        [
            {"document_id": "d1", "chunk_id": "c1", "text": "First chunk about API authentication."},
            {"document_id": "d1", "chunk_id": "c2", "text": "Second chunk about database backups."},
        ]
    )
    assert isinstance(batch, BatchEmbeddingResult)
    assert len(batch) == 2
    assert batch.embeddings.shape == (2, EMBEDDING_DIMENSION)


def test_semantic_search_password_reset_ranking() -> None:
    """Query 'How do I reset my password?' must rank the password reset chunk above office meeting schedule."""
    query = "How do I reset my password?"
    chunks = [
        {
            "document_id": "doc_meetings",
            "chunk_id": "chunk_1",
            "text": "The team discussed the office meeting schedule.",
            "metadata": {"category": "operations"},
        },
        {
            "document_id": "doc_security",
            "chunk_id": "chunk_2",
            "text": "The user can reset their password from the account settings.",
            "metadata": {"category": "account_security"},
        },
        {
            "document_id": "doc_cafeteria",
            "chunk_id": "chunk_3",
            "text": "Lunch menu options for Friday include vegetarian pasta and salad.",
            "metadata": {"category": "facilities"},
        },
    ]

    results = semantic_search(query, chunks, top_k=3)

    assert len(results) == 3
    assert all(isinstance(r, SemanticSearchResult) for r in results)

    # Verify descending order of scores
    scores = [r.score for r in results]
    assert scores == sorted(scores, reverse=True)

    # Top result must be the password reset chunk
    top = results[0]
    assert top.document_id == "doc_security"
    assert top.chunk_id == "chunk_2"
    assert top.text == "The user can reset their password from the account settings."
    assert top.metadata == {"category": "account_security"}
    assert top.rank == 1

    # Password chunk must score strictly higher than meeting schedule chunk
    score_by_doc = {r.document_id: r.score for r in results}
    assert score_by_doc["doc_security"] > score_by_doc["doc_meetings"]


def test_semantic_search_top_k_behavior() -> None:
    """semantic_search should respect top_k when smaller or larger than chunk count."""
    chunks = [
        f"Knowledge base article number {i} covering engineering practices."
        for i in range(6)
    ]

    top_2 = semantic_search("engineering practices", chunks, top_k=2)
    assert len(top_2) == 2
    assert [r.rank for r in top_2] == [1, 2]

    # When top_k exceeds available chunks, return all available chunks ranked
    top_10 = semantic_search("engineering practices", chunks, top_k=10)
    assert len(top_10) == 6
    assert [r.rank for r in top_10] == [1, 2, 3, 4, 5, 6]

    # Empty chunk list returns empty list
    assert semantic_search("engineering practices", [], top_k=3) == []


def test_module_1_chunk_structure_compatibility() -> None:
    """Module 2 must seamlessly accept Module 1 chunk objects and dicts without modifying Module 1."""
    module1_chunks = [
        MockModule1DocumentChunk(
            document_id="doc_arch_01",
            chunk_id="doc_arch_01_chunk_0",
            text="Microservices communicate asynchronously over an event bus.",
            chunk_index=0,
            start_char=0,
            end_char=59,
            token_count=9,
            metadata={"source": "architecture.pdf", "page": 1},
        ),
        MockModule1DocumentChunk(
            document_id="doc_sec_02",
            chunk_id="doc_sec_02_chunk_1",
            text="Users can reset their password from the account settings page.",
            chunk_index=1,
            start_char=60,
            end_char=122,
            token_count=11,
            metadata={"source": "security.pdf", "page": 3},
        ),
    ]

    batch = embed_chunks(module1_chunks)
    assert batch.count == 2
    assert batch[0].document_id == "doc_arch_01"
    assert batch[0].chunk_id == "doc_arch_01_chunk_0"
    assert batch[0].metadata["source"] == "architecture.pdf"
    assert batch[0].metadata["chunk_index"] == 0
    assert batch[0].metadata["token_count"] == 12 or batch[0].metadata["token_count"] == 9

    search_hits = semantic_search("How do I reset my password?", module1_chunks, top_k=1)
    assert len(search_hits) == 1
    assert search_hits[0].document_id == "doc_sec_02"
    assert search_hits[0].chunk_id == "doc_sec_02_chunk_1"
    assert search_hits[0].metadata["source"] == "security.pdf"


def test_error_handling_for_empty_and_invalid_inputs() -> None:
    """Pipeline functions should raise appropriate exceptions for empty text, invalid inputs, and invalid top_k."""
    with pytest.raises(EmptyTextError):
        embed_text("   ")

    with pytest.raises(InvalidInputError):
        embed_text(None)  # type: ignore[arg-type]

    with pytest.raises(EmptyTextError):
        embed_chunks([])

    with pytest.raises(InvalidInputError):
        embed_chunks("not-a-chunk-list")  # type: ignore[arg-type]

    with pytest.raises(EmptyTextError):
        semantic_similarity("", "Valid second text")

    with pytest.raises(InvalidInputError):
        semantic_similarity("Valid text", None)  # type: ignore[arg-type]

    with pytest.raises(EmptyTextError):
        semantic_search("   ", ["Valid chunk"], top_k=1)

    with pytest.raises(InvalidTopKError):
        semantic_search("Valid query", ["Valid chunk"], top_k=0)

    with pytest.raises(InvalidTopKError):
        semantic_search("Valid query", ["Valid chunk"], top_k=-3)

    with pytest.raises(InvalidTopKError):
        semantic_search("Valid query", ["Valid chunk"], top_k=True)  # type: ignore[arg-type]

    with pytest.raises(InvalidInputError):
        semantic_search("Valid query", "not-a-sequence", top_k=2)  # type: ignore[arg-type]
