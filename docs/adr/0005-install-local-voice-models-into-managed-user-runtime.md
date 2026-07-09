# Install local voice models into a managed user runtime

Jarvis installs optional local Parakeet voice dependencies into a managed runtime under the user's application-support directory instead of bundling PyTorch, NeMo, and model weights inside the signed Electron app. This keeps the downloadable app smaller and avoids mutating the app bundle after signing, while still giving users an explicit local-first path when they choose to download the heavy ASR stack.

Jarvis keeps OpenRouter transcription/refinement as the fallback when the managed runtime is missing, skipped, or fails to install. The packaged app still ships the lightweight Python sidecar source as an Electron extra resource, but the heavyweight ML runtime and model cache live outside the app bundle so failed or partial installs do not corrupt the desktop shell.
