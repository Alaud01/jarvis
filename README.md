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

## Development

```bash
pnpm dev              # Vite dev server + Electron app
pnpm start:python     # Voice service only, default port 8765
pnpm start            # Compile, build renderer, and launch Electron
```

The voice service uses one canonical port: `VOICE_SERVICE_PORT`, defaulting to `8765`. Electron, `pnpm start:python`, and direct `python-service/main.py` startup all use that same default so the app does not depend on how the sidecar was started.

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

See `.env.example` for copyable defaults.

## Security And Privacy

Jarvis is a local desktop assistant, but it can touch sensitive workflows. Before using it with personal data, review [SECURITY.md](./SECURITY.md).

Important points:

- API keys are stored locally. OpenRouter and OpenCode Go keys saved through the UI currently use `electron-store`; this is convenient for development, but OS-backed secure storage would be stronger.
- Browser Control uses a Jarvis-owned local browser window. It does not control the user's normal browser profile.
- `browser_evaluate` can run JavaScript inside the Jarvis-owned browser page. Treat it as a powerful debugging/recovery tool, not as a general-purpose sandbox.
- Voice dictation may capture nearby focused-field context for refinement and correction learning.
- macOS automation permissions are used for app focus, text insertion, and dictation workflows.

## Notes On Assets

The renderer uses system UI fonts plus a Google-hosted JetBrains Mono stylesheet. Unused local font bundles were removed to keep the repository small and avoid unnecessary font redistribution questions.

## Known Limitations

- The app is macOS-focused and depends on Electron/macOS APIs for tray, shortcuts, accessibility, and text insertion.
- Some provider keys are stored in local app storage rather than the macOS Keychain.
- Local Parakeet transcription support is optional and still falls back to OpenRouter when cold, unavailable, or too slow.
- Dependency warning cleanup is still worth a pass. Some lockfile warnings come from transitive packages owned by Electron/build tooling rather than direct dependencies.

## Architecture Highlights

- **Electron main process** owns provider orchestration, tool execution, storage, voice routing, and Browser Control.
- **Preload bridge** exposes narrow IPC methods with `contextIsolation` enabled and `nodeIntegration` disabled.
- **Renderer** stays focused on chat UI, conversation state, model selection, attachments, and dictionary management.
- **Python sidecar** remains mostly stateless: it transcribes/refines audio while Electron owns personalization, correction observation, and user-facing state.
- **ADRs and `CONTEXT.md`** document the main domain choices around voice personalization and browser control.
