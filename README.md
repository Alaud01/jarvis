# Jarvis

Jarvis is a macOS menu bar assistant for fast everyday work: chat with local or hosted models, dictate into any focused app, search the web, work with Notion, inspect documents, and drive a local browser workspace from the assistant loop.

The project is intentionally local-first. Electron owns the desktop shell, React renders the chat workspace, and a small FastAPI sidecar handles voice transcription and refinement.

## What It Does

- **Chat across providers** - Switch between Ollama, OpenRouter, and OpenCode Go models.
- **Voice dictation anywhere** - Press `Cmd+Shift+Space`, speak, and route the transcript either into Jarvis or the app that was focused before recording.
- **Personal dictionary learning** - Capture recurring dictation corrections as vocabulary guidance and scoped replacement rules.
- **Web search and fetch tools** - Use Tavily search and a guarded URL fetch tool for current information.
- **Notion workspace tools** - Search, query databases, create pages, and append blocks through a Notion integration token.
- **Browser Control** - Open and control a Jarvis-owned Chromium workspace through small assistant-directed actions with page state feedback.
- **Attachments and rich rendering** - Read local attachments, render Markdown, math, code blocks, and source links in the chat UI.

## Stack

- **Electron** - Menu bar app, tray, windows, IPC, global shortcuts, macOS integration
- **React + TypeScript** - Chat UI and stateful productivity workspace
- **Vite + Tailwind CSS** - Renderer build and styling
- **FastAPI Python sidecar** - Voice activity detection, speech-to-text, and transcript refinement
- **Provider adapters** - Ollama, OpenRouter, OpenCode Go, Tavily, and Notion

## Project Structure

```text
jarvis/
├── python-service/      # Voice sidecar, default port 8765
├── src/
│   ├── main/            # Electron main process, providers, tools, storage
│   ├── preload/         # Secure IPC bridge
│   ├── renderer/        # React UI
│   └── shared/          # Shared types and pure logic
├── tests/               # Node-based shared logic tests
├── docs/adr/            # Architecture decision records
├── CONTEXT.md           # Domain glossary for voice personalization
└── package.json
```

## Setup

```bash
pnpm install
cp .env.example .env
pnpm setup:python
```

Fill in whichever provider keys you want to use in `.env`. Ollama can run without a cloud key if a local Ollama server is available.
Provider credentials are read only from environment variables; Jarvis does not copy them into its application data store.

## Development

```bash
pnpm dev              # Vite dev server + Electron app
pnpm start:python     # Voice service only, default port 8765
pnpm start            # Compile, build renderer, and launch Electron
```

The voice service uses one canonical port: `VOICE_SERVICE_PORT`, defaulting to `8765`. Electron, `pnpm start:python`, and direct `python-service/main.py` startup all use that same default so the app does not depend on how the sidecar was started.

## Local Voice Model Setup

Jarvis can run voice transcription locally with Parakeet, but the heavy PyTorch/NeMo runtime and model weights are not installed by `pnpm setup:python`. When the app detects that the local runtime is missing, the chat workspace shows a **Local voice model** setup panel. Choosing **Install** creates a managed runtime under `~/Library/Application Support/Jarvis/python-service`, installs the pinned local ASR dependencies, and downloads `nvidia/parakeet-tdt_ctc-110m`.

If the user skips setup or installation fails, Jarvis falls back to OpenRouter transcription/refinement when `OPENROUTER_API_KEY` is configured. The packaged Electron app includes the lightweight `python-service` source as an app resource, while the heavyweight local ML runtime stays in the user's application-support directory.

## Test And Build

```bash
pnpm test             # TypeScript compile + JS tests + Python sidecar tests
pnpm test:js          # Shared voice-learning tests
pnpm test:python      # Sync requirements and run the FastAPI sidecar unittest suite
pnpm compile          # Electron main/preload/shared TypeScript
pnpm build            # Compile, build renderer, and package with electron-builder
```

If Python tests fail because dependencies are missing, run `pnpm setup:python` first.

## Environment

