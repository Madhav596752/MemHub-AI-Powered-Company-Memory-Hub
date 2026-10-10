"""Structured data schemas for embeddings, similarity, and semantic search results."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Mapping, Optional, Sequence, Tuple, Union

import numpy as np

from ai.embeddings.config import DEFAULT_MODEL_NAME, EMBEDDING_DIMENSION
from ai.embeddings.exceptions import EmptyTextError, InvalidInputError


def validate_non_empty_text(text: Any, field_name: str = "text") -> str:
    """Validate that an input is a non-empty, non-whitespace string.

    Args:
        text: Value to validate.
        field_name: Name of the parameter for error messages.

    Returns:
        The validated string.

    Raises:
        InvalidInputError: If text is not a string.
        EmptyTextError: If text is empty or whitespace-only.
    """
    if not isinstance(text, str):
        raise InvalidInputError(
            f"Expected '{field_name}' to be a str, got {type(text).__name__}."
        )
    if not text.strip():
        raise EmptyTextError(f"'{field_name}' cannot be empty or whitespace-only.")
    return text


@dataclass
class ChunkInput:
    """Normalized representation of a document chunk compatible with Module 1 output.

    Supports plain strings, dictionaries, dataclasses, or custom objects produced by
    `ai/document_processor/`.
    """

    text: str
    document_id: Optional[str] = None
    chunk_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        validate_non_empty_text(self.text, field_name="text")
        if self.document_id is not None:
            self.document_id = str(self.document_id)
        if self.chunk_id is not None:
            self.chunk_id = str(self.chunk_id)
        if self.metadata is None:
            self.metadata = {}
        elif not isinstance(self.metadata, dict):
            if isinstance(self.metadata, Mapping):
                self.metadata = dict(self.metadata)
            else:
                raise InvalidInputError("chunk metadata must be a dictionary.")

    @classmethod
    def from_any(cls, raw: Any, index: Optional[int] = None) -> "ChunkInput":
        """Convert a string, dict, or Module 1 chunk object into a ChunkInput.

        Args:
            raw: A plain string, dictionary, or object with text/content attributes.
            index: Optional fallback index used when chunk_id is not present.

        Returns:
            Normalized ChunkInput instance.

        Raises:
            InvalidInputError: If the input type or structure is invalid.
            EmptyTextError: If the extracted text is empty or whitespace.
        """
        if raw is None:
            raise InvalidInputError("Chunk item cannot be None.")

        if isinstance(raw, cls):
            return cls(
                text=raw.text,
                document_id=raw.document_id,
                chunk_id=raw.chunk_id,
                metadata=dict(raw.metadata),
            )

        if isinstance(raw, EmbeddingResult):
            return cls(
                text=raw.text,
                document_id=raw.document_id,
                chunk_id=raw.chunk_id,
                metadata=dict(raw.metadata),
            )

        if isinstance(raw, str):
            validate_non_empty_text(raw, field_name="chunk text")
            return cls(
                text=raw,
                document_id=None,
                chunk_id=f"chunk_{index}" if index is not None else None,
                metadata={},
            )

        if isinstance(raw, Mapping):
            text_val = raw.get("text") if "text" in raw else raw.get("content")
            if text_val is None:
                raise InvalidInputError(
                    "Chunk dictionary must contain a 'text' or 'content' field."
                )
            validate_non_empty_text(text_val, field_name="chunk text")

            doc_id = raw.get("document_id", raw.get("doc_id"))
            chunk_id = raw.get("chunk_id", raw.get("id"))
            if chunk_id is None and index is not None:
                chunk_id = f"chunk_{index}"

            raw_meta = raw.get("metadata")
            if raw_meta is not None and not isinstance(raw_meta, Mapping):
                raise InvalidInputError("Chunk 'metadata' field must be a mapping/dict.")
            metadata: Dict[str, Any] = dict(raw_meta) if isinstance(raw_meta, Mapping) else {}

            # Preserve additional Module 1 chunk fields inside metadata
            reserved_keys = {
                "text",
                "content",
                "document_id",
                "doc_id",
                "chunk_id",
                "id",
                "metadata",
                "embedding",
            }
            for k, v in raw.items():
                if k not in reserved_keys and k not in metadata:
                    metadata[k] = v

            return cls(
                text=text_val,
                document_id=str(doc_id) if doc_id is not None else None,
                chunk_id=str(chunk_id) if chunk_id is not None else None,
                metadata=metadata,
            )

        # Support Module 1 dataclass / Pydantic / custom Python chunk objects
        if hasattr(raw, "text") or hasattr(raw, "content"):
            text_val = getattr(raw, "text", None)
            if text_val is None:
                text_val = getattr(raw, "content", None)
            if text_val is None:
                raise InvalidInputError("Chunk object has None 'text'/'content'.")
            validate_non_empty_text(text_val, field_name="chunk text")

            doc_id = getattr(raw, "document_id", getattr(raw, "doc_id", None))
            chunk_id = getattr(raw, "chunk_id", getattr(raw, "id", None))
            if chunk_id is None and index is not None:
                chunk_id = f"chunk_{index}"

            raw_meta = getattr(raw, "metadata", None)
            if raw_meta is not None and not isinstance(raw_meta, Mapping):
                raise InvalidInputError("Chunk object 'metadata' attribute must be a mapping/dict.")
            metadata = dict(raw_meta) if isinstance(raw_meta, Mapping) else {}

            # Capture extra attributes from Module 1 chunk objects (e.g. chunk_index, page_number, token_count)
            reserved_attrs = {
                "text",
                "content",
                "document_id",
                "doc_id",
                "chunk_id",
                "id",
                "metadata",
                "embedding",
            }
            if hasattr(raw, "__dict__"):
                for k, v in vars(raw).items():
                    if (
                        not k.startswith("_")
                        and k not in reserved_attrs
                        and not callable(v)
                        and k not in metadata
                    ):
                        metadata[k] = v

            return cls(
                text=text_val,
                document_id=str(doc_id) if doc_id is not None else None,
                chunk_id=str(chunk_id) if chunk_id is not None else None,
                metadata=metadata,
            )

        raise InvalidInputError(
            f"Unsupported chunk type: {type(raw).__name__}. "
            "Expected str, dict, or an object with a 'text' attribute."
        )


@dataclass
class EmbeddingResult:
    """Result schema for a single embedded text or document chunk.

    Supports both structured metadata access (.embedding, .text, .document_id,
    .chunk_id, .metadata) and direct NumPy/sequence operations (__array__, len,
    .shape, .tolist()).
    """

    text: str
    embedding: np.ndarray
    dimension: int = EMBEDDING_DIMENSION
    model_name: str = DEFAULT_MODEL_NAME
    normalized: bool = True
    document_id: Optional[str] = None
    chunk_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.embedding = np.asarray(self.embedding, dtype=np.float32)
        if self.embedding.ndim != 1:
            raise InvalidInputError(
                f"EmbeddingResult expects a 1D vector, got shape {self.embedding.shape}."
            )
        self.dimension = int(self.embedding.shape[0])

    @property
    def vector(self) -> np.ndarray:
        """Alias for the underlying numpy embedding vector."""
        return self.embedding

    @property
    def shape(self) -> Tuple[int, ...]:
        """Return the shape of the underlying embedding vector."""
        return self.embedding.shape

    @property
    def dtype(self) -> np.dtype:
        """Return the dtype of the underlying embedding vector."""
        return self.embedding.dtype

    @property
    def ndim(self) -> int:
        """Return the number of dimensions of the underlying embedding vector."""
        return self.embedding.ndim

    @property
    def size(self) -> int:
        """Return the number of elements in the embedding vector."""
        return self.embedding.size

    def __array__(self, dtype: Optional[Any] = None) -> np.ndarray:
        if dtype is None:
            return self.embedding
        return self.embedding.astype(dtype)

    def __len__(self) -> int:
        return self.dimension

    def __iter__(self) -> Iterator[float]:
        return iter(self.embedding.tolist())

    def to_list(self) -> List[float]:
        """Return the embedding vector as a standard Python list of floats."""
        return self.embedding.tolist()

    def tolist(self) -> List[float]:
        """NumPy-compatible alias returning a Python list of floats."""
        return self.embedding.tolist()

    def to_dict(self) -> Dict[str, Any]:
        """Serialize the embedding result to a dictionary."""
        return {
            "text": self.text,
            "embedding": self.embedding,
            "dimension": self.dimension,
            "model_name": self.model_name,
            "normalized": self.normalized,
            "document_id": self.document_id,
            "chunk_id": self.chunk_id,
            "metadata": dict(self.metadata),
        }

    def __getitem__(self, key: Union[int, slice, str]) -> Any:
        if isinstance(key, (int, slice, np.integer)):
            return self.embedding[key]
        data = self.to_dict()
        if key in data:
            return data[key]
        raise KeyError(key)


@dataclass
class BatchEmbeddingResult:
    """Result schema for a batch of embedded texts or document chunks."""

    results: List[EmbeddingResult]
    model_name: str = DEFAULT_MODEL_NAME
    dimension: int = EMBEDDING_DIMENSION
    normalized: bool = True

    def __post_init__(self) -> None:
        if self.results:
            self.dimension = self.results[0].dimension

    @property
    def items(self) -> List[EmbeddingResult]:
        """Alias for results list."""
        return self.results

    @property
    def count(self) -> int:
        """Total number of embedded items in the batch."""
        return len(self.results)

    @property
    def embeddings(self) -> np.ndarray:
        """Return a 2D numpy array of shape (N, dimension) for all items in the batch."""
        if not self.results:
            return np.empty((0, self.dimension), dtype=np.float32)
        return np.vstack([item.embedding for item in self.results]).astype(np.float32)

    @property
    def shape(self) -> Tuple[int, int]:
        """Return the 2D shape (count, dimension) of the batch embeddings."""
        return (self.count, self.dimension)

    def __array__(self, dtype: Optional[Any] = None) -> np.ndarray:
        mat = self.embeddings
        return mat if dtype is None else mat.astype(dtype)

    def __len__(self) -> int:
        return len(self.results)

    def __iter__(self) -> Iterator[EmbeddingResult]:
        return iter(self.results)

    def __getitem__(self, key: Union[int, slice, str]) -> Any:
        if isinstance(key, (int, slice)):
            return self.results[key]
        if key in {"results", "items"}:
            return self.results
        if key == "embeddings":
            return self.embeddings
        if key == "count":
            return self.count
        if key == "dimension":
            return self.dimension
        if key == "model_name":
            return self.model_name
        if key == "normalized":
            return self.normalized
        raise KeyError(key)

    def to_dict(self) -> Dict[str, Any]:
        """Serialize the batch embedding result to a dictionary."""
        return {
            "results": [r.to_dict() for r in self.results],
            "embeddings": self.embeddings,
            "count": self.count,
            "dimension": self.dimension,
            "model_name": self.model_name,
            "normalized": self.normalized,
        }


@dataclass
class SimilarityResult:
    """Result schema for semantic similarity between two texts or vectors."""

    score: float
    text_a: Optional[str] = None
    text_b: Optional[str] = None
    document_id_a: Optional[str] = None
    document_id_b: Optional[str] = None
    chunk_id_a: Optional[str] = None
    chunk_id_b: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.score = float(self.score)

    @property
    def similarity_score(self) -> float:
        """Alias for score."""
        return self.score

    def __float__(self) -> float:
        return float(self.score)

    def __gt__(self, other: Any) -> bool:
        if isinstance(other, SimilarityResult):
            return self.score > other.score
        if isinstance(other, (int, float, np.floating)):
            return self.score > float(other)
        return NotImplemented

    def __lt__(self, other: Any) -> bool:
        if isinstance(other, SimilarityResult):
            return self.score < other.score
        if isinstance(other, (int, float, np.floating)):
            return self.score < float(other)
        return NotImplemented

    def __ge__(self, other: Any) -> bool:
        if isinstance(other, SimilarityResult):
            return self.score >= other.score
        if isinstance(other, (int, float, np.floating)):
            return self.score >= float(other)
        return NotImplemented

    def __le__(self, other: Any) -> bool:
        if isinstance(other, SimilarityResult):
            return self.score <= other.score
        if isinstance(other, (int, float, np.floating)):
            return self.score <= float(other)
        return NotImplemented

    def to_dict(self) -> Dict[str, Any]:
        """Serialize the similarity result to a dictionary."""
        return {
            "score": self.score,
            "similarity_score": self.score,
            "text_a": self.text_a,
            "text_b": self.text_b,
            "document_id_a": self.document_id_a,
            "document_id_b": self.document_id_b,
            "chunk_id_a": self.chunk_id_a,
            "chunk_id_b": self.chunk_id_b,
            "metadata": dict(self.metadata),
        }

    def __getitem__(self, key: str) -> Any:
        data = self.to_dict()
        if key in data:
            return data[key]
        raise KeyError(key)


@dataclass
class SemanticSearchResult:
    """Result schema for a single ranked item in a top-K semantic search."""

    text: str
    score: float
    document_id: Optional[str] = None
    chunk_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    rank: int = 1

    def __post_init__(self) -> None:
        self.score = float(self.score)

    @property
    def similarity_score(self) -> float:
        """Alias for score."""
        return self.score

    def to_dict(self) -> Dict[str, Any]:
        """Serialize the semantic search result to a dictionary."""
        return {
            "rank": self.rank,
            "score": self.score,
            "similarity_score": self.score,
            "text": self.text,
            "document_id": self.document_id,
            "chunk_id": self.chunk_id,
            "metadata": dict(self.metadata),
        }

    def __getitem__(self, key: str) -> Any:
        data = self.to_dict()
        if key in data:
            return data[key]
        raise KeyError(key)
