# Jarvis

Electron menu bar assistant powered by Ollama.

## Stack

- **Electron** - Desktop framework
- **React + TypeScript** - UI
- **Vite** - Build tool

## Structure

```
jarvis/
├── assets/              # Icons, images
├── src/
│   ├── main/           # Electron main process
│   │   └── index.ts
│   ├── preload/        # Secure bridge
│   │   └── index.ts
│   └── renderer/       # React UI
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       └── styles/
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Setup

```bash
cd jarvis
npm install
```

## Development

```bash
npm run dev    # Start Vite dev server
npm start      # Launch Electron
```

## Build

```bash
npm run build
```

## Architecture

- **Main process** (Node.js): Tray icon, window management, system integration
- **Renderer process** (React): Chat UI
- **Preload**: Secure bridge exposing APIs to renderer

## Next Steps

1. Add icon to `assets/icon.png` (16x16 or larger PNG)
2. Implement Ollama API integration in `ChatWindow.tsx`
3. Add streaming response support
4. Implement conversation history