# Jarvis

macOS menu bar AI assistant with chat, voice input, web search, and browser automation.

## Stack

- **Electron** — Desktop shell (tray, windows, IPC)
- **React + TypeScript** — Chat UI
- **Vite + Tailwind CSS** — Renderer build
- **python-service** — Voice pipeline (VAD, OpenRouter STT and refinement)
- **browser-service** — Playwright + browser-use agent

## Structure

```
jarvis/
├── assets/              # Icons and fonts
├── browser-service/     # Browser automation sidecar (port 8001)
├── python-service/      # Voice flow sidecar (port 8765)
├── src/
│   ├── main/            # Electron main process
│   ├── preload/         # Secure IPC bridge
│   ├── renderer/        # React UI
│   └── shared/          # Shared types
├── package.json
└── vite.config.ts
```

## Setup

```bash
pnpm install
```

Set required environment variables (see Environment below).

## Development

```bash
pnpm dev              # Vite dev server + Electron
pnpm start:python     # Voice service only
pnpm start:browser    # Browser service only
pnpm start            # Production build in Electron
```

## Build

```bash
pnpm build
```

## Environment

| Variable | Service | Purpose |
|----------|---------|---------|
| `OPENROUTER_API_KEY` | python-service | Audio transcription and text refinement |
| `TAVILY_API_KEY` | main | Web search |

Voice hotkey: **Cmd+Shift+Space** (registered via Electron global shortcuts).

## Architecture

- **Main process** — Tray, providers (Ollama, OpenRouter, OpenCode Go), service orchestration
- **Renderer** — Chat UI with streaming, attachments, browser traces
- **python-service** — Spawned on app start for voice dictation
- **browser-service** — Spawned on first browser automation task
