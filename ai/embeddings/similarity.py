"""Cosine similarity and vector normalization utilities for MemHub embeddings."""

from __future__ import annotations

from typing import Any, Sequence, Union

import numpy as np

from ai.embeddings.exceptions import DimensionMismatchError, InvalidInputError
from ai.embeddings.schemas import EmbeddingResult

VectorLike = Union[np.ndarray, Sequence[float], EmbeddingResult]


def _to_1d_array(vec: VectorLike, name: str = "vector") -> np.ndarray:
    """Convert a vector-like object into a validated 1D float32 numpy array."""
    if vec is None:
        raise InvalidInputError(f"'{name}' cannot be None.")

    if isinstance(vec, EmbeddingResult):
        arr = vec.embedding
    elif isinstance(vec, (str, bytes, dict)):
        raise InvalidInputError(
            f"'{name}' must be a numeric vector or EmbeddingResult, got {type(vec).__name__}."
        )
    else:
        try:
            arr = np.asarray(vec, dtype=np.float32)
        except (ValueError, TypeError) as exc:
            raise InvalidInputError(
                f"Failed to convert '{name}' to a numeric numpy array: {exc}"
            ) from exc

    if arr.ndim == 2 and arr.shape[0] == 1:
        arr = arr.reshape(-1)
    elif arr.ndim != 1:
        raise InvalidInputError(
            f"Expected '{name}' to be a 1D vector, got {arr.ndim}D with shape {arr.shape}."
        )

    if arr.size == 0:
        raise InvalidInputError(f"'{name}' cannot be an empty vector.")

    if not np.all(np.isfinite(arr)):
        raise InvalidInputError(f"'{name}' contains NaN or infinite values.")

    return arr.astype(np.float32, copy=False)


def normalize_vector(vec: VectorLike) -> np.ndarray:
    """L2-normalize a 1D vector so its Euclidean norm is 1.0.

    Args:
        vec: Input 1D vector or EmbeddingResult.

    Returns:
        Normalized 1D numpy float32 array.

    Raises:
        InvalidInputError: If the vector is invalid, empty, or has zero norm.
    """
    arr = _to_1d_array(vec, name="vector")
    norm = float(np.linalg.norm(arr))
    if norm <= 0.0:
        raise InvalidInputError("Cannot normalize a zero-magnitude vector.")
    return (arr / norm).astype(np.float32)


def normalize_matrix(matrix: np.ndarray) -> np.ndarray:
    """L2-normalize each row of a 2D embedding matrix.

    Args:
        matrix: 2D numpy array of shape (N, D).

    Returns:
        Row-normalized 2D numpy float32 array of shape (N, D).

    Raises:
        InvalidInputError: If the matrix is not 2D or contains zero-norm rows.
    """
    if matrix is None:
        raise InvalidInputError("Embedding matrix cannot be None.")
    arr = np.asarray(matrix, dtype=np.float32)
    if arr.ndim != 2 or arr.shape[0] == 0 or arr.shape[1] == 0:
        raise InvalidInputError(
            f"Expected a non-empty 2D matrix, got shape {arr.shape}."
        )
    if not np.all(np.isfinite(arr)):
        raise InvalidInputError("Embedding matrix contains NaN or infinite values.")

    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    if np.any(norms <= 0.0):
        raise InvalidInputError("Cannot normalize matrix containing a zero-magnitude row.")
    return (arr / norms).astype(np.float32)


def cosine_similarity(vec_a: VectorLike, vec_b: VectorLike) -> float:
    """Compute cosine similarity between two 1D embedding vectors.

    Safely handles both normalized and non-normalized vectors and validates
    that both vectors have matching dimensions.

    Args:
        vec_a: First embedding vector (numpy array, sequence of floats, or EmbeddingResult).
        vec_b: Second embedding vector (numpy array, sequence of floats, or EmbeddingResult).

    Returns:
        Cosine similarity as a Python float in [-1.0, 1.0].

    Raises:
        InvalidInputError: If either input is invalid, empty, or zero-magnitude.
        DimensionMismatchError: If vec_a and vec_b have different lengths.
    """
    a = _to_1d_array(vec_a, name="vec_a")
    b = _to_1d_array(vec_b, name="vec_b")

    if a.shape[0] != b.shape[0]:
        raise DimensionMismatchError(
            f"Embedding dimension mismatch: {a.shape[0]} vs {b.shape[0]}."
        )

    norm_a = float(np.linalg.norm(a))
    norm_b = float(np.linalg.norm(b))
    if norm_a <= 0.0 or norm_b <= 0.0:
        raise InvalidInputError(
            "Cannot compute cosine similarity for a zero-magnitude vector."
        )

    sim = float(np.dot(a, b) / (norm_a * norm_b))
    return float(np.clip(sim, -1.0, 1.0))


def cosine_similarity_batch(query_vec: VectorLike, matrix: Union[np.ndarray, Sequence[VectorLike]]) -> np.ndarray:
    """Compute cosine similarity between a single query vector and a batch of vectors.

    Args:
        query_vec: 1D query vector of shape (D,).
        matrix: 2D array of shape (N, D) or sequence of 1D vectors.

    Returns:
        1D numpy float32 array of shape (N,) with similarity scores.

    Raises:
        InvalidInputError: If inputs are empty or malformed.
        DimensionMismatchError: If vector dimensions do not match.
    """
    q = _to_1d_array(query_vec, name="query_vec")

    if matrix is None:
        raise InvalidInputError("Candidate matrix cannot be None.")

    if isinstance(matrix, np.ndarray):
        if matrix.ndim != 2 or matrix.shape[0] == 0:
            raise InvalidInputError(
                f"Expected a non-empty 2D candidate matrix, got shape {matrix.shape}."
            )
        if matrix.shape[1] != q.shape[0]:
            raise DimensionMismatchError(
                f"Embedding dimension mismatch: query has {q.shape[0]}, "
                f"candidates have {matrix.shape[1]}."
            )
        mat = matrix.astype(np.float32, copy=False)
    elif isinstance(matrix, Sequence) and not isinstance(matrix, (str, bytes)):
        if len(matrix) == 0:
            raise InvalidInputError("Candidate vector collection cannot be empty.")
        rows = [_to_1d_array(item, name=f"candidate[{idx}]") for idx, item in enumerate(matrix)]
        for idx, row in enumerate(rows):
            if row.shape[0] != q.shape[0]:
                raise DimensionMismatchError(
                    f"Embedding dimension mismatch at index {idx}: "
                    f"query has {q.shape[0]}, candidate has {row.shape[0]}."
                )
        mat = np.vstack(rows).astype(np.float32)
    else:
        raise InvalidInputError("Candidate matrix must be a 2D numpy array or sequence of vectors.")

    q_norm = float(np.linalg.norm(q))
    if q_norm <= 0.0:
        raise InvalidInputError("Query vector cannot have zero magnitude.")

    row_norms = np.linalg.norm(mat, axis=1)
    if np.any(row_norms <= 0.0):
        raise InvalidInputError("Candidate matrix contains a zero-magnitude vector.")

    scores = np.dot(mat, q) / (row_norms * q_norm)
    return np.clip(scores, -1.0, 1.0).astype(np.float32)
