"""Unit tests for document extractors."""

import pytest
from ai.document_processor.extractor import (
    DocumentExtractor,
    PDFExtractor,
    DOCXExtractor,
    TextExtractor,
    CSVExtractor,
)
from ai.document_processor.exceptions import (
    UnsupportedFileTypeError,
    EmptyDocumentError,
    ScannedPDFError,
    CorruptedFileError,
)


def test_txt_extractor(sample_dataset):
    extractor = DocumentExtractor()
    doc = extractor.extract(sample_dataset["txt"])
    assert doc.file_type == "TXT"
    assert len(doc.sections) == 1
    assert "MemHub System Architecture Overview" in doc.sections[0].text
    assert "https://internal.memhub.io" in doc.sections[0].text
    assert "MAX_HEAP_SIZE=4096MB" in doc.sections[0].text


def test_md_extractor(sample_dataset):
    extractor = DocumentExtractor()
    doc = extractor.extract(sample_dataset["md"])
    assert doc.file_type == "MD"
    assert "# Authentication & Authorization Guide" in doc.sections[0].text
    assert "## Endpoints" in doc.sections[0].text
    assert "- POST /api/auth/token:" in doc.sections[0].text


def test_csv_extractor(sample_dataset):
    extractor = DocumentExtractor()
    doc = extractor.extract(sample_dataset["csv"])
    assert doc.file_type == "CSV"
    assert len(doc.sections) == 1
    content = doc.sections[0].text
    # Preserves column names and semantic format
    assert "Record 1:" in content
    assert "[EmployeeID]: E101" in content
    assert "[Name]: Alice Vance" in content
    assert "[Role]: Staff Engineer" in content


def test_docx_extractor(sample_dataset):
    extractor = DocumentExtractor()
    doc = extractor.extract(sample_dataset["docx"])
    assert doc.file_type == "DOCX"
    content = doc.sections[0].text
    # Heading preservation
    assert "# Acme Engineering Onboarding Handbook" in content
    assert "## Development Environment" in content
    # Table content extracted
    assert "Vector Store" in content
    assert "6333" in content


def test_pdf_extractor_multipage(sample_dataset):
    extractor = DocumentExtractor()
    doc = extractor.extract(sample_dataset["pdf"])
    assert doc.file_type == "PDF"
    assert doc.total_pages == 2
    assert len(doc.sections) == 2
    assert doc.sections[0].page == 1
    assert "Annual Report 2026" in doc.sections[0].text
    assert doc.sections[1].page == 2
    assert "Chapter 1" in doc.sections[1].text


def test_scanned_pdf_detection(sample_dataset):
    extractor = DocumentExtractor()
    with pytest.raises(ScannedPDFError) as exc_info:
        extractor.extract(sample_dataset["scanned_pdf"])
    assert "scanned document or image-only" in str(exc_info.value)
    assert exc_info.value.status == "scanned_pdf"


def test_empty_file_error(sample_dataset):
    extractor = DocumentExtractor()
    with pytest.raises(EmptyDocumentError) as exc_info:
        extractor.extract(sample_dataset["empty"])
    assert exc_info.value.status == "empty"


def test_unsupported_file_error(sample_dataset):
    extractor = DocumentExtractor()
    with pytest.raises(UnsupportedFileTypeError) as exc_info:
        extractor.extract(sample_dataset["unsupported"])
    assert exc_info.value.status == "unsupported"


def test_corrupted_file_error(sample_dataset):
    extractor = DocumentExtractor()
    with pytest.raises(CorruptedFileError):
        extractor.extract(sample_dataset["corrupted"])
