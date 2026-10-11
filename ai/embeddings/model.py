"""SentenceTransformer model wrapper and singleton caching for MemHub."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ai.embeddings.config import (
    DEFAULT_MODEL_NAME,
    EmbeddingConfig,
    resolve_device,
)
from ai.embeddings.exceptions import (
    EmptyTextError,
    InvalidInputError,
    ModelLoadError,
)
from ai.embeddings.schemas import (
    BatchEmbeddingResult,
    ChunkInput,
    EmbeddingResult,
    validate_non_empty_text,
)
from ai.embeddings.similarity import normalize_matrix, normalize_vector

# Module-level cache keyed by (model_name, resolved_device) to prevent repeated loading
_MODEL_INSTANCE_CACHE: Dict[Tuple[str, str], "EmbeddingModel"] = {}


class EmbeddingModel:
    """Reusable wrapper around SentenceTransformer for text and batch embeddings.

    Automatically selects GPU ('cuda') when available and falls back to 'cpu'.
    Normalizes output embeddings by default and returns numpy float32 vectors.
    """

    def __init__(
        self,
        config: Optional[EmbeddingConfig] = None,
        model_name: Optional[str] = None,
        device: Optional[str] = None,
        normalize_embeddings: Optional[bool] = None,
        batch_size: Optional[int] = None,
    ) -> None:
        base_config = config or EmbeddingConfig()
        self.config = EmbeddingConfig(
            model_name=model_name if model_name is not None else base_config.model_name,
            device=device if device is not None else base_config.device,
            normalize_embeddings=(
                normalize_embeddings
                if normalize_embeddings is not None
                else base_config.normalize_embeddings
            ),
            batch_size=batch_size if batch_size is not None else base_config.batch_size,
            default_top_k=base_config.default_top_k,
        )
        self.model_name: str = self.config.model_name
        self.device: str = self.config.resolved_device
        self.normalize_embeddings: bool = self.config.normalize_embeddings
        self._model = self._load_sentence_transformer(self.model_name, self.device)
        self.dimension: int = self._resolve_dimension()

    @staticmethod
    def _load_sentence_transformer(model_name: str, device: str) -> Any:
        """Load the underlying SentenceTransformer model with error handling."""
        if not isinstance(model_name, str) or not model_name.strip():
            raise ModelLoadError("Model name must be a non-empty string.")
        try:
            from sentence_transformers import SentenceTransformer

            return SentenceTransformer(model_name, device=device)
        except Exception as exc:
            raise ModelLoadError(
                f"Failed to load SentenceTransformer model '{model_name}' on device '{device}': {exc}"
            ) from exc

    def _resolve_dimension(self) -> int:
        """Obtain the model's output embedding dimension."""
        try:
            dim = self._model.get_sentence_embedding_dimension()
            if isinstance(dim, int) and dim > 0:
                return dim
        except Exception:
            pass
        return 384

    def embed_text(
        self,
        text: str,
        normalize: Optional[bool] = None,
    ) -> np.ndarray:
        """Generate a 1D embedding vector for a single text string.

        Args:
            text: Non-empty text string to embed.
            normalize: Override whether to L2-normalize the resulting vector.

        Returns:
            1D numpy array of dtype float32 with shape (dimension,).

        Raises:
            InvalidInputError: If text is not a string.
            EmptyTextError: If text is empty or whitespace-only.
        """
        validate_non_empty_text(text, field_name="text")
        should_normalize = self.normalize_embeddings if normalize is None else bool(normalize)

        raw_vec = self._model.encode(
            text,
            convert_to_numpy=True,
            normalize_embeddings=should_normalize,
            show_progress_bar=False,
        )
        vec = np.asarray(raw_vec, dtype=np.float32).reshape(-1)
        if should_normalize:
            vec = normalize_vector(vec)
        return vec

    def embed_texts(
        self,
        texts: Sequence[str],
        normalize: Optional[bool] = None,
        batch_size: Optional[int] = None,
    ) -> np.ndarray:
        """Generate a 2D matrix of embeddings for a batch of text strings.

        Args:
            texts: Non-empty sequence of non-empty text strings.
            normalize: Override whether to L2-normalize each vector.
            batch_size: Optional batch size override.

        Returns:
            2D numpy array of dtype float32 with shape (len(texts), dimension).

        Raises:
            InvalidInputError: If texts is not a valid sequence or contains non-strings.
            EmptyTextError: If texts is empty or any element is empty/whitespace.
        """
        if texts is None or isinstance(texts, (str, bytes)):
            raise InvalidInputError(
                "texts must be a sequence (list or tuple) of strings, not a single string or None."
            )
        if not isinstance(texts, Sequence):
            try:
                texts = list(texts)
            except TypeError as exc:
                raise InvalidInputError(
                    "texts must be an iterable sequence of strings."
                ) from exc

        if len(texts) == 0:
            raise EmptyTextError("texts batch cannot be empty.")

        clean_texts: List[str] = []
        for idx, item in enumerate(texts):
            validate_non_empty_text(item, field_name=f"texts[{idx}]")
            clean_texts.append(item)

        should_normalize = self.normalize_embeddings if normalize is None else bool(normalize)
        effective_batch_size = batch_size if batch_size is not None else self.config.batch_size
        if not isinstance(effective_batch_size, int) or effective_batch_size <= 0:
            raise InvalidInputError("batch_size must be a positive integer.")

        raw_matrix = self._model.encode(
            clean_texts,
            batch_size=effective_batch_size,
            convert_to_numpy=True,
            normalize_embeddings=should_normalize,
            show_progress_bar=False,
        )
        matrix = np.asarray(raw_matrix, dtype=np.float32)
        if matrix.ndim == 1:
            matrix = matrix.reshape(1, -1)
        if should_normalize:
            matrix = normalize_matrix(matrix)
        return matrix

    def embed_chunk(
        self,
        chunk: Any,
        normalize: Optional[bool] = None,
    ) -> EmbeddingResult:
        """Embed a single text or chunk and return a structured EmbeddingResult."""
        parsed = ChunkInput.from_any(chunk)
        should_normalize = self.normalize_embeddings if normalize is None else bool(normalize)
        vec = self.embed_text(parsed.text, normalize=should_normalize)
        return EmbeddingResult(
            text=parsed.text,
            embedding=vec,
            dimension=int(vec.shape[0]),
            model_name=self.model_name,
            normalized=should_normalize,
            document_id=parsed.document_id,
            chunk_id=parsed.chunk_id,
            metadata=parsed.metadata,
        )

    def embed_chunks(
        self,
        chunks: Sequence[Any],
        normalize: Optional[bool] = None,
        batch_size: Optional[int] = None,
    ) -> BatchEmbeddingResult:
        """Embed a batch of texts or Module 1 chunks and return a BatchEmbeddingResult."""
        if chunks is None or isinstance(chunks, (str, bytes, dict)):
            raise InvalidInputError(
                "chunks must be a sequence (list or tuple) of chunk items or strings."
            )
        if not isinstance(chunks, Sequence):
            try:
                chunks = list(chunks)
            except TypeError as exc:
                raise InvalidInputError("chunks must be a sequence of items.") from exc

        if len(chunks) == 0:
            raise EmptyTextError("chunks collection cannot be empty.")

        parsed_chunks: List[ChunkInput] = [
            ChunkInput.from_any(c, index=idx) for idx, c in enumerate(chunks)
        ]
        should_normalize = self.normalize_embeddings if normalize is None else bool(normalize)
        matrix = self.embed_texts(
            [c.text for c in parsed_chunks],
            normalize=should_normalize,
            batch_size=batch_size,
        )

        results: List[EmbeddingResult] = []
        for idx, parsed in enumerate(parsed_chunks):
            vec = matrix[idx]
            results.append(
                EmbeddingResult(
                    text=parsed.text,
                    embedding=vec,
                    dimension=int(vec.shape[0]),
                    model_name=self.model_name,
                    normalized=should_normalize,
                    document_id=parsed.document_id,
                    chunk_id=parsed.chunk_id,
                    metadata=parsed.metadata,
                )
            )

        return BatchEmbeddingResult(
            results=results,
            model_name=self.model_name,
            dimension=self.dimension,
            normalized=should_normalize,
        )


