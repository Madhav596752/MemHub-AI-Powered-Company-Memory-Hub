"""Unit tests for Module 4 (ai/transcription).

All tests are completely mock-based and run locally without requiring model
weights downloads, GPU acceleration, or audio hardware.
"""

from __future__ import annotations

import json
import os
import tempfile
from unittest.mock import MagicMock, patch

import pytest

from ai.transcription.config import (
    DEFAULT_MODEL_NAME,
    SUPPORTED_AUDIO_EXTENSIONS,
    ProcessingConfig,
    TranscriptionConfig,
    resolve_device,
    validate_file_extension,
)
from ai.transcription.exceptions import (
    AudioFileNotFoundError,
    DependencyMissingError,
    EmptyAudioFileError,
    EmptyTranscriptError,
    FFmpegNotFoundError,
    InvalidTimestampError,
    ModelLoadError,
    TranscriptionExecutionError,
    UnsupportedAudioFormatError,
)
from ai.transcription.processor import (
    TranscriptProcessor,
    clean_segment_text,
    process_transcript,
)
from ai.transcription.schemas import (
    TranscriptChunk,
    TranscriptSegment,
    TranscriptionResult,
)
from ai.transcription.transcribe import build_parser, main
from ai.transcription.transcriber import (
    AudioTranscriber,
    check_ffmpeg_available,
    check_whisper_dependencies,
    transcribe_audio,
)


# -----------------------------------------------------------------------------
# 1. Schema Validation Tests
# -----------------------------------------------------------------------------


def test_transcript_segment_validation() -> None:
    """Valid segment properly initializes start, end, duration and text."""
    seg = TranscriptSegment(start=12.4, end=18.7, text="Let's migrate the authentication service.")
    assert seg.start == 12.4
    assert seg.end == 18.7
    assert pytest.approx(seg.duration, 0.01) == 6.3
    assert seg.text == "Let's migrate the authentication service."

    d = seg.to_dict()
    assert d["start"] == 12.4
    assert d["end"] == 18.7
    assert d["text"] == "Let's migrate the authentication service."


def test_transcript_segment_invalid_timestamps() -> None:
    """Negative start/end or end before start must raise InvalidTimestampError."""
    with pytest.raises(InvalidTimestampError):
        TranscriptSegment(start=-1.0, end=5.0, text="Invalid negative start")

    with pytest.raises(InvalidTimestampError):
        TranscriptSegment(start=10.0, end=4.0, text="End before start")

    with pytest.raises(InvalidTimestampError):
        TranscriptSegment(start="not-a-number", end=5.0, text="Bad type")  # type: ignore


def test_transcription_result_schema_and_ordering() -> None:
    """TranscriptionResult ensures segments are chronologically ordered."""
    raw_segments = [
        {"start": 15.0, "end": 20.0, "text": "Second point discussed."},
        {"start": 5.0, "end": 10.0, "text": "First introductory point."},
    ]
    result = TranscriptionResult(
        meeting_id="meeting_001",
        source_file="standup.mp3",
        language="en",
        transcript="First introductory point. Second point discussed.",
        segments=raw_segments,  # type: ignore
    )

    # Verification of segment ordering
    assert len(result.segments) == 2
    assert result.segments[0].start == 5.0
    assert result.segments[1].start == 15.0
    assert result.duration == 20.0

    d = result.to_dict()
    assert d["meeting_id"] == "meeting_001"
    assert d["source_file"] == "standup.mp3"
    assert d["language"] == "en"
    assert len(d["segments"]) == 2
    assert d["segments"][0]["start"] == 5.0


def test_transcript_chunk_schema() -> None:
    """TranscriptChunk validates timestamps and conforms to Module 1 / Module 3 format."""
    chunk = TranscriptChunk(
        text="The team decided to adopt PostgreSQL for Project Atlas.",
        chunk_id="meeting_100_chunk_0",
        document_id="meeting_100",
        start_time=12.5,
        end_time=35.0,
        metadata={"meeting_id": "meeting_100", "source_file": "planning.mp3"},
    )
    assert chunk.document_id == "meeting_100"
    assert chunk.chunk_id == "meeting_100_chunk_0"
    assert chunk.start_time == 12.5
    assert chunk.end_time == 35.0
    assert chunk.metadata["start_time"] == 12.5
    assert chunk.metadata["end_time"] == 35.0
    assert chunk.metadata["duration_sec"] == 22.5

    d = chunk.to_dict()
    assert "text" in d
    assert "chunk_id" in d
    assert "document_id" in d
    assert "metadata" in d


