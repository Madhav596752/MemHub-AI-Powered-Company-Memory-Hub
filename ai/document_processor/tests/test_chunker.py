"""Unit tests for sentence-aware chunker and overlap logic."""

from ai.document_processor.chunker import TextChunker
from ai.document_processor.schemas import ExtractedDocument, ExtractedSection


def test_chunker_basic_and_metadata():
    chunker = TextChunker(chunk_size=50, chunk_overlap=10)
    section = ExtractedSection(
        text="First sentence here. Second sentence follows. Third sentence wraps up this block.",
        page=1,
    )
    doc = ExtractedDocument(
        filename="test.txt",
        file_type="TXT",
        sections=[section],
    )
    chunks = chunker.chunk_document(doc, document_id="doc_100")

    assert len(chunks) >= 1
    c1 = chunks[0]
    assert c1.document_id == "doc_100"
    assert c1.chunk_id == "doc_100_chunk_001"
    assert c1.source_filename == "test.txt"
    assert c1.file_type == "TXT"
    assert c1.page == 1
    assert c1.chunk_index == 0
    assert c1.word_count > 0
    assert c1.char_count > 0
    assert "First sentence here." in c1.text


def test_chunk_overlap():
    # Create long text of 12 distinct sentences each 10 words
    sentences = [
        f"Sentence number {i} provides exactly ten words in this particular test sequence."
        for i in range(1, 15)
    ]
    full_text = " ".join(sentences)
    chunker = TextChunker(chunk_size=40, chunk_overlap=15)
    section = ExtractedSection(text=full_text, page=2)
    doc = ExtractedDocument(filename="overlap.txt", file_type="TXT", sections=[section])

    chunks = chunker.chunk_document(doc, document_id="doc_overlap")
    assert len(chunks) > 1

    # Check overlap between chunk 0 and chunk 1
    # Sentences at the end of chunk 0 should appear at the start of chunk 1
    words_chunk0 = set(chunks[0].text.split())
    words_chunk1 = set(chunks[1].text.split())
    common_words = words_chunk0.intersection(words_chunk1)
    assert len(common_words) > 5, "Consecutive chunks must have overlapping content"


def test_sentence_boundary_preservation():
    chunker = TextChunker(chunk_size=20, chunk_overlap=5)
    text = (
        "Alpha beta gamma delta epsilon. "
        "Zeta eta theta iota kappa lambda. "
        "Mu nu xi omicron pi rho sigma tau."
    )
    section = ExtractedSection(text=text, page=None)
    doc = ExtractedDocument(filename="bounds.txt", file_type="TXT", sections=[section])
    chunks = chunker.chunk_document(doc, document_id="doc_bounds")

    for c in chunks:
        # Every chunk should not end with an orphaned middle-of-sentence piece
        assert not c.text.endswith("beta")
        assert not c.text.endswith("eta")
