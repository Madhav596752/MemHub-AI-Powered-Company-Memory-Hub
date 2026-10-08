"""Data schemas and transfer models for document processing pipeline."""

from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import List, Optional, Dict, Any


class ProcessingStatus(str, Enum):
    """Lifecycle and result states for document processing."""
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    UNSUPPORTED = "unsupported"
    EMPTY = "empty"
    SCANNED_PDF = "scanned_pdf"


@dataclass
class ExtractedSection:
    """Represents a piece of text extracted from a specific document page or structural block."""
    text: str
    page: Optional[int] = None
    section_title: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ExtractedDocument:
    """Intermediate representation of an extracted document prior to chunking."""
    filename: str
    file_type: str
    sections: List[ExtractedSection] = field(default_factory=list)
    total_pages: Optional[int] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def full_text(self) -> str:
        return "\n\n".join(sec.text for sec in self.sections if sec.text.strip())


@dataclass
class DocumentChunk:
    """A clean, structured NLP-ready chunk of document content ready for embeddings."""
    chunk_id: str
    document_id: str
    text: str
    source_filename: str
    file_type: str
    page: Optional[int] = None
    chunk_index: int = 0
    word_count: int = 0
    char_count: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert chunk to JSON-serializable dictionary."""
        return {
            "chunk_id": self.chunk_id,
            "document_id": self.document_id,
            "text": self.text,
            "source_filename": self.source_filename,
            "file_type": self.file_type,
            "page": self.page,
            "chunk_index": self.chunk_index,
            "word_count": self.word_count,
            "char_count": self.char_count,
            "metadata": self.metadata,
        }


@dataclass
class DocumentProcessingResult:
    """Top-level pipeline output model representing a processed document."""
    document_id: str
    filename: str
    file_type: str
    status: str
    total_chunks: int = 0
    chunks: List[DocumentChunk] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    error_message: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert result to clean dictionary representation conforming to MemHub spec."""
        return {
            "document_id": self.document_id,
            "filename": self.filename,
            "file_type": self.file_type,
            "status": self.status,
            "total_chunks": self.total_chunks,
            "chunks": [c.to_dict() for c in self.chunks],
            "metadata": self.metadata,
            "error_message": self.error_message,
        }
