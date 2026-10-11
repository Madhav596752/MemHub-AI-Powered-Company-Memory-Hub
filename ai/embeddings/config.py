"""Configuration settings and device resolution for the MemHub embeddings module."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from ai.embeddings.exceptions import InvalidInputError

DEFAULT_MODEL_NAME: str = "sentence-transformers/all-MiniLM-L6-v2"
EMBEDDING_DIMENSION: int = 384
DEFAULT_NORMALIZE: bool = True
DEFAULT_BATCH_SIZE: int = 32
DEFAULT_TOP_K: int = 5


def resolve_device(preferred_device: Optional[str] = None) -> str:
    """Resolve the compute device ('cuda' or 'cpu') automatically if not specified.

    Args:
        preferred_device: Optional explicit device string (e.g., 'cpu', 'cuda', 'cuda:0', 'mps').

    Returns:
        Resolved device string supported by PyTorch.

    Raises:
        InvalidInputError: If preferred_device is not a valid non-empty string when provided.
    """
    if preferred_device is not None:
        if not isinstance(preferred_device, str) or not preferred_device.strip():
            raise InvalidInputError("Device must be a non-empty string when specified.")
        return preferred_device.strip().lower()

    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass

    return "cpu"


@dataclass(frozen=True)
class EmbeddingConfig:
    """Configuration for loading and running the SentenceTransformer embedding model.

    Attributes:
        model_name: HuggingFace / SentenceTransformers model identifier.
        device: Target compute device ('cpu', 'cuda', or None for auto-detection).
        normalize_embeddings: Whether to L2-normalize output vectors.
        batch_size: Batch size for encoding multiple texts.
        default_top_k: Default number of results returned by semantic search.
    """

    model_name: str = DEFAULT_MODEL_NAME
    device: Optional[str] = None
    normalize_embeddings: bool = DEFAULT_NORMALIZE
    batch_size: int = DEFAULT_BATCH_SIZE
    default_top_k: int = DEFAULT_TOP_K

    def __post_init__(self) -> None:
        if not isinstance(self.model_name, str) or not self.model_name.strip():
            raise InvalidInputError("model_name must be a non-empty string.")
        if self.device is not None and (
            not isinstance(self.device, str) or not self.device.strip()
        ):
            raise InvalidInputError("device must be None or a non-empty string.")
        if not isinstance(self.batch_size, int) or isinstance(self.batch_size, bool) or self.batch_size <= 0:
            raise InvalidInputError("batch_size must be a positive integer.")
        if (
            not isinstance(self.default_top_k, int)
            or isinstance(self.default_top_k, bool)
            or self.default_top_k <= 0
        ):
            raise InvalidInputError("default_top_k must be a positive integer.")

    @property
    def resolved_device(self) -> str:
        """Return the resolved runtime device ('cuda' or 'cpu')."""
        return resolve_device(self.device)
