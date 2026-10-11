"""Custom exceptions for the MemHub embeddings and semantic search module."""


class EmbeddingError(Exception):
    """Base exception for all embedding and semantic similarity errors."""


class EmptyTextError(EmbeddingError, ValueError):
    """Raised when input text is empty or contains only whitespace."""


class InvalidInputError(EmbeddingError, ValueError):
    """Raised when input data type, structure, or parameters are invalid."""


class ModelLoadError(EmbeddingError, RuntimeError):
    """Raised when the SentenceTransformer embedding model fails to load."""


class DimensionMismatchError(EmbeddingError, ValueError):
    """Raised when comparing vectors of incompatible dimensions."""


class InvalidTopKError(EmbeddingError, ValueError):
    """Raised when top_k is not a positive integer."""
