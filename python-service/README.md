# Voice Flow Service

FastAPI service for audio transcription with VAD and text refinement.

## Prerequisites

- Python 3.14+
- `OPENROUTER_API_KEY` for transcription and refinement

OpenRouter remains the default transcription provider. Optional OpenRouter settings:

```bash
export OPENROUTER_TRANSCRIPTION_MODEL="nvidia/parakeet-tdt-0.6b-v3"
export OPENROUTER_REFINEMENT_MODEL="inception/mercury-2:nitro"
export OPENROUTER_REFINEMENT_REASONING_EFFORT="low"
export OPENROUTER_REFERER="https://your-site.example"
export OPENROUTER_TITLE="Jarvis"
export OPENROUTER_MAX_ATTEMPTS="3"
export OPENROUTER_RETRY_BASE_DELAY_SECONDS="0.5"
export OPENROUTER_REFINEMENT_TIMEOUT_SECONDS="12"
export OPENROUTER_REFINEMENT_MIN_THROUGHPUT="50"
export VOICE_MAX_TRANSCRIPTION_CHUNK_SECONDS="45"
```

Optional local Parakeet settings:

```bash
export VOICE_LOCAL_PARAKEET_ENABLED="true"
export VOICE_LOCAL_PARAKEET_MODEL="nvidia/parakeet-tdt_ctc-110m"
export VOICE_LOCAL_PARAKEET_READY_BUDGET_SECONDS="0.5"
export VOICE_LOCAL_PARAKEET_SHORT_BUDGET_SECONDS="3.0"
export VOICE_LOCAL_PARAKEET_MEDIUM_BUDGET_SECONDS="5.0"
```

When local Parakeet is enabled, the service starts loading it in the background and uses it only when it is
ready inside the active dictation budget. If the local model is cold, unavailable, or too slow, the request
falls back sequentially to OpenRouter and returns transcription metadata describing the provider/model used.
Vocabulary entries are already passed through the voice context for refinement and future model guidance;
NeMo CTC context-biasing still needs to be wired before `used_vocabulary_guidance` is reported as true for
local Parakeet.

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

The `context` multipart field is optional. When present, it is a JSON object describing the destination app,
bounded nearby focused-field text, active replacement rules, and vocabulary guidance used for app-aware
refinement. Requests containing only `file` remain supported and use generic refinement.
