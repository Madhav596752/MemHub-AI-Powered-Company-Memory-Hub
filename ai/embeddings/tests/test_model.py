"""Tests for SentenceTransformer model loading, single/batch embeddings, dimensions, and normalization."""

from __future__ import annotations

import numpy as np
import pytest

from ai.embeddings.config import (
    DEFAULT_MODEL_NAME,
    EMBEDDING_DIMENSION,
    EmbeddingConfig,
    resolve_device,
)
from ai.embeddings.exceptions import (
    EmptyTextError,
    InvalidInputError,
    ModelLoadError,
)
from ai.embeddings.model import (
    EmbeddingModel,
    get_embedding_model,
)
from ai.embeddings.schemas import BatchEmbeddingResult, EmbeddingResult


def test_model_loading_and_singleton_caching() -> None:
    """Model should load once and be reused from cache on subsequent calls."""
    model_a = get_embedding_model()
    model_b = get_embedding_model()

    assert isinstance(model_a, EmbeddingModel)
    assert model_a is model_b
    assert model_a.model_name == DEFAULT_MODEL_NAME
    assert model_a.dimension == EMBEDDING_DIMENSION
    assert model_a.device in {"cpu", "cuda"}


def test_resolve_device_and_config_validation() -> None:
    """Device resolution and EmbeddingConfig validation should handle valid and invalid inputs."""
    auto_dev = resolve_device()
    assert auto_dev in {"cpu", "cuda"}
    assert resolve_device("CPU") == "cpu"

    cfg = EmbeddingConfig(model_name=DEFAULT_MODEL_NAME, device="cpu", batch_size=16)
    assert cfg.resolved_device == "cpu"

    with pytest.raises(InvalidInputError):
        EmbeddingConfig(model_name="")

    with pytest.raises(InvalidInputError):
        EmbeddingConfig(batch_size=0)

    with pytest.raises(InvalidInputError):
        EmbeddingConfig(default_top_k=-1)

    with pytest.raises(InvalidInputError):
        resolve_device("   ")


def test_single_text_embedding_dimensions_and_normalization() -> None:
    """Single-text embedding should return a normalized 384-D float32 numpy vector."""
    model = get_embedding_model()
    vec = model.embed_text("MemHub stores organizational knowledge for teams.")

    assert isinstance(vec, np.ndarray)
    assert vec.ndim == 1
    assert vec.shape == (EMBEDDING_DIMENSION,)
    assert vec.dtype == np.float32

    l2_norm = float(np.linalg.norm(vec))
    assert np.isclose(l2_norm, 1.0, atol=1e-5)


def test_batch_embedding_dimensions_and_normalization() -> None:
    """Batch embedding should return a 2D array of normalized 384-D vectors."""
    model = get_embedding_model()
    texts = [
        "How do I reset my account password?",
        "Quarterly engineering roadmap and milestones.",
        "Company holiday calendar and PTO guidelines.",
    ]
    matrix = model.embed_texts(texts)

    assert isinstance(matrix, np.ndarray)
    assert matrix.ndim == 2
    assert matrix.shape == (3, EMBEDDING_DIMENSION)
    assert matrix.dtype == np.float32

    norms = np.linalg.norm(matrix, axis=1)
    assert np.allclose(norms, 1.0, atol=1e-5)


def test_embed_chunk_and_batch_results_preserve_metadata() -> None:
    """Structured embedding methods should preserve document_id, chunk_id, text, and metadata."""
    model = get_embedding_model()
    chunk = {
        "document_id": "doc_100",
        "chunk_id": "chunk_0",
        "text": "Deployment runbook for production services.",
        "metadata": {"author": "devops", "page": 2},
    }
    res = model.embed_chunk(chunk)

    assert isinstance(res, EmbeddingResult)
    assert res.document_id == "doc_100"
    assert res.chunk_id == "chunk_0"
    assert res.text == chunk["text"]
    assert res.metadata == {"author": "devops", "page": 2}
    assert res.dimension == EMBEDDING_DIMENSION
    assert np.isclose(np.linalg.norm(res.embedding), 1.0, atol=1e-5)

    batch = model.embed_chunks([chunk, "Second standalone chunk text"])
    assert isinstance(batch, BatchEmbeddingResult)
    assert batch.count == 2
    assert batch.embeddings.shape == (2, EMBEDDING_DIMENSION)
    assert batch[0].document_id == "doc_100"
    assert batch[1].chunk_id == "chunk_1"


def test_empty_and_invalid_inputs_in_model() -> None:
    """Model should raise clear exceptions on empty or invalid text inputs."""
    model = get_embedding_model()

    with pytest.raises(EmptyTextError):
        model.embed_text("")

    with pytest.raises(EmptyTextError):
        model.embed_text("   \n\t  ")

    with pytest.raises(InvalidInputError):
        model.embed_text(None)  # type: ignore[arg-type]

    with pytest.raises(InvalidInputError):
        model.embed_text(12345)  # type: ignore[arg-type]

    with pytest.raises(EmptyTextError):
        model.embed_texts([])

    with pytest.raises(EmptyTextError):
        model.embed_texts(["Valid text", "   "])

    with pytest.raises(InvalidInputError):
        model.embed_texts("not a list of strings")  # type: ignore[arg-type]


def test_model_load_failure_raises_model_load_error() -> None:
    """Loading a non-existent model identifier should raise ModelLoadError."""
    with pytest.raises(ModelLoadError):
        EmbeddingModel(model_name="non-existent-org/definitely-invalid-model-xyz-99999")
