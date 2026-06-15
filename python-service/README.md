# Voice Flow Service

FastAPI service for audio transcription with VAD and text refinement.

## Prerequisites

- Python 3.14+
- `OPENROUTER_API_KEY` for transcription and refinement

Optional OpenRouter settings:

```bash
export OPENROUTER_TRANSCRIPTION_MODEL="nvidia/parakeet-tdt-0.6b-v3"
export OPENROUTER_REFINEMENT_MODEL="openai/gpt-oss-120b"
export OPENROUTER_REFERER="https://your-site.example"
export OPENROUTER_TITLE="Jarvis"
export OPENROUTER_MAX_ATTEMPTS="3"
export OPENROUTER_RETRY_BASE_DELAY_SECONDS="0.5"
export OPENROUTER_REFINEMENT_TIMEOUT_SECONDS="12"
export OPENROUTER_REFINEMENT_MIN_THROUGHPUT="50"
export VOICE_MAX_TRANSCRIPTION_CHUNK_SECONDS="45"
```

Refinement routes to the lowest-latency provider that meets the preferred throughput floor. Providers below
the floor remain available as OpenRouter fallbacks.

## Setup

```bash
cd python-service
./setup.sh
```

## Start Service on Port 8765

```bash
source venv/bin/activate
python3 -m uvicorn main:app --host 127.0.0.1 --port 8765
```

Or simply:

```bash
python3 main.py
```

## Endpoints

- `GET /health` - Health check
- `POST /process-flow` - Process audio (VAD → STT → refinement)
- `POST /transcribe-only` - Transcribe without refinement

VAD is used to reject empty recordings and choose boundaries for long requests. Natural pauses inside normal
utterances are preserved for STT punctuation and self-correction cues.

## Usage

Send a WAV file to `/process-flow`:

```bash
curl -X POST http://127.0.0.1:8765/process-flow \
  -F 'context={"destination":"chat","accessibilityStatus":"not_requested"}' \
  -F "file=@audio.wav"
```

The `context` multipart field is optional. When present, it is a JSON object describing the destination app
and bounded nearby focused-field text used for app-aware refinement. Requests containing only `file` remain
supported and use generic refinement.
