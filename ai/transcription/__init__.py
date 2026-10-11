"""MemHub Module 4: Meeting Transcription and Transcript Processing."""

from ai.transcription.config import (
    DEFAULT_MODEL_NAME,
    SUPPORTED_AUDIO_EXTENSIONS,
    VALID_WHISPER_MODELS,
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
    TranscriptionError,
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
from ai.transcription.transcriber import (
    AudioTranscriber,
    check_ffmpeg_available,
    check_whisper_dependencies,
    transcribe_audio,
)

__all__ = [
    # Top-level public APIs
    "transcribe_audio",
    "process_transcript",
    "AudioTranscriber",
    "TranscriptProcessor",
    # Config
    "TranscriptionConfig",
    "ProcessingConfig",
    "DEFAULT_MODEL_NAME",
    "SUPPORTED_AUDIO_EXTENSIONS",
    "VALID_WHISPER_MODELS",
    "resolve_device",
    "validate_file_extension",
    # Schemas
    "TranscriptionResult",
    "TranscriptSegment",
    "TranscriptChunk",
    # Helper checks
    "check_ffmpeg_available",
    "check_whisper_dependencies",
    "clean_segment_text",
    # Exceptions
    "TranscriptionError",
    "AudioFileNotFoundError",
    "UnsupportedAudioFormatError",
    "EmptyAudioFileError",
    "DependencyMissingError",
    "FFmpegNotFoundError",
    "ModelLoadError",
    "TranscriptionExecutionError",
    "InvalidTimestampError",
    "EmptyTranscriptError",
]
