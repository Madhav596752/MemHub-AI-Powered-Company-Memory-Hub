"""Configuration settings and device resolution for the MemHub transcription module."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Set

from ai.transcription.exceptions import UnsupportedAudioFormatError

# Standard Whisper model sizes
VALID_WHISPER_MODELS: Set[str] = {
    "tiny",
    "tiny.en",
    "base",
    "base.en",
    "small",
    "small.en",
    "medium",
    "medium.en",
    "large",
    "large-v1",
    "large-v2",
    "large-v3",
    "turbo",
}

# Supported audio & video container extensions
SUPPORTED_AUDIO_EXTENSIONS: Set[str] = {
    ".mp3",
    ".wav",
    ".m4a",
    ".mp4",
    ".flac",
    ".ogg",
    ".aac",
    ".wma",
    ".webm",
}

DEFAULT_MODEL_NAME: str = "base"
DEFAULT_TARGET_CHUNK_WORDS: int = 120
DEFAULT_MAX_CHUNK_DURATION_SEC: float = 60.0


def resolve_device(preferred_device: Optional[str] = None) -> str:
    """Resolve compute device ('cuda' or 'cpu') automatically where supported.

    Args:
        preferred_device: Optional user-specified device ('cpu', 'cuda', 'cuda:0', 'mps').

    Returns:
        Resolved device string ('cuda', 'cpu', 'mps', etc.).
    """
    if preferred_device is not None and preferred_device.strip():
        return preferred_device.strip().lower()

    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass

    return "cpu"


@dataclass(frozen=True)
class TranscriptionConfig:
    """Configuration options for audio transcription using OpenAI Whisper.

    Attributes:
        model_name: Whisper model variant (default: 'base').
        device: Target compute device ('cpu', 'cuda', or None for auto-detection).
        language: Two-letter ISO language code (e.g., 'en', 'es') or None for auto-detection.
        temperature: Sampling temperature for Whisper decoding (default: 0.0 for greedy decoding).
        fp16: Whether to use FP16 half-precision on GPU (default: True if GPU available).
        verbose: Whether Whisper prints progress to stdout.
    """

    model_name: str = DEFAULT_MODEL_NAME
    device: Optional[str] = None
    language: Optional[str] = None
    temperature: float = 0.0
    fp16: Optional[bool] = None
    verbose: bool = False

    @property
    def resolved_device(self) -> str:
        """Return the resolved runtime device ('cuda', 'mps', or 'cpu')."""
        return resolve_device(self.device)

    @property
    def resolved_fp16(self) -> bool:
        """FP16 is only safely usable on CUDA devices in PyTorch/Whisper."""
        if self.fp16 is not None:
            return self.fp16
        return self.resolved_device.startswith("cuda")


@dataclass(frozen=True)
class ProcessingConfig:
    """Configuration options for transcript cleaning and timestamp-aware chunking.

    Attributes:
        target_chunk_words: Desired approximate word budget per chunk before closing.
        max_chunk_duration_sec: Maximum time duration (in seconds) spanned by a single chunk.
        clean_whitespace: Whether to collapse redundant whitespace and control characters.
        remove_repeated_tokens: Whether to clean consecutive repetitive hallucination tokens.
        break_on_sentence_end: Whether to preferentially split chunks on sentence boundaries.
    """

    target_chunk_words: int = DEFAULT_TARGET_CHUNK_WORDS
    max_chunk_duration_sec: float = 60.0
    clean_whitespace: bool = True
    remove_repeated_tokens: bool = True
    break_on_sentence_end: bool = True


def validate_file_extension(file_path: str) -> str:
    """Validate that the given file path has a supported audio extension.

    Args:
        file_path: Path to the audio file.

    Returns:
        The lowercase extension.

    Raises:
        UnsupportedAudioFormatError: If the extension is not supported.
    """
    import os

    _, ext = os.path.splitext(file_path)
    ext_lower = ext.lower()
    if not ext_lower or ext_lower not in SUPPORTED_AUDIO_EXTENSIONS:
        supported_list = ", ".join(sorted(SUPPORTED_AUDIO_EXTENSIONS))
        raise UnsupportedAudioFormatError(
            f"Unsupported audio format '{ext}'. Supported formats: {supported_list}"
        )
    return ext_lower
