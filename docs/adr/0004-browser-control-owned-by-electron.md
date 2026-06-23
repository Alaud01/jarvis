# Browser Control is owned by Electron

Jarvis will build Browser Control as an Electron/TypeScript orchestration layer with granular browser tools, rather than extending the Python browser-use sidecar as the primary control loop. The existing Python Browser Use Service remains as a legacy autonomous fallback while the replacement is built, because Codex-like browser behavior depends on the main assistant receiving page state, action results, screenshots, and recovery opportunities step by step.

Browser Control will expose deterministic browser tools before semantic Stagehand-style tools. Low-level actions such as opening pages, taking screenshots, clicking, typing, waiting, evaluating page state, and returning browser state form the recovery surface; semantic observe/act/extract helpers can then sit above that surface without becoming another opaque agent boundary.

Browser Control will keep one persistent local browser session by default, with explicit reset and new-context commands when isolation is needed. Persistence makes the browser a visible workspace that can preserve login state, current page state, tabs, and recovery context between assistant actions.

The initial runtime will be local Playwright/Chromium only. Browser Control should follow the Codex-like loop of small assistant-directed browser actions with fresh DOM, screenshot, or page-state feedback after each meaningful step. Stagehand-style semantic observe/act/extract helpers may be added above the Playwright surface later, but Browserbase or other paid hosted browser infrastructure is out of scope until there is a specific hosted-browser requirement.

The first implementation milestone is a minimal deterministic Browser Control loop that can open a page, report current state, capture a screenshot, click, type, wait, and evaluate diagnostic page state without invoking the legacy Python browser_task fallback. Each tool result should return enough state for the assistant to continue or recover, including the active URL, title, loading status, tab summary, visible text preview, optional screenshot artifact, and last action outcome.
