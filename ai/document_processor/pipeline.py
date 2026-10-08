"""Main Document Processing Pipeline for MemHub.

Orchestrates extraction, conservative cleaning, and sentence-aware chunking.
Provides both Python API and CLI interface.
"""

import argparse
import json
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Union

from ai.document_processor.cleaner import TextCleaner
from ai.document_processor.chunker import TextChunker
from ai.document_processor.extractor import DocumentExtractor
from ai.document_processor.schemas import (
    DocumentProcessingResult,
    ProcessingStatus,
)
from ai.document_processor.exceptions import (
    DocumentProcessorError,
    UnsupportedFileTypeError,
    EmptyDocumentError,
    ScannedPDFError,
    CorruptedFileError,
)


class DocumentProcessingPipeline:
    """Orchestrates end-to-end document processing for MemHub."""

    def __init__(
        self,
        chunk_size: int = 500,
        chunk_overlap: int = 75,
        min_chunk_size: int = 15,
    ):
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.min_chunk_size = min_chunk_size
        self.extractor = DocumentExtractor()
        self.cleaner = TextCleaner()
        self.chunker = TextChunker(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            min_chunk_size=min_chunk_size,
        )

    def process(
        self,
        file_path: Union[str, Path],
        document_id: Optional[str] = None,
    ) -> DocumentProcessingResult:
        """Processes a single file and returns structured DocumentProcessingResult.

        Args:
            file_path: Path to the target file.
            document_id: Optional document ID. If None, auto-generated.

        Returns:
            DocumentProcessingResult containing status, chunks, and metadata.
        """
        path = Path(file_path)
        doc_id = document_id or f"doc_{uuid.uuid4().hex[:8]}"
        filename = path.name

        try:
            file_type = self.extractor.get_file_type(path)
        except UnsupportedFileTypeError as e:
            return DocumentProcessingResult(
                document_id=doc_id,
                filename=filename,
                file_type=path.suffix.lstrip(".").upper() or "UNKNOWN",
                status=ProcessingStatus.UNSUPPORTED.value,
                total_chunks=0,
                chunks=[],
                error_message=str(e),
                metadata={"error_details": e.details},
            )

        try:
            # 1. Extraction (which invokes clean_text on intermediate sections)
            extracted_doc = self.extractor.extract(path)

            # 2. Chunking
            chunks = self.chunker.chunk_document(extracted_doc, doc_id)

            if not chunks:
                return DocumentProcessingResult(
                    document_id=doc_id,
                    filename=filename,
                    file_type=file_type,
                    status=ProcessingStatus.EMPTY.value,
                    total_chunks=0,
                    chunks=[],
                    error_message=f"No chunkable content found in {filename}",
                    metadata=extracted_doc.metadata,
                )

            return DocumentProcessingResult(
                document_id=doc_id,
                filename=filename,
                file_type=file_type,
                status=ProcessingStatus.COMPLETED.value,
                total_chunks=len(chunks),
                chunks=chunks,
                metadata={
                    "total_pages": extracted_doc.total_pages,
                    "extracted_metadata": extracted_doc.metadata,
                    "chunk_size": self.chunk_size,
                    "chunk_overlap": self.chunk_overlap,
                },
            )

        except EmptyDocumentError as e:
            return DocumentProcessingResult(
                document_id=doc_id,
                filename=filename,
                file_type=file_type,
                status=ProcessingStatus.EMPTY.value,
                total_chunks=0,
                chunks=[],
                error_message=str(e),
                metadata={"error_details": e.details},
            )

        except ScannedPDFError as e:
            return DocumentProcessingResult(
                document_id=doc_id,
                filename=filename,
                file_type=file_type,
                status=ProcessingStatus.SCANNED_PDF.value,
                total_chunks=0,
                chunks=[],
                error_message=str(e),
                metadata={"error_details": e.details},
            )

        except (CorruptedFileError, DocumentProcessorError) as e:
            return DocumentProcessingResult(
                document_id=doc_id,
                filename=filename,
                file_type=file_type,
                status=getattr(e, "status", ProcessingStatus.FAILED.value),
                total_chunks=0,
                chunks=[],
                error_message=str(e),
                metadata={"error_details": getattr(e, "details", {})},
            )

        except Exception as e:
            return DocumentProcessingResult(
                document_id=doc_id,
                filename=filename,
                file_type=file_type,
                status=ProcessingStatus.FAILED.value,
                total_chunks=0,
                chunks=[],
                error_message=f"Unexpected processing error: {e}",
            )


def process_document(
    file_path: Union[str, Path],
    document_id: Optional[str] = None,
    chunk_size: int = 500,
    chunk_overlap: int = 75,
) -> Dict[str, Any]:
    """Top-level main interface for Module 1.

    Args:
        file_path: File system path to the document.
        document_id: Optional unique identifier.
        chunk_size: Word count target per chunk.
        chunk_overlap: Word count overlap between consecutive chunks.

    Returns:
        JSON-serializable dictionary matching MemHub spec.
    """
    pipeline = DocumentProcessingPipeline(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
    )
    result = pipeline.process(file_path=file_path, document_id=document_id)
    return result.to_dict()


def main():
    """Command-line interface entry point."""
    parser = argparse.ArgumentParser(
        description="MemHub Document Processing Pipeline (CLI)",
        prog="python -m ai.document_processor.pipeline",
    )
    parser.add_argument("file_path", help="Path to the document to process")
    parser.add_argument("--doc-id", default=None, help="Optional custom document ID")
    parser.add_argument("--chunk-size", type=int, default=500, help="Chunk size in words (default: 500)")
    parser.add_argument("--overlap", type=int, default=75, help="Chunk overlap in words (default: 75)")
    parser.add_argument("--json", action="store_true", help="Print raw JSON output")

    args = parser.parse_args()

    file_p = Path(args.file_path)
    if not file_p.exists():
        print(f"Error: File '{args.file_path}' does not exist.", file=sys.stderr)
        sys.exit(1)

    result_dict = process_document(
        file_path=file_p,
        document_id=args.doc_id,
        chunk_size=args.chunk_size,
        chunk_overlap=args.overlap,
    )

    if args.json:
        print(json.dumps(result_dict, indent=2))
    else:
        print("=" * 60)
        print(" MEMHUB DOCUMENT PROCESSING PIPELINE ")
        print("=" * 60)
        print(f"Document ID : {result_dict['document_id']}")
        print(f"Filename    : {result_dict['filename']}")
        print(f"File Type   : {result_dict['file_type']}")
        print(f"Status      : {result_dict['status']}")
        print(f"Total Chunks: {result_dict['total_chunks']}")
        if result_dict.get("error_message"):
            print(f"Notice/Error: {result_dict['error_message']}")

        if result_dict["chunks"]:
            print("-" * 60)
            print(f"Sample Chunk 1 of {result_dict['total_chunks']}:")
            sample = result_dict["chunks"][0]
            print(f"  Chunk ID   : {sample['chunk_id']}")
            print(f"  Page       : {sample['page']}")
            print(f"  Word Count : {sample['word_count']}")
            print(f"  Preview    : {sample['text'][:200]}...")
        print("=" * 60)


if __name__ == "__main__":
    main()
