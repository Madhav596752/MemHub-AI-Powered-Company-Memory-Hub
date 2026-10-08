"""Sentence and paragraph aware text chunker for transformer embeddings.

Produces overlapping chunks respecting grammatical boundaries, preserving
page attribution and rich metadata.
"""

import re
from typing import List, Optional, Tuple
from ai.document_processor.schemas import DocumentChunk, ExtractedDocument, ExtractedSection
from ai.document_processor.cleaner import clean_text


class TextChunker:
    """Configurable sentence-aware chunker with sliding overlap."""

    # Sentence boundary regex preserving abbreviations like e.g., i.e., vs. reasonably
    _SENTENCE_BOUNDARY_REGEX = re.compile(
        r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])",
        re.MULTILINE
    )

    def __init__(
        self,
        chunk_size: int = 500,
        chunk_overlap: int = 75,
        min_chunk_size: int = 15,
    ):
        """
        Args:
            chunk_size: Target maximum words per chunk (default 500).
            chunk_overlap: Target overlap in words between consecutive chunks (default 75).
            min_chunk_size: Minimum words threshold below which tiny trailing fragments
                           are merged into the preceding chunk.
        """
        if chunk_size <= 0:
            raise ValueError("chunk_size must be positive.")
        if chunk_overlap < 0:
            raise ValueError("chunk_overlap cannot be negative.")
        if chunk_overlap >= chunk_size:
            raise ValueError("chunk_overlap must be strictly less than chunk_size.")

        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        self.min_chunk_size = min_chunk_size

    def _split_into_sentences(self, text: str) -> List[str]:
        """Splits text into paragraphs, then into sentence units."""
        paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
        units = []
        for p in paragraphs:
            # Check for markdown headers or single line records (e.g. CSV records, bullets)
            lines = p.split("\n")
            for line in lines:
                stripped = line.strip()
                if not stripped:
                    continue
                # If line is header or list item, treat as atomic unit
                if stripped.startswith(("#", "-", "*", "1.", "Record ", "Table ")):
                    units.append(stripped)
                    continue

                # Otherwise split into sentences
                sentences = self._SENTENCE_BOUNDARY_REGEX.split(stripped)
                for s in sentences:
                    s_clean = s.strip()
                    if s_clean:
                        units.append(s_clean)
        return units

    def _word_count(self, text: str) -> int:
        return len(text.split())

    def _slice_overlap_units(self, units: List[str]) -> List[str]:
        """Picks trailing units from a chunk to form the overlap for the next chunk."""
        if not units or self.chunk_overlap == 0:
            return []

        overlap_units = []
        accumulated_words = 0

        # Traverse backwards
        for u in reversed(units):
            w = self._word_count(u)
            if accumulated_words + w <= self.chunk_overlap:
                overlap_units.insert(0, u)
                accumulated_words += w
            elif not overlap_units:
                # If the single last unit is longer than chunk_overlap, take its last chunk_overlap words
                words = u.split()
                if len(words) > self.chunk_overlap:
                    sliced = " ".join(words[-self.chunk_overlap:])
                    overlap_units.append(sliced)
                else:
                    overlap_units.append(u)
                break
            else:
                break

        return overlap_units

    def chunk_document(
        self,
        extracted_doc: ExtractedDocument,
        document_id: str,
    ) -> List[DocumentChunk]:
        """Splits an ExtractedDocument into structured DocumentChunks.

        Args:
            extracted_doc: ExtractedDocument containing sections and metadata.
            document_id: Unique identifier for the document.

        Returns:
            List of DocumentChunk instances.
        """
        raw_chunks: List[Tuple[str, Optional[int], dict]] = []

        # We process section by section to preserve page numbers accurately
        # If document has multiple pages (e.g. PDF), we can either chunk per page or continuous
        for section in extracted_doc.sections:
            sec_text = clean_text(section.text)
            if not sec_text:
                continue

            units = self._split_into_sentences(sec_text)
            if not units:
                continue

            current_units: List[str] = []
            current_word_count = 0

            for unit in units:
                unit_words = self._word_count(unit)

                # If a single unit exceeds chunk_size, split it into word-slices
                if unit_words > self.chunk_size:
                    # Flush any current accumulation first
                    if current_units:
                        chunk_txt = "\n".join(current_units)
                        raw_chunks.append((chunk_txt, section.page, {"page": section.page}))
                        current_units = self._slice_overlap_units(current_units)
                        current_word_count = sum(self._word_count(u) for u in current_units)

                    words = unit.split()
                    step = self.chunk_size - self.chunk_overlap
                    for i in range(0, len(words), step):
                        sub_slice = words[i : i + self.chunk_size]
                        if not sub_slice:
                            continue
                        sub_text = " ".join(sub_slice)
                        raw_chunks.append((sub_text, section.page, {"page": section.page, "split_oversized": True}))
                    continue

                if current_word_count + unit_words <= self.chunk_size:
                    current_units.append(unit)
                    current_word_count += unit_words
                else:
                    # Current chunk is full
                    chunk_txt = "\n".join(current_units)
                    raw_chunks.append((chunk_txt, section.page, {"page": section.page}))

                    # Form overlap
                    overlap_units = self._slice_overlap_units(current_units)
                    current_units = list(overlap_units)
                    current_units.append(unit)
                    current_word_count = sum(self._word_count(u) for u in current_units)

            # Flush remainder of section
            if current_units:
                chunk_txt = "\n".join(current_units)
                # If trailing remainder is tiny and we have a previous chunk in this section, merge
                if (
                    raw_chunks
                    and self._word_count(chunk_txt) < self.min_chunk_size
                    and raw_chunks[-1][1] == section.page
                ):
                    prev_txt, prev_page, prev_meta = raw_chunks.pop()
                    merged_txt = prev_txt + "\n\n" + chunk_txt
                    raw_chunks.append((merged_txt, prev_page, prev_meta))
                else:
                    raw_chunks.append((chunk_txt, section.page, {"page": section.page}))

        # Build final DocumentChunk objects
        document_chunks: List[DocumentChunk] = []
        for idx, (txt, page, meta) in enumerate(raw_chunks):
            chunk_num = idx + 1
            chunk_id = f"{document_id}_chunk_{chunk_num:03d}"
            w_count = self._word_count(txt)
            c_count = len(txt)

            chunk_meta = {
                "source_filename": extracted_doc.filename,
                "file_type": extracted_doc.file_type,
                "chunk_size_config": self.chunk_size,
                "overlap_config": self.chunk_overlap,
                **meta,
            }

            document_chunks.append(
                DocumentChunk(
                    chunk_id=chunk_id,
                    document_id=document_id,
                    text=txt,
                    source_filename=extracted_doc.filename,
                    file_type=extracted_doc.file_type,
                    page=page,
                    chunk_index=idx,
                    word_count=w_count,
                    char_count=c_count,
                    metadata=chunk_meta,
                )
            )

        return document_chunks
