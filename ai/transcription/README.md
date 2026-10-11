# MemHub Module 4: Meeting Transcription & Transcript Processing

Module 4 converts organizational audio and video meeting recordings (MP3, WAV, M4A, MP4, WebM, FLAC, etc.) into timestamped, structured transcripts, and processes them into NLP-ready chunks. These chunks are designed for immediate ingestion into downstream MemHub modules (Module 1 Document Processor and Module 3 Knowledge Graph NER/Relation Extractor).

---

## Architecture Overview

```text
Audio File (.mp3, .wav, .m4a, .mp4)
       │
       ▼
[AudioTranscriber] (OpenAI Whisper + FFmpeg)
       │
       ▼
[TranscriptionResult] (Full transcript + timestamped segments)
       │
       ▼
[TranscriptProcessor] (Artifact cleaning + timestamp-aware chunking)
       │
       ▼
[TranscriptChunk] List (Document ID, Chunk ID, Text, Timestamps, Metadata)
       │
       ▼
Downstream NLP Pipelines (Module 1 Chunk Indexing / Module 3 KG Extraction)
```

---

## 1. Installation & Setup

### Core Text Processing & Testing Dependencies
To run schemas, chunking, and unit tests (without audio hardware or downloading Whisper models):
```bash
pip install -r ai/transcription/requirements.txt
```

### Audio Transcription Dependencies
To transcribe actual local audio files with OpenAI Whisper, install PyTorch and Whisper:
```bash
pip install torch openai-whisper
```

### FFmpeg Installation
Whisper uses FFmpeg to decode audio and video formats:
- **Ubuntu/Debian**:
  ```bash
  sudo apt-get update && sudo apt-get install -y ffmpeg
  ```
- **macOS (Homebrew)**:
  ```bash
  brew install ffmpeg
  ```
- **Windows**:
  ```powershell
  winget install Gyan.FFmpeg
  # or
  choco install ffmpeg
  ```

---

## 2. Deep Learning & Whisper Concepts

### How Whisper Works at a High Level
OpenAI Whisper is an **Encoder-Decoder Transformer** trained on 680,000 hours of multilingual, multitask supervised audio data collected from the web.
1. The raw audio signal is resampled to 16 kHz and converted into an 80-channel log-magnitude Mel spectrogram.
2. The **Audio Encoder** processes the spectrogram through two 1D convolution layers followed by Transformer blocks with GELU activations and positional embeddings.
3. The **Text Decoder** uses learned positional encodings and autoregressive cross-attention to predict sequences of byte-pair tokens representing language, timestamps, and transcribed text.

### Why Whisper is a Deep Learning Component
Unlike traditional classical Hidden Markov Model (HMM) speech engines that rely on separate acoustic and pronunciation dictionaries, Whisper is an **end-to-end deep neural network**. It directly maps continuous acoustic representations to discrete text tokens while jointly learning punctuation, capitalization, language identification, and speech activity detection.

### Model Selection
Whisper offers multiple model sizes balancing speed, memory, and accuracy:

| Model | Parameters | Required VRAM | Relative Speed | Typical Use Case |
| :--- | :--- | :--- | :--- | :--- |
| `tiny` / `tiny.en` | 39 M | ~1 GB | ~32x | Quick checks, low-resource embedded devices |
| `base` / `base.en` | 74 M | ~1 GB | ~16x | **Default for consumer laptops and quick iterations** |
| `small` / `small.en` | 244 M | ~2 GB | ~6x | Standard team meetings with moderate audio quality |
| `medium` / `medium.en` | 769 M | ~5 GB | ~2x | Multi-speaker technical conferences, varied accents |
| `large-v3` / `turbo` | 1550 M / 809 M | ~10 GB / ~6 GB | 1x / ~8x | Production quality, multi-language organizational archives |

> **Note on Model Downloads**: On the first invocation, Whisper downloads the selected model weights from Hugging Face / OpenAI CDN to `~/.cache/whisper`. Subsequent runs reuse the cached weights locally.

### Language Selection
By default, language detection is automatic. To specify English explicitly or decode another language, pass the 2-letter ISO code:
```python
transcribe_audio("meeting.mp3", language="en")
```

---

## 3. Why Timestamps Matter for MemHub

