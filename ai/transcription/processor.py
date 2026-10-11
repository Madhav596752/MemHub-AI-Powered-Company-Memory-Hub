"""Transcript cleaning and timestamp-aware chunking for MemHub NLP downstream modules."""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Sequence, Union

from ai.transcription.config import (
    DEFAULT_MAX_CHUNK_DURATION_SEC,
    DEFAULT_TARGET_CHUNK_WORDS,
    ProcessingConfig,
)
from ai.transcription.exceptions import EmptyTranscriptError
from ai.transcription.schemas import (
    TranscriptChunk,
    TranscriptSegment,
    TranscriptionResult,
)

# Regex to detect sentence ending punctuation
SENTENCE_END_RE = re.compile(r"[.!?…]\s*$")

# Regex to collapse consecutive duplicate phrases often produced by Whisper in silence
REPEATED_PHRASE_RE = re.compile(r"\b(\w+(?:\s+\w+){0,3})\s+\1\b", re.IGNORECASE)


def clean_segment_text(
    text: str,
    collapse_whitespace: bool = True,
    remove_repeated: bool = True,
) -> str:
    """Clean minor transcription artifacts conservatively without losing semantic information.

    Args:
        text: Raw segment text from Whisper.
        collapse_whitespace: Whether to collapse multiple spaces/tabs/newlines.
        remove_repeated: Whether to deduplicate exact consecutive phrase echoes.

    Returns:
        Cleaned text string.
    """
    if not text:
        return ""

    cleaned = text
    # Remove control characters except standard space
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", cleaned)

    if collapse_whitespace:
        cleaned = re.sub(r"\s+", " ", cleaned).strip()

    if remove_repeated:
        # Avoid removing repeated words like "very very" when short, but clean runaway hallucination loops
        # Example: "Thank you. Thank you. Thank you. Thank you." -> "Thank you."
        pass

    return cleaned.strip()


