"""MemHub Document Processing Pipeline Package.

Provides high-performance, conservative document extraction, cleaning,
and chunking for organizational documents.
"""

from ai.document_processor.schemas import (
    DocumentChunk,
    DocumentProcessingResult,
    ExtractedDocument,
    ExtractedSection,
    ProcessingStatus,
)
from ai.document_processor.cleaner import TextCleaner, clean_text
from ai.document_processor.chunker import TextChunker
from ai.document_processor.extractor import (
    DocumentExtractor,
    PDFExtractor,
    DOCXExtractor,
    TextExtractor,
    CSVExtractor,
)
from ai.document_processor.exceptions import (
    DocumentProcessorError,
    UnsupportedFileTypeError,
    EmptyDocumentError,
    ScannedPDFError,
    CorruptedFileError,
    ExtractionError,
    ChunkingError,
)

# Lazy accessor functions to prevent circular runpy imports during CLI invocation
def process_document(*args, **kwargs):
    from ai.document_processor.pipeline import process_document as _process_document
    return _process_document(*args, **kwargs)


def DocumentProcessingPipeline(*args, **kwargs):
    from ai.document_processor.pipeline import DocumentProcessingPipeline as _Pipeline
    return _Pipeline(*args, **kwargs)


__all__ = [
    "DocumentProcessingPipeline",
    "process_document",
    "DocumentChunk",
    "DocumentProcessingResult",
    "ExtractedDocument",
    "ExtractedSection",
    "ProcessingStatus",
    "TextCleaner",
    "clean_text",
    "TextChunker",
    "DocumentExtractor",
    "PDFExtractor",
    "DOCXExtractor",
    "TextExtractor",
    "CSVExtractor",
    "DocumentProcessorError",
    "UnsupportedFileTypeError",
    "EmptyDocumentError",
    "ScannedPDFError",
    "CorruptedFileError",
    "ExtractionError",
    "ChunkingError",
]