In an organizational memory system, a transcript is more than raw text. Timestamps allow MemHub to:
1. **Trace Knowledge Directly to Source Audio**: When an AI query asks *"Why did we choose PostgreSQL?"*, MemHub cites the exact meeting and allows jumping directly to the discussion (e.g. `14:22 - 15:40`).
2. **Contextual Segment Chunking**: Chunking algorithms can use speech pauses and time limits to group sentences that belong together logically rather than cutting words in half.
3. **Temporal Ordering of Organizational Decisions**: Connecting meeting timestamps to document revision histories allows reconstructing organizational timelines.

---

## 4. Usage Guide

### Python API

```python
from ai.transcription import transcribe_audio, process_transcript

# Step 1: Transcribe the audio recording
result = transcribe_audio(
    file_path="team_meeting.mp3",
    model_name="base",   # 'tiny', 'base', 'small', 'medium', 'large'
    language="en",       # or None for auto-detection
    meeting_id="standup_2026_10_11",
)

print(f"Meeting: {result.meeting_id}")
print(f"Language: {result.language}")
print(f"Transcript: {result.transcript[:150]}...")

for segment in result.segments[:3]:
    print(f"[{segment.start:.1f}s -> {segment.end:.1f}s]: {segment.text}")

# Step 2: Convert timestamped segments into NLP-ready chunks
chunks = process_transcript(
    transcript=result,
    target_chunk_words=120,
    max_chunk_duration_sec=60.0,
)

for chunk in chunks:
    print(f"Chunk ID: {chunk.chunk_id}")
    print(f"Time: {chunk.start_time}s - {chunk.end_time}s")
    print(f"Text: {chunk.text}\n")
```

### Command-Line Interface (CLI)

Transcribe an audio file and print the transcript and segment summary:
```bash
python -m ai.transcription.transcribe meeting.mp3
```

Specify a model, language, and export formatted JSON:
```bash
python -m ai.transcription.transcribe meeting.mp3 \
  --model small \
  --language en \
  --output transcript.json \
  --chunks \
  --chunk-output nlp_chunks.json
```

---

## 5. Downstream Integration with MemHub Modules

### Compatibility with Module 1 (Document Processor)
Each `TranscriptChunk` produces a dictionary schema conforming to Module 1 chunking conventions:
```json
{
  "text": "The team decided to migrate authentication to JWT tokens in Project Phoenix.",
  "chunk_id": "meeting_001_chunk_0",
  "document_id": "meeting_001",
  "metadata": {
    "meeting_id": "meeting_001",
    "source_file": "standup.mp3",
    "language": "en",
    "start_time": 0.0,
    "end_time": 18.5,
    "duration_sec": 18.5,
    "source_type": "meeting_transcript",
    "segment_count": 3
  }
}
```

### Downstream Ingestion into Module 3 (Knowledge Graph NLP)
A backend teammate can ingest `TranscriptChunk` objects directly into Module 3's pipeline:
```python
from ai.nlp.pipeline import extract_knowledge_graph
from ai.transcription import transcribe_audio, process_transcript

# 1. Transcribe audio
transcript = transcribe_audio("arch_review.mp3")

# 2. Chunk transcript
chunks = process_transcript(transcript)

# 3. Extract Knowledge Graph entities & relationships
for chunk in chunks:
    kg_result = extract_knowledge_graph(chunk.to_dict())
    print("Entities:", [e["text"] for e in kg_result["entities"]])
    print("Relationships:", kg_result["relationships"])
```

---

## 6. Limitations & Assumptions

1. **Speaker Diarization**: Plain Whisper does not perform speaker diarization (labeling *"Who spoke when"*). Timestamps mark when phrases were spoken, but distinguishing speaker identities requires a separate diarization model (e.g. `pyannote-audio`).
2. **Audio Quality and Background Noise**: Heavy background noise, overlapping speakers, or low-quality microphone inputs can cause hallucinations or missed segments.
3. **Specialized Terminology**: Company-specific acronyms or internal project names may occasionally be transcribed phonetically unless provided in Whisper initial prompts.
4. **Hardware Latency**: On CPU, transcribing an hour-long recording with the `base` model takes approximately 3–6 minutes, whereas larger models (`medium`, `large`) are best run on GPU.

---

## 7. Running Tests Without Model Downloads

All unit tests in `ai/transcription/tests/` use mocks and synthesized segments. They run in under 1 second without downloading model weights or requiring audio hardware:

```bash
python -m pytest ai/transcription/tests -v
```
