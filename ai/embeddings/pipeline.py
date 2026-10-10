"""High-level pipeline API and CLI demo for MemHub embeddings and semantic search."""

from __future__ import annotations

import argparse
import json
from typing import Any, Dict, List, Mapping, Optional, Sequence, Union

import numpy as np

from ai.embeddings.config import DEFAULT_TOP_K, EmbeddingConfig
from ai.embeddings.exceptions import (
    EmptyTextError,
    InvalidInputError,
    InvalidTopKError,
)
from ai.embeddings.model import EmbeddingModel, get_embedding_model
from ai.embeddings.schemas import (
    BatchEmbeddingResult,
    ChunkInput,
    EmbeddingResult,
    SemanticSearchResult,
    SimilarityResult,
    validate_non_empty_text,
)
from ai.embeddings.similarity import cosine_similarity, cosine_similarity_batch


def embed_text(
    text: Union[str, Mapping[str, Any], Any],
    *,
    document_id: Optional[str] = None,
    chunk_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    config: Optional[EmbeddingConfig] = None,
    model: Optional[EmbeddingModel] = None,
) -> EmbeddingResult:
    """Embed a single text string or chunk object into an EmbeddingResult.

    The returned EmbeddingResult preserves metadata (document_id, chunk_id, text)
    and also implements the NumPy array protocol (`np.asarray(res)`, `len(res)`,
    `res.shape`, `res.embedding`).

    Args:
        text: Input string, chunk dict, or Module 1 chunk object.
        document_id: Optional document identifier override.
        chunk_id: Optional chunk identifier override.
        metadata: Optional metadata dictionary override/addition.
        config: Optional EmbeddingConfig override.
        model: Optional pre-loaded EmbeddingModel instance.

    Returns:
        EmbeddingResult containing the normalized float32 embedding vector and metadata.

    Raises:
        EmptyTextError: If text is empty or whitespace.
        InvalidInputError: If input is not a valid string or chunk.
    """
    parsed = ChunkInput.from_any(text)
    if document_id is not None:
        parsed.document_id = str(document_id)
    if chunk_id is not None:
        parsed.chunk_id = str(chunk_id)
    if metadata is not None:
        if not isinstance(metadata, Mapping):
            raise InvalidInputError("metadata must be a dictionary/mapping.")
        parsed.metadata = {**parsed.metadata, **dict(metadata)}

    embedding_model = model or get_embedding_model(config=config)
    return embedding_model.embed_chunk(parsed)


def embed_chunks(
    chunks: Sequence[Any],
    *,
    config: Optional[EmbeddingConfig] = None,
    model: Optional[EmbeddingModel] = None,
    batch_size: Optional[int] = None,
) -> BatchEmbeddingResult:
    """Embed a collection of texts or Module 1 chunks in batch.

    Args:
        chunks: Non-empty sequence of strings, dicts, or Module 1 chunk objects.
        config: Optional EmbeddingConfig override.
        model: Optional pre-loaded EmbeddingModel instance.
        batch_size: Optional batch size override.

    Returns:
        BatchEmbeddingResult containing individual EmbeddingResult items and a 2D embeddings matrix.

    Raises:
        EmptyTextError: If chunks is empty or contains empty text.
        InvalidInputError: If chunks is not a valid sequence of chunk inputs.
    """
    embedding_model = model or get_embedding_model(config=config)
    return embedding_model.embed_chunks(chunks, batch_size=batch_size)


