"""Custom exceptions for the MemHub audio transcription and transcript processing module."""


class TranscriptionError(Exception):
    """Base exception for all transcription and transcript processing errors."""


class AudioFileNotFoundError(TranscriptionError, FileNotFoundError):
    """Raised when the specified audio file path does not exist."""


class UnsupportedAudioFormatError(TranscriptionError, ValueError):
    """Raised when the audio file format/extension is not supported."""


class EmptyAudioFileError(TranscriptionError, ValueError):
    """Raised when the audio file is empty (0 bytes) or contains no readable audio data."""


class DependencyMissingError(TranscriptionError, RuntimeError):
    """Raised when a required runtime dependency (e.g. whisper, torch) is not installed."""


class FFmpegNotFoundError(TranscriptionError, RuntimeError):
    """Raised when the system ffmpeg binary is not found in PATH."""


class ModelLoadError(TranscriptionError, RuntimeError):
    """Raised when loading the Whisper model weights fails."""


class TranscriptionExecutionError(TranscriptionError, RuntimeError):
    """Raised when the Whisper model execution encounters a runtime failure."""


class InvalidTimestampError(TranscriptionError, ValueError):
    """Raised when transcript segments contain negative, inverted, or malformed timestamps."""


class EmptyTranscriptError(TranscriptionError, ValueError):
    """Raised when attempting to chunk or process a transcript with no text or segments."""
