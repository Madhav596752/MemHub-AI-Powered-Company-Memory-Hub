"""Custom exceptions for the MemHub Document Processing Pipeline."""


class DocumentProcessorError(Exception):
    """Base exception for all document processing errors."""
    def __init__(self, message: str, status: str = "failed", details: dict = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.details = details or {}


class UnsupportedFileTypeError(DocumentProcessorError):
    """Raised when the provided file extension or format is unsupported."""
    def __init__(self, message: str, details: dict = None):
        super().__init__(message, status="unsupported", details=details)


class EmptyDocumentError(DocumentProcessorError):
    """Raised when a document contains no extractable content or is 0 bytes."""
    def __init__(self, message: str, details: dict = None):
        super().__init__(message, status="empty", details=details)


class ScannedPDFError(DocumentProcessorError):
    """Raised when a PDF contains little to no extractable text (e.g. image/scanned pages)."""
    def __init__(self, message: str, details: dict = None):
        super().__init__(message, status="scanned_pdf", details=details)


class CorruptedFileError(DocumentProcessorError):
    """Raised when a document cannot be read or parsed due to corruption."""
    def __init__(self, message: str, details: dict = None):
        super().__init__(message, status="failed", details=details)


class ExtractionError(DocumentProcessorError):
    """Raised when a failure occurs during file extraction."""
    def __init__(self, message: str, details: dict = None):
        super().__init__(message, status="failed", details=details)


class ChunkingError(DocumentProcessorError):
    """Raised when an error occurs during text chunking."""
    def __init__(self, message: str, details: dict = None):
        super().__init__(message, status="failed", details=details)