def test_transcript_chunk_invalid_timestamps() -> None:
    """End time before start time raises InvalidTimestampError."""
    with pytest.raises(InvalidTimestampError):
        TranscriptChunk(
            text="Invalid",
            chunk_id="c1",
            document_id="d1",
            start_time=30.0,
            end_time=10.0,
        )


# -----------------------------------------------------------------------------
# 2. Transcript Processing & Chunking Tests
# -----------------------------------------------------------------------------


def test_clean_segment_text() -> None:
    """Whitespace and control characters are cleaned conservatively."""
    raw = "  Hello \t team, \n\n let's start the meeting.  "
    cleaned = clean_segment_text(raw)
    assert cleaned == "Hello team, let's start the meeting."


def test_transcript_to_chunk_conversion() -> None:
    """Consecutive segments are grouped into timestamp-preserved chunks."""
    segments = [
        TranscriptSegment(start=0.0, end=4.5, text="Welcome everyone to the sprint review."),
        TranscriptSegment(start=5.0, end=9.2, text="Priya resolved the authentication issue."),
        TranscriptSegment(start=9.5, end=14.0, text="Project Phoenix is now ready for deployment."),
        TranscriptSegment(start=14.5, end=18.0, text="We also discussed database backup schedules."),
    ]
    result = TranscriptionResult(
        meeting_id="sprint_42",
        source_file="sprint_42.wav",
        language="en",
        transcript=" ".join(s.text for s in segments),
        segments=segments,
    )

    chunks = process_transcript(result, target_chunk_words=15)
    assert len(chunks) >= 1

    # Check timestamps and ordering
    first_chunk = chunks[0]
    assert first_chunk.document_id == "sprint_42"
    assert first_chunk.start_time == 0.0
    assert first_chunk.end_time >= 9.2
    assert "Priya resolved the authentication issue." in first_chunk.text
    assert first_chunk.metadata["source_type"] == "meeting_transcript"
    assert first_chunk.metadata["meeting_id"] == "sprint_42"


def test_empty_transcript_handling() -> None:
    """Empty transcripts or empty segment lists raise EmptyTranscriptError."""
    empty_result = TranscriptionResult(
        meeting_id="empty_meeting",
        source_file="empty.mp3",
        transcript="",
        segments=[],
    )
    with pytest.raises(EmptyTranscriptError):
        process_transcript(empty_result)

    with pytest.raises(EmptyTranscriptError):
        process_transcript([])


# -----------------------------------------------------------------------------
# 3. Audio Validation & Error Handling Tests
# -----------------------------------------------------------------------------


def test_validate_file_extension() -> None:
    """Supported extensions pass; unsupported extensions raise UnsupportedAudioFormatError."""
    assert validate_file_extension("meeting.mp3") == ".mp3"
    assert validate_file_extension("recording.WAV") == ".wav"
    assert validate_file_extension("notes.m4a") == ".m4a"
    assert validate_file_extension("demo.mp4") == ".mp4"

    with pytest.raises(UnsupportedAudioFormatError):
        validate_file_extension("notes.txt")

    with pytest.raises(UnsupportedAudioFormatError):
        validate_file_extension("slides.pdf")

    with pytest.raises(UnsupportedAudioFormatError):
        validate_file_extension("no_extension")


def test_transcribe_audio_missing_file() -> None:
    """Nonexistent audio file raises AudioFileNotFoundError."""
    with pytest.raises(AudioFileNotFoundError):
        transcribe_audio("nonexistent_recording_12345.mp3")


def test_transcribe_audio_empty_file() -> None:
    """Empty (0 bytes) file raises EmptyAudioFileError."""
    with tempfile.NamedTemporaryFile(suffix=".mp3") as tmp:
        # File is 0 bytes
        with pytest.raises(EmptyAudioFileError):
            transcribe_audio(tmp.name)


def test_ffmpeg_not_found_error() -> None:
    """When FFmpeg is absent from PATH, FFmpegNotFoundError is raised."""
    with patch("shutil.which", return_value=None):
        with pytest.raises(FFmpegNotFoundError):
            check_ffmpeg_available()


def test_missing_dependencies_error() -> None:
    """When torch or whisper cannot be imported, DependencyMissingError is raised."""
    with patch.dict("sys.modules", {"whisper": None}):
        # Mocking import failure
        with patch("builtins.__import__", side_effect=ImportError("No module named whisper")):
            with pytest.raises(DependencyMissingError):
                check_whisper_dependencies()


# -----------------------------------------------------------------------------
# 4. Mocked Whisper Model & Transcription Execution Tests
# -----------------------------------------------------------------------------