def semantic_similarity(
    text1: Union[str, EmbeddingResult, np.ndarray, Sequence[float], Any],
    text2: Union[str, EmbeddingResult, np.ndarray, Sequence[float], Any],
    *,
    as_schema: bool = False,
    config: Optional[EmbeddingConfig] = None,
    model: Optional[EmbeddingModel] = None,
) -> Union[float, SimilarityResult]:
    """Compute semantic cosine similarity between two texts, chunks, or embedding vectors.

    Args:
        text1: First text string, chunk object, or precomputed embedding vector.
        text2: Second text string, chunk object, or precomputed embedding vector.
        as_schema: If True, return a SimilarityResult schema object; otherwise return a float.
        config: Optional EmbeddingConfig override.
        model: Optional pre-loaded EmbeddingModel instance.

    Returns:
        Cosine similarity float in [-1.0, 1.0] (or SimilarityResult if as_schema=True).

    Raises:
        EmptyTextError: If either text input is empty or whitespace.
        InvalidInputError: If either input is invalid.
        DimensionMismatchError: If precomputed vectors have mismatched dimensions.
    """
    if text1 is None or text2 is None:
        raise InvalidInputError("Inputs to semantic_similarity cannot be None.")

    def _resolve_item(
        item: Any,
    ) -> tuple[np.ndarray, Optional[str], Optional[str], Optional[str]]:
        if isinstance(item, EmbeddingResult):
            return item.embedding, item.text, item.document_id, item.chunk_id
        if isinstance(item, np.ndarray) or (
            isinstance(item, Sequence)
            and not isinstance(item, (str, bytes))
            and (len(item) == 0 or isinstance(item[0], (int, float, np.number)))
        ):
            return np.asarray(item, dtype=np.float32), None, None, None
        parsed = ChunkInput.from_any(item)
        emb_model = model or get_embedding_model(config=config)
        vec = emb_model.embed_text(parsed.text)
        return vec, parsed.text, parsed.document_id, parsed.chunk_id

    vec1, str1, doc1, chunk1 = _resolve_item(text1)
    vec2, str2, doc2, chunk2 = _resolve_item(text2)

    score = cosine_similarity(vec1, vec2)

    if as_schema:
        return SimilarityResult(
            score=score,
            text_a=str1,
            text_b=str2,
            document_id_a=doc1,
            document_id_b=doc2,
            chunk_id_a=chunk1,
            chunk_id_b=chunk2,
        )
    return score


def semantic_search(
    query: str,
    chunks: Union[Sequence[Any], BatchEmbeddingResult],
    top_k: int = DEFAULT_TOP_K,
    *,
    config: Optional[EmbeddingConfig] = None,
    model: Optional[EmbeddingModel] = None,
) -> List[SemanticSearchResult]:
    """Perform in-memory top-K semantic search over a collection of chunks.

    Process:
        query -> embedding -> cosine similarity against chunk embeddings ->
        rank descending -> return top-K results.

    Args:
        query: Non-empty search query string.
        chunks: Collection of chunk strings, dicts, Module 1 chunk objects,
            EmbeddingResult objects, or a BatchEmbeddingResult.
        top_k: Maximum number of top results to return (must be a positive integer).
        config: Optional EmbeddingConfig override.
        model: Optional pre-loaded EmbeddingModel instance.

    Returns:
        List of SemanticSearchResult objects ordered by similarity score descending.

    Raises:
        EmptyTextError: If query is empty/whitespace or if any chunk has empty text.
        InvalidInputError: If query or chunks are invalid.
        InvalidTopKError: If top_k is not a positive integer.
    """
    validate_non_empty_text(query, field_name="query")

    if isinstance(top_k, bool) or not isinstance(top_k, int) or top_k <= 0:
        raise InvalidTopKError(f"top_k must be a positive integer, got {top_k!r}.")

    if chunks is None or isinstance(chunks, (str, bytes, dict)):
        raise InvalidInputError(
            "chunks must be a sequence of chunk items or a BatchEmbeddingResult."
        )

    if isinstance(chunks, BatchEmbeddingResult):
        chunk_items: Sequence[Any] = chunks.results
    elif isinstance(chunks, Sequence):
        chunk_items = chunks
    else:
        try:
            chunk_items = list(chunks)
        except TypeError as exc:
            raise InvalidInputError("chunks must be an iterable collection.") from exc

    if len(chunk_items) == 0:
        return []

    embedding_model = model or get_embedding_model(config=config)
    query_vec = embedding_model.embed_text(query)

    # Check if all items already carry precomputed embeddings
    if all(isinstance(item, EmbeddingResult) for item in chunk_items):
        embedded_results: List[EmbeddingResult] = list(chunk_items)
        candidate_matrix = np.vstack([r.embedding for r in embedded_results]).astype(np.float32)
    else:
        batch_result = embedding_model.embed_chunks(chunk_items)
        embedded_results = batch_result.results
        candidate_matrix = batch_result.embeddings

    scores = cosine_similarity_batch(query_vec, candidate_matrix)

    # Sort indices descending by similarity score
    limit = min(top_k, len(embedded_results))
    ranked_indices = np.argsort(-scores)[:limit]

    search_results: List[SemanticSearchResult] = []
    for rank_idx, item_idx in enumerate(ranked_indices, start=1):
        emb_item = embedded_results[int(item_idx)]
        search_results.append(
            SemanticSearchResult(
                text=emb_item.text,
                score=float(scores[int(item_idx)]),
                document_id=emb_item.document_id,
                chunk_id=emb_item.chunk_id,
                metadata=dict(emb_item.metadata),
                rank=rank_idx,
            )
        )

    return search_results