def get_embedding_model(
    config: Optional[EmbeddingConfig] = None,
    model_name: Optional[str] = None,
    device: Optional[str] = None,
    normalize_embeddings: Optional[bool] = None,
    force_reload: bool = False,
) -> EmbeddingModel:
    """Get or create a cached EmbeddingModel instance.

    Prevents reloading the SentenceTransformer weights across repeated pipeline calls.

    Args:
        config: Optional EmbeddingConfig instance.
        model_name: Optional model name override.
        device: Optional device override ('cpu' or 'cuda').
        normalize_embeddings: Optional normalization flag override.
        force_reload: If True, bypass and update the in-memory model cache.

    Returns:
        Loaded EmbeddingModel instance.
    """
    base_config = config or EmbeddingConfig()
    effective_name = model_name if model_name is not None else base_config.model_name
    if not isinstance(effective_name, str) or not effective_name.strip():
        raise ModelLoadError("Model name must be a non-empty string.")

    effective_device = resolve_device(device if device is not None else base_config.device)
    cache_key = (effective_name.strip(), effective_device)

    if not force_reload and cache_key in _MODEL_INSTANCE_CACHE:
        cached = _MODEL_INSTANCE_CACHE[cache_key]
        if normalize_embeddings is not None and cached.normalize_embeddings != normalize_embeddings:
            return EmbeddingModel(
                config=base_config,
                model_name=effective_name,
                device=effective_device,
                normalize_embeddings=normalize_embeddings,
            )
        return cached

    instance = EmbeddingModel(
        config=base_config,
        model_name=effective_name,
        device=effective_device,
        normalize_embeddings=normalize_embeddings,
    )
    _MODEL_INSTANCE_CACHE[cache_key] = instance
    return instance


def clear_model_cache() -> None:
    """Clear the cached EmbeddingModel instances from memory."""
    _MODEL_INSTANCE_CACHE.clear()
