"""Validated data structures for audio transcripts, segments, and NLP-ready chunks."""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from typing import Any, Dict, List, Mapping, Optional, Sequence

from ai.transcription.exceptions import InvalidTimestampError


@dataclass
class TranscriptSegment:
    """A timestamped segment within an audio transcript.

    Attributes:
        start: Starting timestamp in seconds.
        end: Ending timestamp in seconds.
        text: Transcribed text for this segment.
        id: Optional segment index/identifier.
        avg_logprob: Optional average token log probability from Whisper.
        no_speech_prob: Optional probability that segment contains no speech.
    """

    start: float
    end: float
    text: str
    id: Optional[int] = None
    avg_logprob: Optional[float] = None
    no_speech_prob: Optional[float] = None

    def __post_init__(self) -> None:
        try:
            self.start = float(self.start)
            self.end = float(self.end)
        except (ValueError, TypeError) as exc:
            raise InvalidTimestampError(
                f"Segment timestamps must be numeric floats: start={self.start!r}, end={self.end!r}"
            ) from exc

        if self.start < 0.0 or self.end < 0.0:
            raise InvalidTimestampError(
                f"Segment timestamps cannot be negative: start={self.start}, end={self.end}"
            )

        if self.end < self.start:
            raise InvalidTimestampError(
                f"Segment end timestamp ({self.end}s) cannot be before start timestamp ({self.start}s)."
            )

        self.text = str(self.text or "")

    @property
    def duration(self) -> float:
        """Duration of the segment in seconds."""
        return self.end - self.start

    def to_dict(self) -> Dict[str, Any]:
        """Serialize segment to a dictionary."""
        d: Dict[str, Any] = {
            "start": round(self.start, 2),
            "end": round(self.end, 2),
            "text": self.text,
        }
        if self.id is not None:
            d["id"] = self.id
        if self.avg_logprob is not None:
            d["avg_logprob"] = self.avg_logprob
        if self.no_speech_prob is not None:
            d["no_speech_prob"] = self.no_speech_prob
        return d

    def __getitem__(self, key: str) -> Any:
        return self.to_dict()[key]


@dataclass
class TranscriptionResult:
    """Complete structured transcription result for an audio file.

    Attributes:
        meeting_id: Unique meeting identifier.
        source_file: Original filename or path of the audio recording.
        language: Detected or specified language (e.g., 'en').
        transcript: Full unbroken transcript text.
        segments: Ordered list of timestamped segments.
        duration: Total audio duration in seconds.
        metadata: Optional dictionary for caller metadata.
    """

    meeting_id: str
    source_file: str
    transcript: str
    language: Optional[str] = "en"
    segments: List[TranscriptSegment] = field(default_factory=list)
    duration: Optional[float] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.meeting_id = str(self.meeting_id or "meeting_001")
        self.source_file = str(self.source_file or "")
        self.transcript = str(self.transcript or "")
        if self.language is not None:
            self.language = str(self.language).lower().strip()

        # Validate segment ordering and convert raw dicts if necessary
        validated_segments: List[TranscriptSegment] = []
        last_start = -1.0
        for seg in self.segments:
            if isinstance(seg, TranscriptSegment):
                validated_segments.append(seg)
                current_start = seg.start
            elif isinstance(seg, Mapping):
                s = TranscriptSegment(
                    start=seg.get("start", 0.0),
                    end=seg.get("end", 0.0),
                    text=seg.get("text", ""),
                    id=seg.get("id"),
                    avg_logprob=seg.get("avg_logprob"),
                    no_speech_prob=seg.get("no_speech_prob"),
                )
                validated_segments.append(s)
                current_start = s.start
            else:
                raise TypeError(f"Expected TranscriptSegment or dict, got {type(seg).__name__}")

            if current_start < last_start:
                # Segments should be chronologically ordered
                pass  # We sort them below to ensure stable ordering
            last_start = current_start

        self.segments = sorted(validated_segments, key=lambda s: (s.start, s.end))

        if self.duration is None:
            if self.segments:
                self.duration = round(max(s.end for s in self.segments), 2)
            else:
                self.duration = 0.0

    def to_dict(self) -> Dict[str, Any]:
        """Return the dictionary representation matching Module 4 specifications."""
        return {
            "meeting_id": self.meeting_id,
            "source_file": self.source_file,
            "language": self.language,
            "transcript": self.transcript,
            "segments": [s.to_dict() for s in self.segments],
        }

    def to_json(self, indent: int = 2) -> str:
        """Serialize result to a formatted JSON string."""
        return json.dumps(self.to_dict(), indent=indent)

    def __getitem__(self, key: str) -> Any:
        return self.to_dict()[key]


@dataclass
class TranscriptChunk:
    """An NLP-ready chunk synthesized from consecutive timestamped segments.

    Designed for compatibility with MemHub Module 1 (chunk structure) and
    Module 3 (downstream Knowledge Graph entity/relation extraction).

    Attributes:
        text: Consolidated text for this chunk.
        chunk_id: Identifier of the chunk (e.g. 'meeting_001_chunk_0').
        document_id: Identifier of the parent meeting (e.g. 'meeting_001').
        start_time: Starting timestamp in seconds.
        end_time: Ending timestamp in seconds.
        metadata: Meeting, language, segment count, and timestamp metadata.
    """

    text: str
    chunk_id: str
    document_id: str
    start_time: float
    end_time: float
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.text = str(self.text or "").strip()
        self.chunk_id = str(self.chunk_id)
        self.document_id = str(self.document_id)
        self.start_time = round(float(self.start_time), 2)
        self.end_time = round(float(self.end_time), 2)

        if self.end_time < self.start_time:
            raise InvalidTimestampError(
                f"Chunk end_time ({self.end_time}) cannot be earlier than start_time ({self.start_time})"
            )

        # Ensure core metadata keys are set
        self.metadata.setdefault("start_time", self.start_time)
        self.metadata.setdefault("end_time", self.end_time)
        self.metadata.setdefault("duration_sec", round(self.end_time - self.start_time, 2))
        self.metadata.setdefault("source_type", "meeting_transcript")

    def to_dict(self) -> Dict[str, Any]:
        """Convert chunk into a dict compatible with Module 1 and Module 3."""
        return {
            "text": self.text,
            "chunk_id": self.chunk_id,
            "document_id": self.document_id,
            "metadata": dict(self.metadata),
        }

    def __getitem__(self, key: str) -> Any:
        return self.to_dict()[key]