def test_mocked_transcription_success() -> None:
    """Whisper transcription pipeline executes and structures segments without real model weights."""
    mock_whisper_output = {
        "text": "Priya resolved the authentication issue in Project Phoenix.",
        "language": "en",
        "segments": [
            {
                "id": 0,
                "start": 0.0,
                "end": 3.8,
                "text": "Priya resolved the authentication issue",
                "avg_logprob": -0.15,
                "no_speech_prob": 0.01,
            },
            {
                "id": 1,
                "start": 3.8,
                "end": 6.2,
                "text": "in Project Phoenix.",
                "avg_logprob": -0.10,
                "no_speech_prob": 0.01,
            },
        ],
    }

    mock_model = MagicMock()
    mock_model.transcribe.return_value = mock_whisper_output

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp.write(b"dummy_audio_bytes_header_123456789")
        tmp_path = tmp.name

    try:
        with patch.object(AudioTranscriber, "_load_model", return_value=mock_model), \
             patch("ai.transcription.transcriber.check_ffmpeg_available"):

            res = transcribe_audio(
                file_path=tmp_path,
                model_name="base",
                language="en",
                meeting_id="phoenix_sync",
            )

            assert res.meeting_id == "phoenix_sync"
            assert res.language == "en"
            assert res.transcript == "Priya resolved the authentication issue in Project Phoenix."
            assert len(res.segments) == 2
            assert res.segments[0].start == 0.0
            assert res.segments[0].end == 3.8
            assert res.segments[1].end == 6.2

            # Downstream chunking verification
            chunks = process_transcript(res)
            assert len(chunks) == 1
            assert chunks[0].document_id == "phoenix_sync"
            assert chunks[0].start_time == 0.0
            assert chunks[0].end_time == 6.2
            assert "Project Phoenix" in chunks[0].text
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def test_mocked_transcription_model_load_failure() -> None:
    """Model load errors are wrapped into ModelLoadError."""
    with patch("ai.transcription.transcriber.check_whisper_dependencies"):
        with patch("sys.modules", {"whisper": MagicMock(load_model=MagicMock(side_effect=RuntimeError("Out of memory")))}):
            config = TranscriptionConfig(model_name="large")
            transcriber = AudioTranscriber(config=config)
            with pytest.raises(ModelLoadError):
                _ = transcriber.model


def test_mocked_transcription_execution_failure() -> None:
    """Inference exceptions are wrapped in TranscriptionExecutionError."""
    mock_model = MagicMock()
    mock_model.transcribe.side_effect = RuntimeError("CUDA out of memory during decoding")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(b"dummy_audio_content")
        tmp_path = tmp.name

    try:
        with patch.object(AudioTranscriber, "_load_model", return_value=mock_model), \
             patch("ai.transcription.transcriber.check_ffmpeg_available"):

            with pytest.raises(TranscriptionExecutionError):
                transcribe_audio(tmp_path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


# -----------------------------------------------------------------------------
# 5. CLI Argument and Execution Tests
# -----------------------------------------------------------------------------


def test_cli_parser_defaults() -> None:
    """CLI argument parser sets proper default options."""
    parser = build_parser()
    args = parser.parse_args(["meeting.mp3"])
    assert args.file_path == "meeting.mp3"
    assert args.model == DEFAULT_MODEL_NAME
    assert args.language is None
    assert args.device is None
    assert args.chunks is False


def test_cli_execution_mocked(capsys: pytest.CaptureFixture[str]) -> None:
    """CLI executes transcribe and chunks options cleanly with mocked AudioTranscriber."""
    mock_result = TranscriptionResult(
        meeting_id="standup_mon",
        source_file="standup.mp3",
        language="en",
        transcript="Team discussed auth migration.",
        segments=[
            TranscriptSegment(start=0.0, end=5.0, text="Team discussed auth migration."),
        ],
    )

    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as out_json:
        out_path = out_json.name

    try:
        with patch.object(AudioTranscriber, "transcribe", return_value=mock_result):
            ret = main(["fake_audio.mp3", "--meeting-id", "standup_mon", "--output", out_path, "--chunks"])
            assert ret == 0

            # Verify saved output file
            with open(out_path, "r", encoding="utf-8") as f:
                saved = json.load(f)
            assert saved["meeting_id"] == "standup_mon"
            assert saved["transcript"] == "Team discussed auth migration."

            captured = capsys.readouterr()
            assert "Saved transcript to:" in captured.out
            assert "Generated 1 NLP Chunks" in captured.out
    finally:
        if os.path.exists(out_path):
            os.remove(out_path)