| Variable | Required | Used by | Purpose |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | For OpenRouter and cloud voice | Main + python-service | Chat models, speech transcription, transcript refinement |
| `TAVILY_KEY` | For web search | Main | Tavily search tool |
| `NOTION_TOKEN` | For Notion tools | Main | Search, query, create, and append to Notion pages/databases |
| `OPENCODE_GO_API_KEY` | For OpenCode Go | Main | OpenCode Go model provider |
| `VOICE_SERVICE_PORT` | No | Main + python-service | Voice sidecar port, defaults to `8765` |
| `OLLAMA_BASE_URL` | No | Main | Local Ollama endpoint, defaults to `http://localhost:11434` |
| `OLLAMA_API_KEY` | No | Main | Optional Ollama cloud model access |
| `OLLAMA_INCLUDE_CLOUD_MODELS` | No | Main | Set to `false` to hide Ollama cloud models |
| `OPENROUTER_BASE_URL` | No | Main | Override OpenRouter-compatible API base URL |
| `OPENROUTER_REFERER` / `OPENROUTER_TITLE` | No | Main + python-service | Optional OpenRouter request metadata |
| `VOICE_LOCAL_PARAKEET_ENABLED` | No | python-service | Try local Parakeet transcription before OpenRouter fallback |
| `VOICE_LOCAL_PARAKEET_MODEL` | No | python-service | Local Hugging Face/NeMo ASR model, defaults to `nvidia/parakeet-tdt_ctc-110m` |
| `VOICE_LOCAL_PARAKEET_DEVICE` | No | python-service | Local Parakeet torch device: `mps`, `cpu`, or `auto` |
| `VOICE_LOCAL_PARAKEET_PRELOAD_ENABLED` | No | python-service | Preload local Parakeet on service startup for faster first dictation |
| `VOICE_LOCAL_PARAKEET_COLD_START_BUDGET_SECONDS` | No | python-service | How long a dictation may wait for the local model to finish loading |
| `VOICE_LOCAL_PARAKEET_TIMEOUT_FALLBACK_ENABLED` | No | python-service | Set to `true` to fall back to OpenRouter when local Parakeet times out |
| `VOICE_LOCAL_PARAKEET_IDLE_UNLOAD_SECONDS` | No | python-service | Unload local Parakeet after this many idle seconds; `0` disables unloading |

See `.env.example` for copyable defaults.

## Security And Privacy

Jarvis is a local desktop assistant, but it can touch sensitive workflows. Before using it with personal data, review [SECURITY.md](./SECURITY.md).

Important points:

- The `fetch_url` tool is public-internet-only: DNS results and redirects to localhost, private, link-local, reserved, or other non-public addresses are blocked.
- Provider API keys are read from `.env` or the parent process environment and are never persisted in `electron-store`. Keep `.env` private; it is excluded by `.gitignore`.
- Browser Control uses a Jarvis-owned local browser window. It does not control the user's normal browser profile.
- `browser_evaluate` can run JavaScript inside the Jarvis-owned browser page. Treat it as a powerful debugging/recovery tool, not as a general-purpose sandbox.
- Voice dictation may capture nearby focused-field context for refinement and correction learning.
- macOS automation permissions are used for app focus, text insertion, and dictation workflows.

## Notes On Assets

The renderer uses system UI fonts plus a Google-hosted JetBrains Mono stylesheet. Unused local font bundles were removed to keep the repository small and avoid unnecessary font redistribution questions.

## Known Limitations

- The app is macOS-focused and depends on Electron/macOS APIs for tray, shortcuts, accessibility, and text insertion.
- Local Parakeet transcription defaults to the Hugging Face/NeMo `nvidia/parakeet-tdt_ctc-110m` model. On Apple Silicon it can use PyTorch MPS/Metal, and it unloads after an idle window to reduce Python memory pressure. It falls back to OpenRouter for local failures; timeout fallback is opt-in so cold starts do not silently become empty cloud transcriptions.
- Dependency warning cleanup is still worth a pass. Some lockfile warnings come from transitive packages owned by Electron/build tooling rather than direct dependencies.

## Architecture Highlights

- **Electron main process** owns provider orchestration, tool execution, storage, voice routing, and Browser Control.
- **Preload bridge** exposes narrow IPC methods with `contextIsolation` enabled and `nodeIntegration` disabled.
- **Renderer** stays focused on chat UI, conversation state, model selection, attachments, and dictionary management.
- **Python sidecar** remains mostly stateless: it transcribes/refines audio while Electron owns personalization, correction observation, and user-facing state.
- **ADRs and `CONTEXT.md`** document the main domain choices around voice personalization and browser control.

## License

Licensed under the [MIT License](./LICENSE).
