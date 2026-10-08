# MemHub Document Processing Pipeline (Module 1)

The **MemHub Document Processing Pipeline** is the natural language processing (NLP) ingestion layer for **MemHub – A Conversational Memory System for Organizational Knowledge**. It ingests heterogeneous enterprise files and transforms them into clean, structured, semantically enriched chunks optimized for downstream transformer embedding models and vector indexing (Module 2).

---

## 1. Architecture Overview

```
                               ┌────────────────────────────────┐
                               │   Existing React Frontend      │
                               │        (Documents.jsx)         │
                               └────────────────┬───────────────┘
                                                │ (Future API Integration)
                                                ▼
                               ┌────────────────────────────────┐
                               │        Backend Service         │
                               └────────────────┬───────────────┘
                                                │
                                                ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                      MODULE 1: DOCUMENT PROCESSING PIPELINE                            │
│                                                                                        │
│   ┌─────────────┐       ┌─────────────┐       ┌─────────────┐       ┌──────────────┐   │
│   │  Extractor  │ ────► │   Cleaner   │ ────► │   Chunker   │ ────► │  Structured  │   │
│   │  (PDF, DOCX,│       │(Conservative│       │  (Sentence/ │       │  Result JSON │   │
│   │TXT, MD, CSV)│       │ Normalizer) │       │ Overlapping)│       │ (NLP Chunks) │   │
│   └─────────────┘       └─────────────┘       └─────────────┘       └──────────────┘   │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │
                                        ▼
                               ┌────────────────────────────────┐
                               │      Module 2: Embeddings      │
                               │   (Dense & Sparse Vectors)     │
                               └────────────────────────────────┘
```

### Module Layout
```
ai/
└── document_processor/
    ├── __init__.py           # Package exports & public API
    ├── extractor.py          # Format-specific text extractors (PDF, DOCX, TXT, MD, CSV)
    ├── cleaner.py            # Conservative text cleaner preserving casing & punctuation
    ├── chunker.py            # Sentence-aware chunker with configurable sliding overlap
    ├── schemas.py            # Data transfer classes (DocumentChunk, ProcessingResult)
    ├── pipeline.py           # Pipeline orchestrator & CLI entry point
    ├── exceptions.py         # Custom pipeline exceptions & error codes
    ├── tests/                # Comprehensive unit and integration test suite
    │   ├── conftest.py       # Pytest fixtures and programmatic file generators
    │   ├── test_extractor.py # Extraction tests across all formats & edge cases
    │   ├── test_cleaner.py   # Normalization & semantic preservation tests
    │   ├── test_chunker.py   # Chunking, overlap & sentence boundary tests
    │   ├── test_pipeline.py  # End-to-end integration tests & status verification
    │   └── sample_data/      # Sample dataset for CLI & quick testing
    └── README.md             # Architecture, usage, and schema documentation
```

---

## 2. Supported Formats & Extraction Strategy

| Format | Implementation | Structure & Extraction Strategy |
| :--- | :--- | :--- |
| **PDF** (`.pdf`) | `pypdf` | Extracts text page-by-page, preserving 1-indexed page numbers. Detects image-only/scanned PDFs (`scanned_pdf`) when text density falls below minimum threshold. |
| **DOCX** (`.docx`) | `python-docx` | Preserves hierarchical headings (`#`, `##`, `###`), paragraph groupings, and extracts tables row-by-row into key-value records. |
| **Markdown** (`.md`) | Stream reader | Reads UTF-8 with fallback decoding (`utf-8-sig`, `latin-1`). Retains headers, bullet points, blockquotes, and code snippets. |
| **Plain Text** (`.txt`)| Stream reader | Multi-encoding fallback support (`utf-8`, `latin-1`, `cp1252`). Retains technical identifiers, system paths, and URLs. |
| **CSV** (`.csv`) | Standard `csv` | Sniffs delimiters (`,`, `;`, `\t`, `\|`). Converts rows into structured semantic representations (`Record N: [Header]: Value \| ...`), ensuring column context is maintained for embeddings. |

---

## 3. Conservative Text Cleaning

Downstream transformer models (such as modern BERT/RoBERTa, Sentence-BERT, and LLM embedding models) rely heavily on capitalization, punctuation, and syntax for semantic understanding. Therefore, the pipeline uses **conservative normalization**:

