"""Audio transcription using OpenAI Whisper with device selection and error handling."""

from __future__ import annotations

import os
import shutil
from typing import Any, Dict, List, Optional, Union

from ai.transcription.config import (
    DEFAULT_MODEL_NAME,
    TranscriptionConfig,
    validate_file_extension,
)
from ai.transcription.exceptions import (
    AudioFileNotFoundError,
    DependencyMissingError,
    EmptyAudioFileError,
    FFmpegNotFoundError,
    ModelLoadError,
    TranscriptionExecutionError,
)
from ai.transcription.schemas import TranscriptSegment, TranscriptionResult


def check_ffmpeg_available() -> None:
    """Verify that FFmpeg is available on the system PATH.

    Raises:
        FFmpegNotFoundError: If ffmpeg is not found on PATH.
    """
    if shutil.which("ffmpeg") is None:
        raise FFmpegNotFoundError(
            "FFmpeg executable not found on system PATH. "
            "Whisper requires FFmpeg to decode audio containers (MP3, M4A, MP4, WAV, etc.). "
            "Install FFmpeg via your package manager:\n"
            "  Ubuntu/Debian: sudo apt-get install -y ffmpeg\n"
            "  macOS:         brew install ffmpeg\n"
            "  Windows:       winget install Gyan.FFmpeg"
        )


def check_whisper_dependencies() -> None:
    """Verify that whisper and torch packages are installed.

    Raises:
        DependencyMissingError: If whisper or torch is missing.
    """
    try:
        import torch  # noqa: F401
    except ImportError as exc:
        raise DependencyMissingError(
            "PyTorch ('torch') is not installed. Install via: pip install torch"
        ) from exc

    try:
        import whisper  # noqa: F401
    except ImportError as exc:
        raise DependencyMissingError(
            "OpenAI Whisper ('openai-whisper') is not installed. "
            "Install via: pip install openai-whisper"
        ) from exc


class AudioTranscriber:
    """Encapsulates loading and running OpenAI Whisper for local audio transcription."""

    def __init__(self, config: Optional[TranscriptionConfig] = None) -> None:
        self.config = config or TranscriptionConfig()
        self._model: Any = None

    @property
    def model(self) -> Any:
        """Lazy-loaded Whisper model instance."""
        if self._model is None:
            self._model = self._load_model()
        return self._model

    def _load_model(self) -> Any:
        """Load Whisper model on the configured device."""
        check_whisper_dependencies()
        import whisper

        device = self.config.resolved_device
        model_name = self.config.model_name or DEFAULT_MODEL_NAME
        try:
            return whisper.load_model(model_name, device=device)
        except Exception as exc:
            raise ModelLoadError(
                f"Failed to load Whisper model '{model_name}' on device '{device}': {exc}"
            ) from exc

    def transcribe(
        self,
        file_path: str,
        meeting_id: Optional[str] = None,
        language: Optional[str] = None,
    ) -> TranscriptionResult:
        """Transcribe an audio file into a structured TranscriptionResult.

        Args:
            file_path: Path to the audio file on disk.
            meeting_id: Optional meeting ID (defaults to filename without extension).
            language: Optional language override (e.g. 'en').

        Returns:
            TranscriptionResult containing full transcript, segments, and language.

        Raises:
            AudioFileNotFoundError: If the file does not exist.
            UnsupportedAudioFormatError: If format extension is unsupported.
            EmptyAudioFileError: If file is 0 bytes.
            FFmpegNotFoundError: If FFmpeg is missing.
            TranscriptionExecutionError: If transcription fails during inference.
        """
        if not file_path or not isinstance(file_path, str):
            raise AudioFileNotFoundError(f"Invalid audio file path: {file_path!r}")

        if not os.path.exists(file_path):
            raise AudioFileNotFoundError(f"Audio file not found at path: {file_path}")

        if not os.path.isfile(file_path):
            raise AudioFileNotFoundError(f"Specified path is a directory, not a file: {file_path}")

        # Validate file size
        file_size = os.path.getsize(file_path)
        if file_size == 0:
            raise EmptyAudioFileError(f"Audio file is empty (0 bytes): {file_path}")

        # Validate extension
        validate_file_extension(file_path)

        # Check FFmpeg
        check_ffmpeg_available()

        # Resolve meeting ID
        base_name = os.path.basename(file_path)
        m_id = meeting_id or os.path.splitext(base_name)[0]

        # Prepare Whisper options
        target_language = language or self.config.language
        whisper_opts: Dict[str, Any] = {
            "temperature": self.config.temperature,
            "fp16": self.config.resolved_fp16,
            "verbose": self.config.verbose,
        }
        if target_language:
            whisper_opts["language"] = target_language

        # Run transcription inference
        try:
            raw_result = self.model.transcribe(file_path, **whisper_opts)
        except Exception as exc:
            raise TranscriptionExecutionError(
                f"Whisper transcription failed for '{file_path}': {exc}"
            ) from exc

        # Extract segments
        raw_segments: List[Dict[str, Any]] = raw_result.get("segments", [])
        parsed_segments: List[TranscriptSegment] = []
        for idx, seg in enumerate(raw_segments):
            start = float(seg.get("start", 0.0))
            end = float(seg.get("end", 0.0))
            text = str(seg.get("text", "")).strip()
            parsed_segments.append(
                TranscriptSegment(
                    start=start,
                    end=end,
                    text=text,
                    id=idx,
                    avg_logprob=seg.get("avg_logprob"),
                    no_speech_prob=seg.get("no_speech_prob"),
                )
            )

        full_text = str(raw_result.get("text", "")).strip()
        detected_language = raw_result.get("language", target_language or "en")

        return TranscriptionResult(
            meeting_id=m_id,
            source_file=base_name,
            language=detected_language,
            transcript=full_text,
            segments=parsed_segments,
        )


def transcribe_audio(
    file_path: str,
    model_name: Optional[str] = None,
    language: Optional[str] = None,
    device: Optional[str] = None,
    meeting_id: Optional[str] = None,
    config: Optional[TranscriptionConfig] = None,
) -> TranscriptionResult:
    """Public top-level function to transcribe an audio file.

    Example:
        >>> result = transcribe_audio("meeting.mp3", model_name="base", language="en")
        >>> print(result.transcript)

    Args:
        file_path: Path to the target audio file.
        model_name: Whisper model variant ('tiny', 'base', 'small', 'medium', 'large', etc.).
        language: Two-letter ISO language code (e.g. 'en') or None for auto-detect.
        device: 'cpu' or 'cuda' (defaults to auto-detection).
        meeting_id: Identifier for the meeting (defaults to file stem).
        config: Optional pre-built TranscriptionConfig instance.

    Returns:
        Structured, validated TranscriptionResult.
    """
    effective_config = config or TranscriptionConfig(
        model_name=model_name or DEFAULT_MODEL_NAME,
        device=device,
        language=language,
    )
    transcriber = AudioTranscriber(config=effective_config)
    return transcriber.transcribe(
        file_path=file_path,
        meeting_id=meeting_id,
        language=language,
    )
