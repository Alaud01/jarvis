# Voice Flow Service

FastAPI service for audio transcription with VAD and text refinement.

## Prerequisites

- Python 3.14+
- `OPENROUTER_API_KEY` for transcription with `nvidia/parakeet-tdt-0.6b-v3`
- [Ollama](https://ollama.ai) with `gemma4:31b-cloud` model

Optional OpenRouter settings:

```bash
export OPENROUTER_TRANSCRIPTION_MODEL="nvidia/parakeet-tdt-0.6b-v3"
export OPENROUTER_REFERER="https://your-site.example"
export OPENROUTER_TITLE="Jarvis"
```

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

## Usage

Send a WAV file to `/process-flow`:

```bash
curl -X POST http://127.0.0.1:8765/process-flow \
  -F "file=@audio.wav"
```