### What is Cleaned:
- Normalizes carriage returns and Windows line endings (`\r\n` $\to$ `\n`).
- Strips non-printable ASCII control characters (null bytes `\x00`, form feeds, etc.) while preserving tabs and newlines.
- Strips zero-width and invisible unicode characters (`\u200b`, `\ufeff`).
- Normalizes non-breaking spaces (`\u00a0`) to standard whitespace.
- Collapses excessive runs of empty lines (3+ consecutive blank lines $\to$ 2) to maintain paragraph boundaries without bloat.

### What is STRICTLY PRESERVED:
- **Case Sensitivity**: Capitalization is kept intact (critical for NER and acronyms).
- **Punctuation**: Periods, colons, question marks, and parentheses are preserved.
- **Stopwords**: Standard language flow is maintained; stopwords are never stripped.
- **No Stemming/Lemmatization**: Grammatical tense and word forms are kept verbatim.
- **Technical Identifiers**: URLs (`https://...`), environment variables, code variables (`auth_token`, `getUserProfile`), and numbers (`$59.99`, `v2.1`) remain unmodified.

---

## 4. Chunking Strategy

The chunker splits long documents into manageable, semantically coherent passages:
- **Sentence-Aware Boundaries**: Splits at paragraph and sentence delimiters (`.`, `!`, `?` followed by capitalized tokens), preventing mid-sentence truncation.
- **Configurable Size**: Default is **500 words** per chunk (configurable via `chunk_size`).
- **Configurable Overlap**: Default is **75 words** overlap between adjacent chunks (configurable via `chunk_overlap`), ensuring cross-chunk context is preserved during vector retrieval.
- **Oversized Unit Handling**: If a single block or code snippet exceeds the target chunk size, it is safely window-sliced with overlap.
- **Metadata Attribution**: Every chunk retains its source filename, document ID, 1-indexed page number (if available), chunk index, word count, character count, and custom metadata.

---

## 5. Output Schema

The output of `process_document()` is structured as a JSON-serializable dictionary:

```json
{
  "document_id": "doc_a3baaaa1",
  "filename": "Authentication Guide.md",
  "file_type": "MD",
  "status": "completed",
  "total_chunks": 2,
  "chunks": [
    {
      "chunk_id": "doc_a3baaaa1_chunk_001",
      "document_id": "doc_a3baaaa1",
      "text": "# Authentication Guide\n\n## Overview\nMemHub provides enterprise-grade identity...",
      "source_filename": "Authentication Guide.md",
      "file_type": "MD",
      "page": null,
      "chunk_index": 0,
      "word_count": 482,
      "char_count": 3120,
      "metadata": {
        "source_filename": "Authentication Guide.md",
        "file_type": "MD",
        "chunk_size_config": 500,
        "overlap_config": 75,
        "page": null
      }
    }
  ],
  "metadata": {
    "total_pages": null,
    "chunk_size": 500,
    "chunk_overlap": 75
  },
  "error_message": null
}
```

### Supported Processing States:
- `completed`: Successfully parsed, cleaned, and chunked.
- `processing`: Document currently being ingested.
- `empty`: File was empty (0 bytes or no extractable text).
- `scanned_pdf`: PDF contains scanned pages or images with negligible extractable text.
- `unsupported`: File format is not among supported types (PDF, DOCX, TXT, MD, CSV).
- `failed`: File corrupted, unreadable, or fatal parser error.

---

## 6. Installation & Setup

Install the required Python dependencies:

```bash
pip install -r requirements-ai.txt
```

*(Requirements include `pypdf>=5.0.0`, `python-docx>=1.1.0`, and `pytest>=8.0.0`)*

---

## 7. Usage

### Python API

```python
from ai.document_processor import process_document

# Standard processing
result = process_document("path/to/document.pdf")
print("Status:", result["status"])
print("Total Chunks:", result["total_chunks"])

# Custom configuration and ID
result = process_document(
    file_path="path/to/contract.docx",
    document_id="custom_doc_042",
    chunk_size=400,
    chunk_overlap=60,
)

for chunk in result["chunks"]:
    print(f"[{chunk['chunk_id']}] Page: {chunk['page']} | Words: {chunk['word_count']}")
```

### Command-Line Interface (CLI)

Run the processor directly on any document:

```bash
# Pretty-printed summary
python -m ai.document_processor.pipeline ai/document_processor/tests/sample_data/auth_guide.md

# Full JSON output
python -m ai.document_processor.pipeline ai/document_processor/tests/sample_data/team.csv --json

# Custom chunking parameters
python -m ai.document_processor.pipeline document.pdf --chunk-size 350 --overlap 50
```

---

## 8. Running the Test Suite

Execute the full suite of unit and integration tests using pytest:

```bash
python -m pytest ai/document_processor/tests/ -v
```
