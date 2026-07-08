# Voice Flow Service

FastAPI service for audio transcription with VAD and text refinement.

## Prerequisites

- Python 3.14+
- `OPENROUTER_API_KEY` for OpenRouter fallback transcription and refinement
- NeMo and PyTorch installed in the environment when local Parakeet transcription is enabled

Local Parakeet is the default transcription provider. OpenRouter remains configured as the fallback path
for cold starts, local model failures, and transcript refinement. Optional OpenRouter settings:

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
export VOICE_LOCAL_PARAKEET_DEVICE="mps"
export VOICE_LOCAL_PARAKEET_PRELOAD_ENABLED="true"
export VOICE_LOCAL_PARAKEET_COLD_START_BUDGET_SECONDS="90"
export VOICE_LOCAL_PARAKEET_TIMEOUT_FALLBACK_ENABLED="false"
export VOICE_LOCAL_PARAKEET_IDLE_UNLOAD_SECONDS="600"
export VOICE_LOCAL_PARAKEET_READY_BUDGET_SECONDS="0.5"
export VOICE_LOCAL_PARAKEET_SHORT_BUDGET_SECONDS="3.0"
export VOICE_LOCAL_PARAKEET_MEDIUM_BUDGET_SECONDS="5.0"
```

When local Parakeet is enabled, the service starts loading it in the background and uses it only when it is
ready. Cold start has its own wait budget and does not count against active transcription latency. If the
local model is unavailable, the request falls back sequentially to OpenRouter and returns transcription
metadata describing the provider/model used. Local timeout fallback is disabled by default so a cold or slow
local model does not silently become an unguided OpenRouter transcription; set
`VOICE_LOCAL_PARAKEET_TIMEOUT_FALLBACK_ENABLED=true` to opt into that behavior.
Vocabulary entries are passed through the voice context as Vocabulary Guidance. Local Parakeet uses NeMo CTC
context-biasing when guidance terms are available, and transcription metadata reports whether guidance was
used.

On Apple Silicon, `VOICE_LOCAL_PARAKEET_DEVICE=mps` forces PyTorch's Metal backend and fails fast if MPS is
not available. Use `auto` to prefer MPS when available and otherwise use CPU. The loaded NeMo/PyTorch model
can keep several GB resident; `VOICE_LOCAL_PARAKEET_IDLE_UNLOAD_SECONDS` unloads it after inactivity and
clears the torch device cache. Set `VOICE_LOCAL_PARAKEET_PRELOAD_ENABLED=false` for the lowest idle RAM at
the cost of paying cold-start latency on the next dictation.

Refinement routes to the lowest-latency provider that meets the preferred throughput floor. Providers below
the floor remain available as OpenRouter fallbacks.

## Setup

```bash
cd python-service
./setup.sh
```

## Start Service on Port 8765

```bash
venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port "${VOICE_SERVICE_PORT:-8765}"
```

Or simply:

```bash
venv/bin/python main.py
```

Both commands default to port `8765` unless `VOICE_SERVICE_PORT` is set.

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
