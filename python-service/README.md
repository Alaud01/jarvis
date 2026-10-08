# Voice Flow Service

FastAPI service for audio transcription with Silero VAD, Apple MLX Whisper Turbo, and optional text refinement.

## Prerequisites

- Apple Silicon Mac with Metal available
- Python 3.11 or newer, running natively as arm64
- Internet access for the first model download (approximately 1.6 GB)
- Optional `OPENROUTER_API_KEY` for transcript refinement

## Setup

```bash
cd python-service
./setup.sh
```

Or run `pnpm setup:python` from the repository root. `requirements.txt` installs `mlx-whisper` on Apple Silicon.
The managed installer in the desktop app installs the same dependencies and verifies the same model.

## Transcription runtime

Transcription uses `mlx-community/whisper-large-v3-turbo` through `mlx-whisper`, with FP16 weights on the
Metal GPU. Loading, transcription, and unloading all run on the same persistent voice worker thread.
The model loads at app launch and unloads after 10 minutes (600 seconds) of inactivity, releasing both its
cached weight references and MLX's GPU allocation cache. Loading and active voice requests prevent unloading.

Pressing the recording shortcut or button immediately sends a nonblocking `POST /warmup` request, starting
reload while microphone capture begins. A warm model simply refreshes the idle deadline. Requests arriving
while a load is already pending share it; a request during offloading waits for offloading, then reloads.
Transcription also requests loading if needed, so clients that do not call `/warmup` remain supported.
Activity at recording start, model load completion, and voice request completion resets the idle deadline.
Set `VOICE_LOCAL_WHISPER_IDLE_UNLOAD_SECONDS=0` to disable idle unloading.
The first launch downloads the model; later launches use the Hugging Face cache. App-managed installations
store their runtime and caches under `~/Library/Application Support/Jarvis/python-service`.

One voice worker serializes dictations and keeps health checks responsive during inference. Requests wait
up to `VOICE_LOCAL_WHISPER_COLD_START_BUDGET_SECONDS` (default 90) for a cold model. Loading or inference
failures return a local error. The Electron request timeout defaults to 150 seconds and should exceed this
wait plus inference/refinement time.

Whisper receives only 16 kHz audio, with no glossary, initial prompt, hotwords, or vocabulary boosting.
Personal Dictionary payloads, replacement rules, protected-term refinement prompts, and correction learning
are disabled. Their integration code is commented out and saved entries remain available for later use.

Silero VAD rejects empty recordings and chooses bounded chunk boundaries for long requests. Internal pauses
remain intact. Whisper is explicitly set to English (`language="en"`), skipping language detection,
and transcribes rather than translates.

## Optional settings

```bash
export VOICE_LOCAL_WHISPER_COLD_START_BUDGET_SECONDS="90"
export VOICE_LOCAL_WHISPER_IDLE_UNLOAD_SECONDS="600"
export VOICE_PROCESS_FLOW_TIMEOUT_MS="150000"
export VOICE_MAX_TRANSCRIPTION_CHUNK_SECONDS="45"
export OPENROUTER_REFINEMENT_MODEL="openai/gpt-oss-safeguard-20b"
export OPENROUTER_REFINEMENT_REASONING_EFFORT="low"
export OPENROUTER_REFINEMENT_TIMEOUT_SECONDS="12"
export OPENROUTER_REFINEMENT_MIN_THROUGHPUT="200"
export OPENROUTER_REFINEMENT_DISAMBIGUATION_HINT_CHARS="80"
```

With an OpenRouter key, refinement handles grammar, punctuation, spoken revisions, and formatting.
Without a key or when refinement fails, the service uses its conservative spoken-revision fallback.
Personal Dictionary is excluded from both paths.

## Timing logs

Every dictation uses the same `[VoiceTiming <id>]` prefix across Electron and Python.
Each summary is one line with milliseconds for each step:

- `startup`: target-app capture, microphone setup, and shortcut-to-recording readiness.
- `microphone`: permission check, Mac lid check, and renderer microphone/worklet setup.
- `overlay`: time until the renderer acknowledges a frame for the requested status.
- `service`: model-loading wait, worker dispatch, upload copy, audio loading, VAD,
  transcription, refinement, pipeline total, and service total.
- `transport`: upload preparation, HTTP request, response-body parsing, and round-trip total.
- `delivery`: remaining context wait, microphone stop/drain, service round trip, routing/paste,
  completion hold, and stop-to-hide request. The hide animation follows that request.

Totals contain their component steps. HTTP time contains Python service time; service time
contains model wait plus pipeline time. Do not add these nested totals together.
Detailed progress and transcript text are available with `JARVIS_LOG_LEVEL=debug`.
The overlay requests `Starting microphone...` immediately while target capture and microphone
setup proceed; it changes to `Listening...` only once capture is ready. On macOS the status
window is recreated for each new recording to handle Spaces, so renderer creation can still
contribute to its first frame. Model warmup runs in parallel and does not gate the overlay.

## Start service

```bash
venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port "${VOICE_SERVICE_PORT:-8765}"
```

Or use `pnpm start:python` from the repository root.

## Endpoints

- `GET /health` — VAD health plus Whisper loading, idle timeout, active requests, device, and error state
- `POST /warmup` — start/reuse model loading without waiting for weights
- `POST /process-flow` — VAD → local Whisper transcription → optional refinement
- `POST /transcribe-only` — VAD → local Whisper transcription

Send a WAV file with optional app/field context:

```bash
curl -X POST http://127.0.0.1:8765/process-flow \
  -F 'context={"app":{"name":"Mail","bundleId":"com.apple.mail","pid":123},"accessibilityStatus":"not_requested"}' \
  -F "file=@audio.wav"
```

Requests containing only `file` use generic refinement. Legacy dictionary/vocabulary context fields are ignored.
