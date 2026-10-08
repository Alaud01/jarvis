# Use MLX Whisper Turbo without personalization

Voice transcription runs locally with `mlx-community/whisper-large-v3-turbo` and `mlx-whisper` FP16 on
Apple Silicon's Metal GPU. This replaces the transcription provider chain described in ADR 0003 and the
model/runtime choice in ADR 0005. OpenRouter remains available only for text refinement.

The voice service preloads weights at app launch and releases them after 600 seconds of inactivity,
restoring the previous idle policy. Recording shortcuts and UI recording immediately request a background
reload via `/warmup`, concurrent with microphone capture. Model load completion and request completion
refresh the idle timer. Loading or active requests prevent unloading. Clearing both `ModelHolder` and
MLX's allocation cache releases resident memory while retaining the downloaded weights on disk.
Loading, inference, and unloading use one persistent OS thread to preserve MLX's Metal stream affinity.
Concurrent load requests are coalesced, and a request during unloading reloads after it finishes.
The existing single-worker admission and cancellation behavior continues to serialize native inference.
Model readiness waits are bounded; failures surface as local errors rather than selecting another model.
The installer, health protocol, and setup UI identify Whisper Turbo. A new model-ready marker prevents an
older managed installation from being selected as a Whisper runtime before it has been installed.

Whisper receives audio with no initial prompt, glossary, hotwords, or word boosting. Personal Dictionary
collection, replacement rules, term-lock refinement prompts, and correction observations are commented out
for later restoration. Legacy dictionary payloads are ignored and saved entries are preserved. General
app-aware refinement, conservative spoken revisions, audio validation, and pause-preserving chunking remain.
