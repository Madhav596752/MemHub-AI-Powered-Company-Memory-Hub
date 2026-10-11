"""End-to-end pipeline integration tests."""

from ai.document_processor.pipeline import process_document, DocumentProcessingPipeline


def test_process_markdown(sample_dataset):
    result = process_document(sample_dataset["md"], document_id="custom_md_1")
    assert result["document_id"] == "custom_md_1"
    assert result["filename"] == "auth_guide.md"
    assert result["file_type"] == "MD"
    assert result["status"] == "completed"
    assert result["total_chunks"] >= 1
    assert len(result["chunks"]) == result["total_chunks"]

    chunk = result["chunks"][0]
    assert chunk["chunk_id"] == "custom_md_1_chunk_001"
    assert "text" in chunk
    assert chunk["chunk_index"] == 0
    assert "metadata" in chunk


def test_process_csv(sample_dataset):
    result = process_document(sample_dataset["csv"])
    assert result["file_type"] == "CSV"
    assert result["status"] == "completed"
    assert result["total_chunks"] >= 1
    assert "Record 1:" in result["chunks"][0]["text"]


def test_process_docx(sample_dataset):
    result = process_document(sample_dataset["docx"])
    assert result["file_type"] == "DOCX"
    assert result["status"] == "completed"
    assert result["total_chunks"] >= 1
    assert "Onboarding Handbook" in result["chunks"][0]["text"]


def test_process_pdf(sample_dataset):
    result = process_document(sample_dataset["pdf"])
    assert result["file_type"] == "PDF"
    assert result["status"] == "completed"
    assert result["total_chunks"] >= 1
    # Check page attribute preservation
    assert result["chunks"][0]["page"] in (1, 2)


def test_status_scanned_pdf(sample_dataset):
    result = process_document(sample_dataset["scanned_pdf"])
    assert result["status"] == "scanned_pdf"
    assert result["total_chunks"] == 0
    assert result["chunks"] == []
    assert "scanned" in result["error_message"].lower()


def test_status_empty_file(sample_dataset):
    result = process_document(sample_dataset["empty"])
    assert result["status"] == "empty"
    assert result["total_chunks"] == 0
    assert result["chunks"] == []


def test_status_unsupported_file(sample_dataset):
    result = process_document(sample_dataset["unsupported"])
    assert result["status"] == "unsupported"
    assert result["total_chunks"] == 0
    assert result["chunks"] == []


def test_status_corrupted_file(sample_dataset):
    result = process_document(sample_dataset["corrupted"])
    assert result["status"] == "failed"
    assert result["total_chunks"] == 0
    assert result["chunks"] == []
