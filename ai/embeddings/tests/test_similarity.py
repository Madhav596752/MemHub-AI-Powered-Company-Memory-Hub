"""Tests for cosine similarity, vector normalization, and dimension mismatch validation."""

from __future__ import annotations

import numpy as np
import pytest

from ai.embeddings.exceptions import DimensionMismatchError, InvalidInputError
from ai.embeddings.pipeline import semantic_similarity
from ai.embeddings.schemas import SimilarityResult
from ai.embeddings.similarity import (
    cosine_similarity,
    cosine_similarity_batch,
    normalize_matrix,
    normalize_vector,
)


def test_cosine_similarity_identical_and_opposite_vectors() -> None:
    """Identical vectors should have similarity ~1.0; opposite vectors ~-1.0; orthogonal ~0.0."""
    vec = np.array([0.6, 0.8, 0.0], dtype=np.float32)
    opposite = np.array([-0.6, -0.8, 0.0], dtype=np.float32)
    orthogonal = np.array([0.0, 0.0, 1.0], dtype=np.float32)

    assert np.isclose(cosine_similarity(vec, vec), 1.0, atol=1e-6)
    assert np.isclose(cosine_similarity(vec, opposite), -1.0, atol=1e-6)
    assert np.isclose(cosine_similarity(vec, orthogonal), 0.0, atol=1e-6)


def test_cosine_similarity_handles_non_normalized_vectors() -> None:
    """Scaled non-normalized vectors pointing in the same direction should have similarity 1.0."""
    vec_normalized = normalize_vector([1.0, 2.0, 3.0, 4.0])
    vec_unnormalized = np.array([10.0, 20.0, 30.0, 40.0], dtype=np.float32)

    score = cosine_similarity(vec_normalized, vec_unnormalized)
    assert isinstance(score, float)
    assert np.isclose(score, 1.0, atol=1e-6)


def test_cosine_similarity_dimension_validation() -> None:
    """Comparing vectors of different dimensions must raise DimensionMismatchError."""
    vec_3d = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    vec_4d = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32)

    with pytest.raises(DimensionMismatchError):
        cosine_similarity(vec_3d, vec_4d)

    with pytest.raises(DimensionMismatchError):
        cosine_similarity_batch(vec_3d, np.ones((2, 4), dtype=np.float32))


def test_cosine_similarity_invalid_and_zero_vectors() -> None:
    """Zero vectors, empty vectors, or non-numeric inputs should raise InvalidInputError."""
    with pytest.raises(InvalidInputError):
        cosine_similarity([0.0, 0.0, 0.0], [1.0, 0.0, 0.0])

    with pytest.raises(InvalidInputError):
        cosine_similarity([], [])

    with pytest.raises(InvalidInputError):
        cosine_similarity(None, [1.0, 2.0])  # type: ignore[arg-type]

    with pytest.raises(InvalidInputError):
        normalize_vector([0.0, 0.0])

    with pytest.raises(InvalidInputError):
        normalize_matrix(np.zeros((2, 3), dtype=np.float32))


def test_semantic_similarity_relative_ranking() -> None:
    """Related sentences must produce a higher similarity score than unrelated sentences."""
    query = "How do I reset my password?"
    related = "The user can reset their password from the account settings."
    unrelated = "The team discussed the office meeting schedule."

    score_related = semantic_similarity(query, related)
    score_unrelated = semantic_similarity(query, unrelated)

    assert isinstance(score_related, float)
    assert isinstance(score_unrelated, float)
    assert score_related > score_unrelated


def test_semantic_similarity_schema_output() -> None:
    """semantic_similarity with as_schema=True should return a populated SimilarityResult."""
    res = semantic_similarity(
        {"document_id": "d1", "chunk_id": "c1", "text": "Reset account password in settings."},
        {"document_id": "d2", "chunk_id": "c2", "text": "Change or recover your login password."},
        as_schema=True,
    )
    assert isinstance(res, SimilarityResult)
    assert res.document_id_a == "d1"
    assert res.document_id_b == "d2"
    assert res.chunk_id_a == "c1"
    assert res.chunk_id_b == "c2"
    assert res.score == res.similarity_score
    assert -1.0 <= res.score <= 1.0
