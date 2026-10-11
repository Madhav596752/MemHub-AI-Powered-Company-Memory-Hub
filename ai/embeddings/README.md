# MemHub Module 2: Embeddings & Semantic Search (`ai/embeddings`)

## Purpose

`ai/embeddings` is **Module 2** of **MemHub – A Conversational Memory System for Organizational Knowledge**. It provides standalone, reusable Transformer-based text embedding generation, pairwise semantic similarity, and in-memory top-K semantic search without requiring a vector database, LLM, or backend API.

It is designed to work seamlessly with plain text strings, dictionaries, or structured chunk objects produced by **Module 1 (`ai/document_processor/`)**.

---

## Model Used

- **Model**: [`sentence-transformers/all-MiniLM-L6-v2`](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
- **Embedding Dimension**: `384`
- **Normalization**: L2-normalized (`||v||_2 = 1.0`) float32 vectors by default
- **Caching**: Loaded once per `(model_name, device)` pair and cached in memory to prevent repeated weight loading across calls.

---

## CPU / GPU Behavior

`EmbeddingConfig` and `resolve_device()` automatically detect hardware acceleration:
- If a CUDA-enabled GPU is available (`torch.cuda.is_available()`), the model runs on `'cuda'`.
- Otherwise, it automatically falls back to `'cpu'`.
- You can explicitly override the target device via `EmbeddingConfig(device="cpu")` or `get_embedding_model(device="cpu")`.

---

## Installation

Install the required Python dependencies from `requirements-ai.txt`:

```bash
pip install -r requirements-ai.txt
```

Core dependencies:
- `sentence-transformers`
- `torch`
- `numpy`
- `pytest`

---

## Basic Usage

### 1. Embedding Generation (`embed_text` & `embed_chunks`)

```python
from ai.embeddings import embed_text, embed_chunks

# Single text embedding
result = embed_text(
    "The user can reset their password from the account settings.",
    document_id="doc_sec_01",
    chunk_id="chunk_01",
    metadata={"source": "security_guide.pdf", "page": 4},
)

print(result.dimension)     # 384
print(result.embedding[:5]) # numpy float32 array slice
print(result.document_id)   # "doc_sec_01"

# Batch chunk embeddings (compatible with Module 1 chunk dicts/objects)
chunks = [
    {
        "document_id": "doc_sec_01",
        "chunk_id": "chunk_01",
        "text": "The user can reset their password from the account settings.",
        "metadata": {"section": "auth"},
    },
    {
        "document_id": "doc_ops_02",
        "chunk_id": "chunk_02",
        "text": "The team discussed the office meeting schedule.",
        "metadata": {"section": "general"},
    },
]

batch_result = embed_chunks(chunks)
print(batch_result.count)            # 2
print(batch_result.embeddings.shape) # (2, 384)
```

### 2. Semantic Similarity (`semantic_similarity`)

```python
from ai.embeddings import semantic_similarity

score_related = semantic_similarity(
    "How do I reset my password?",
    "The user can reset their password from the account settings.",
)

score_unrelated = semantic_similarity(
    "How do I reset my password?",
    "The team discussed the office meeting schedule.",
)

print(f"Related score:   {score_related:.4f}")
print(f"Unrelated score: {score_unrelated:.4f}")
assert score_related > score_unrelated
```

### 3. In-Memory Top-K Semantic Search (`semantic_search`)

```python
from ai.embeddings import semantic_search

results = semantic_search(
    query="How do I reset my password?",
    chunks=chunks,
    top_k=2,
)

for match in results:
    print(
        f"Rank #{match.rank} | score={match.score:.4f} | "
        f"doc={match.document_id} | chunk={match.chunk_id} | text={match.text}"
    )
```

---

## Expected Inputs & Outputs

| Function | Inputs | Output Schema / Type |
| :--- | :--- | :--- |
| `embed_text(text, ...)` | `str`, `dict`, or Module 1 chunk object | `EmbeddingResult` (`embedding: np.ndarray (384,)`, `dimension: 384`, `text`, `document_id`, `chunk_id`, `metadata`) |
| `embed_chunks(chunks, ...)` | `Sequence[str \| dict \| Chunk]` | `BatchEmbeddingResult` (`results: List[EmbeddingResult]`, `embeddings: np.ndarray (N, 384)`, `count`, `dimension`) |
| `semantic_similarity(text1, text2)` | Two strings, chunks, or 1D vectors | `float` in `[-1.0, 1.0]` (or `SimilarityResult` if `as_schema=True`) |
| `semantic_search(query, chunks, top_k=5)` | `query: str`, `chunks: Sequence`, `top_k: int` | `List[SemanticSearchResult]` ordered descending by similarity score |

---

## CLI / Demo

Run the built-in demonstration directly from the project root:

```bash
python -m ai.embeddings
```

Or with custom arguments:

```bash
python -m ai.embeddings --query "How do I reset my password?" --top-k 3 --json
```

---

## Testing

Run the Module 2 test suite using `pytest`:

```bash
python -m pytest ai/embeddings/tests -v
```