def run_demo() -> None:
    """Run a self-contained CLI demonstration of Module 2 capabilities."""
    parser = argparse.ArgumentParser(
        description="MemHub Module 2: Embeddings & Semantic Search CLI Demo"
    )
    parser.add_argument(
        "--query",
        type=str,
        default="How do I reset my password?",
        help="Search query to run against sample chunks.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=3,
        help="Number of top semantic search results to return.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output results as formatted JSON.",
    )
    args = parser.parse_args()

    sample_chunks = [
        {
            "document_id": "doc_sec_01",
            "chunk_id": "chunk_01",
            "text": "The user can reset their password from the account settings page using the security tab.",
            "metadata": {"source": "security_handbook.pdf", "page": 4},
        },
        {
            "document_id": "doc_ops_02",
            "chunk_id": "chunk_02",
            "text": "The team discussed the weekly office meeting schedule and catering options.",
            "metadata": {"source": "team_notes.md", "page": 1},
        },
        {
            "document_id": "doc_sec_01",
            "chunk_id": "chunk_03",
            "text": "Multi-factor authentication (MFA) is required for all administrator accounts.",
            "metadata": {"source": "security_handbook.pdf", "page": 7},
        },
        {
            "document_id": "doc_hr_03",
            "chunk_id": "chunk_04",
            "text": "Annual leave requests must be submitted through the HR portal two weeks in advance.",
            "metadata": {"source": "hr_policy.docx", "page": 12},
        },
    ]

    emb = embed_text(args.query)
    sim_related = semantic_similarity(
        args.query,
        sample_chunks[0]["text"],
    )
    sim_unrelated = semantic_similarity(
        args.query,
        sample_chunks[1]["text"],
    )
    results = semantic_search(args.query, sample_chunks, top_k=args.top_k)

    if args.json:
        output = {
            "model": emb.model_name,
            "dimension": emb.dimension,
            "query": args.query,
            "embedding_preview": [round(x, 5) for x in emb.to_list()[:5]],
            "similarity_comparison": {
                "related_score": round(sim_related, 4),
                "unrelated_score": round(sim_unrelated, 4),
            },
            "search_results": [r.to_dict() for r in results],
        }
        print(json.dumps(output, indent=2))
        return

    print("=== MemHub Module 2: Embeddings & Semantic Search Demo ===")
    print(f"Model     : {emb.model_name}")
    print(f"Dimension : {emb.dimension} (L2 norm = {float(np.linalg.norm(emb.embedding)):.4f})")
    print(f"Preview   : {[round(x, 4) for x in emb.to_list()[:6]]} ...")
    print("\n--- Pairwise Semantic Similarity ---")
    print(f"Query vs Related   : {sim_related:.4f}")
    print(f"Query vs Unrelated : {sim_unrelated:.4f}")
    print(f"\n--- Top-{args.top_k} Semantic Search Results for: '{args.query}' ---")
    for res in results:
        print(
            f"[{res.rank}] score={res.score:.4f} | doc={res.document_id} | chunk={res.chunk_id}\n"
            f"    text: {res.text}\n"
            f"    metadata: {res.metadata}"
        )


if __name__ == "__main__":
    run_demo()
