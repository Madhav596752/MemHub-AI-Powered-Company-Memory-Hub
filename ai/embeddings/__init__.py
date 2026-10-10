"""MemHub Module 2: Transformer-based text embeddings and semantic similarity/search."""

from ai.embeddings.config import (
    DEFAULT_BATCH_SIZE,
    DEFAULT_MODEL_NAME,
    DEFAULT_NORMALIZE,
    DEFAULT_TOP_K,
    EMBEDDING_DIMENSION,
    EmbeddingConfig,
    resolve_device,
)
from ai.embeddings.exceptions import (
    DimensionMismatchError,
    EmbeddingError,
    EmptyTextError,
    InvalidInputError,
    InvalidTopKError,
    ModelLoadError,
)
from ai.embeddings.model import (
    EmbeddingModel,
    clear_model_cache,
    get_embedding_model,
)
from ai.embeddings.pipeline import (
    embed_chunks,
    embed_text,
    run_demo,
    semantic_search,
    semantic_similarity,
)
from ai.embeddings.schemas import (
    BatchEmbeddingResult,
    ChunkInput,
    EmbeddingResult,
    SemanticSearchResult,
    SimilarityResult,
)
from ai.embeddings.similarity import (
    cosine_similarity,
    cosine_similarity_batch,
    normalize_matrix,
    normalize_vector,
)

__all__ = [
    "DEFAULT_BATCH_SIZE",
    "DEFAULT_MODEL_NAME",
    "DEFAULT_NORMALIZE",
    "DEFAULT_TOP_K",
    "EMBEDDING_DIMENSION",
    "EmbeddingConfig",
    "resolve_device",
    "EmbeddingError",
    "EmptyTextError",
    "InvalidInputError",
    "ModelLoadError",
    "DimensionMismatchError",
    "InvalidTopKError",
    "EmbeddingModel",
    "get_embedding_model",
    "clear_model_cache",
    "ChunkInput",
    "EmbeddingResult",
    "BatchEmbeddingResult",
    "SimilarityResult",
    "SemanticSearchResult",
    "cosine_similarity",
    "cosine_similarity_batch",
    "normalize_vector",
    "normalize_matrix",
    "embed_text",
    "embed_chunks",
    "semantic_similarity",
    "semantic_search",
    "run_demo",
]