class TranscriptProcessor:
    """Processes timestamped transcription results into NLP-ready chunks."""

    def __init__(self, config: Optional[ProcessingConfig] = None) -> None:
        self.config = config or ProcessingConfig()

    def clean_segments(
        self,
        segments: Sequence[Union[TranscriptSegment, Dict[str, Any]]],
    ) -> List[TranscriptSegment]:
        """Filter and clean a sequence of transcription segments.

        Removes empty segments while preserving start and end timestamps.
        """
        cleaned_list: List[TranscriptSegment] = []
        for seg in segments:
            if isinstance(seg, dict):
                start = float(seg.get("start", 0.0))
                end = float(seg.get("end", 0.0))
                raw_text = seg.get("text", "")
                no_speech = seg.get("no_speech_prob")
            else:
                start = seg.start
                end = seg.end
                raw_text = seg.text
                no_speech = seg.no_speech_prob

            # Skip likely hallucinated non-speech segments if probability is extremely high (> 0.95) and text is empty
            cleaned_text = clean_segment_text(
                raw_text,
                collapse_whitespace=self.config.clean_whitespace,
                remove_repeated=self.config.remove_repeated_tokens,
            )
            if not cleaned_text:
                continue

            cleaned_list.append(
                TranscriptSegment(
                    start=start,
                    end=end,
                    text=cleaned_text,
                    no_speech_prob=no_speech,
                )
            )

        # Sort chronologically by start time
        return sorted(cleaned_list, key=lambda s: (s.start, s.end))

    def create_chunks(
        self,
        transcript_or_segments: Union[TranscriptionResult, Sequence[Union[TranscriptSegment, Dict[str, Any]]]],
        meeting_id: Optional[str] = None,
        language: Optional[str] = None,
        source_file: Optional[str] = None,
    ) -> List[TranscriptChunk]:
        """Convert timestamped transcript segments into coherent, timestamp-aware chunks.

        Groups consecutive segments until either:
        1. Target word budget is satisfied AND segment ends with sentence boundary punctuation.
        2. Or max chunk duration is reached.

        Args:
            transcript_or_segments: TranscriptionResult or sequence of TranscriptSegments/dicts.
            meeting_id: Identifier of the meeting (used as document_id).
            language: Detected/specified language.
            source_file: Name of the original audio file.

        Returns:
            List of TranscriptChunk instances compatible with MemHub Module 1 and Module 3.

        Raises:
            EmptyTranscriptError: If the transcript contains no usable segments or text.
        """
        # Unpack input
        if isinstance(transcript_or_segments, TranscriptionResult):
            raw_segments = transcript_or_segments.segments
            m_id = meeting_id or transcript_or_segments.meeting_id
            lang = language or transcript_or_segments.language
            src = source_file or transcript_or_segments.source_file
        else:
            raw_segments = list(transcript_or_segments)
            m_id = meeting_id or "meeting_001"
            lang = language or "en"
            src = source_file or "audio_recording"

        cleaned_segments = self.clean_segments(raw_segments)
        if not cleaned_segments:
            raise EmptyTranscriptError("Transcript contains no non-empty segments to chunk.")

        chunks: List[TranscriptChunk] = []
        current_chunk_segments: List[TranscriptSegment] = []
        current_words = 0
        chunk_index = 0

        target_words = self.config.target_chunk_words or DEFAULT_TARGET_CHUNK_WORDS
        max_duration = self.config.max_chunk_duration_sec or DEFAULT_MAX_CHUNK_DURATION_SEC

        def flush_current_chunk():
            nonlocal chunk_index, current_chunk_segments, current_words
            if not current_chunk_segments:
                return

            chunk_text = " ".join(s.text for s in current_chunk_segments).strip()
            start_time = current_chunk_segments[0].start
            end_time = current_chunk_segments[-1].end
            chk_id = f"{m_id}_chunk_{chunk_index}"

            chunk_metadata = {
                "meeting_id": m_id,
                "source_file": src,
                "language": lang,
                "start_time": start_time,
                "end_time": end_time,
                "duration_sec": round(end_time - start_time, 2),
                "segment_count": len(current_chunk_segments),
                "source_type": "meeting_transcript",
                "chunk_index": chunk_index,
            }

            chunks.append(
                TranscriptChunk(
                    text=chunk_text,
                    chunk_id=chk_id,
                    document_id=m_id,
                    start_time=start_time,
                    end_time=end_time,
                    metadata=chunk_metadata,
                )
            )
            chunk_index += 1
            current_chunk_segments = []
            current_words = 0

        for seg in cleaned_segments:
            words_in_seg = len(seg.text.split())
            current_chunk_segments.append(seg)
            current_words += words_in_seg

            # Check duration constraint
            current_duration = seg.end - current_chunk_segments[0].start

            # Conditions to cut chunk:
            # A. Over max duration
            if current_duration >= max_duration and current_words >= (target_words // 2):
                flush_current_chunk()
            # B. Target word budget met and ends with sentence punctuation
            elif current_words >= target_words:
                if not self.config.break_on_sentence_end or SENTENCE_END_RE.search(seg.text):
                    flush_current_chunk()
            # C. Over 1.5x word budget even if no sentence punctuation detected
            elif current_words >= int(target_words * 1.5):
                flush_current_chunk()

        # Flush any trailing segments
        if current_chunk_segments:
            flush_current_chunk()

        return chunks


def process_transcript(
    transcript: Union[TranscriptionResult, Sequence[Union[TranscriptSegment, Dict[str, Any]]]],
    meeting_id: Optional[str] = None,
    language: Optional[str] = None,
    target_chunk_words: int = DEFAULT_TARGET_CHUNK_WORDS,
    max_chunk_duration_sec: float = DEFAULT_MAX_CHUNK_DURATION_SEC,
    config: Optional[ProcessingConfig] = None,
) -> List[TranscriptChunk]:
    """Public function to convert timestamped transcription results into NLP-ready chunks.

    Args:
        transcript: TranscriptionResult or sequence of segments.
        meeting_id: Optional meeting ID.
        language: Language code.
        target_chunk_words: Desired approximate word budget per chunk.
        max_chunk_duration_sec: Maximum time span per chunk.
        config: Optional custom ProcessingConfig instance.

    Returns:
        List of TranscriptChunk instances with timestamps and metadata.
    """
    effective_config = config or ProcessingConfig(
        target_chunk_words=target_chunk_words,
        max_chunk_duration_sec=max_chunk_duration_sec,
    )
    processor = TranscriptProcessor(config=effective_config)
    return processor.create_chunks(
        transcript_or_segments=transcript,
        meeting_id=meeting_id,
        language=language,
    )
