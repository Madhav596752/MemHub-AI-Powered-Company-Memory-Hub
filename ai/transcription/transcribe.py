"""Command-line interface for MemHub audio transcription and transcript processing."""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional

from ai.transcription.config import DEFAULT_MODEL_NAME, TranscriptionConfig
from ai.transcription.exceptions import TranscriptionError
from ai.transcription.processor import process_transcript
from ai.transcription.transcriber import AudioTranscriber


def build_parser() -> argparse.ArgumentParser:
    """Build argument parser for CLI transcription."""
    parser = argparse.ArgumentParser(
        prog="python -m ai.transcription.transcribe",
        description="Transcribe meeting audio files and generate timestamped transcripts / chunks for MemHub.",
    )
    parser.add_argument(
        "file_path",
        type=str,
        help="Path to the audio recording (MP3, WAV, M4A, MP4, etc.).",
    )
    parser.add_argument(
        "--model",
        type=str,
        default=DEFAULT_MODEL_NAME,
        help=f"Whisper model variant (default: '{DEFAULT_MODEL_NAME}'). Options: tiny, base, small, medium, large, turbo.",
    )
    parser.add_argument(
        "--language",
        type=str,
        default=None,
        help="Language code (e.g., 'en', 'es', 'fr'). Auto-detects if omitted.",
    )
    parser.add_argument(
        "--device",
        type=str,
        default=None,
        help="Execution device ('cpu', 'cuda'). Defaults to auto-detection.",
    )
    parser.add_argument(
        "--meeting-id",
        type=str,
        default=None,
        help="Custom meeting identifier. Defaults to the filename stem.",
    )
    parser.add_argument(
        "--output",
        "-o",
        type=str,
        default=None,
        help="Optional path to save JSON transcript output.",
    )
    parser.add_argument(
        "--chunks",
        action="store_true",
        help="Also generate and display timestamp-aware NLP chunks.",
    )
    parser.add_argument(
        "--chunk-output",
        type=str,
        default=None,
        help="Optional path to save NLP-ready chunks as JSON.",
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    """CLI entry point."""
    parser = build_parser()
    args = parser.parse_args(argv)

    config = TranscriptionConfig(
        model_name=args.model,
        language=args.language,
        device=args.device,
    )

    try:
        transcriber = AudioTranscriber(config=config)
        print(f"Transcribing '{args.file_path}' using Whisper ({config.model_name}) on {config.resolved_device}...")
        result = transcriber.transcribe(
            file_path=args.file_path,
            meeting_id=args.meeting_id,
            language=args.language,
        )

        output_data = result.to_dict()

        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                json.dump(output_data, f, indent=2)
            print(f"Saved transcript to: {args.output}")
        else:
            print("\n=== Transcript ===")
            print(f"Meeting ID: {result.meeting_id}")
            print(f"Language:   {result.language}")
            print(f"Segments:   {len(result.segments)}")
            print("----------------------------------------")
            print(result.transcript)
            print("----------------------------------------")
            print("\n=== Timestamped Segments (First 5) ===")
            for seg in result.segments[:5]:
                print(f"[{seg.start:6.2f}s -> {seg.end:6.2f}s]: {seg.text}")
            if len(result.segments) > 5:
                print(f"... and {len(result.segments) - 5} more segments.")

        if args.chunks or args.chunk_output:
            chunks = process_transcript(result)
            chunks_data = [c.to_dict() for c in chunks]

            if args.chunk_output:
                with open(args.chunk_output, "w", encoding="utf-8") as f:
                    json.dump(chunks_data, f, indent=2)
                print(f"Saved {len(chunks)} NLP chunks to: {args.chunk_output}")
            else:
                print(f"\n=== Generated {len(chunks)} NLP Chunks ===")
                for c in chunks:
                    print(f"[{c.chunk_id}] ({c.start_time}s - {c.end_time}s): {c.text[:80]}...")

        return 0

    except TranscriptionError as exc:
        print(f"Transcription error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Unexpected error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
