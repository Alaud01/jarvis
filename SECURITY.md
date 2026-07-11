# Security And Privacy Notes

Jarvis is a local macOS desktop assistant. It is designed for personal productivity, but it has capabilities that can interact with sensitive user data, so users should understand the boundaries before running it.

## Local Data

Conversations, drafts, selected models, and dictionary entries are stored locally through Electron storage. The repository does not intentionally send this local state anywhere except when the user invokes a model/provider or tool that needs relevant context.

Provider credentials are read only from `.env` or the parent process environment. Jarvis does not expose credential storage through renderer IPC and removes legacy OpenRouter and OpenCode Go keys from its Electron store during startup. The `.env` file is intentionally excluded from Git; users should still protect it as a plaintext local configuration file.

## External Services

Depending on configuration, Jarvis may send requests to:

- OpenRouter for hosted chat, transcription, and transcript refinement
- OpenCode Go for hosted model access
- Tavily for web search
- Notion for workspace search, database queries, page creation, and block appends
- Ollama for local or optional cloud model access

Only configure provider keys for services you intend to use.

The `fetch_url` assistant tool is restricted to the public internet. It rejects localhost,
private, link-local, reserved, and other non-public IP ranges after DNS resolution, and it
repeats that validation for every redirect. Browser Control is the separate interactive
workspace; neither capability is intended to provide unattended access to local-network
services.

## Voice Dictation

Voice recordings are sent to the local Python sidecar. When cloud transcription/refinement is enabled, audio or transcript text may be sent to OpenRouter. Jarvis may also capture bounded nearby focused-field context to improve transcript routing and correction quality.

Personal dictionary entries, replacement rules, and correction observations are stored locally so dictation can adapt over time.

## Browser Control

Browser Control opens and drives a Jarvis-owned browser window. It is separate from the user's default browser profile, so Jarvis should not claim to inspect or control pages opened in the user's normal browser.

The `browser_evaluate` tool can execute JavaScript in the Jarvis-owned browser page. This is useful for diagnostics and recovery, but it is powerful. Treat Browser Control as trusted local automation, and do not run it against pages where executing assistant-provided scripts would be inappropriate.

## macOS Permissions

Jarvis may request microphone, accessibility, and automation-related permissions. These support voice capture, app focus detection, text insertion, and workflow automation. If you do not need voice dictation or cross-app insertion, you can avoid granting the related permissions.

## Logging

Routine diagnostic logs are quiet by default. Set `JARVIS_LOG_LEVEL=debug` when you need detailed traces for voice routing, provider streams, or Python sidecar startup.
