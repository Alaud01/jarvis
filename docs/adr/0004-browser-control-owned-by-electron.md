# Browser Control is owned by Electron

Jarvis builds Browser Control as an Electron/TypeScript orchestration layer with granular browser tools, rather than extending the retired Python autonomous sidecar as the primary control loop. Codex-like browser behavior depends on the main assistant receiving page state, action results, screenshots, and recovery opportunities step by step.

Browser Control exposes deterministic browser tools before higher-level semantic helpers. Low-level actions such as opening pages, taking screenshots, clicking, typing, waiting, evaluating page state, and returning browser state form the recovery surface; semantic observe/act/extract helpers can then sit above that surface without becoming another opaque agent boundary.

Browser Control will keep a persistent local browser profile/session per conversation by default, with explicit reset and new-context commands when isolation is needed. Persistence lets Jarvis preserve login state and recovery context between assistant actions in one conversation without copying data from the user's personal browser profile or sharing page state with other conversations.

The initial runtime is local Chromium controlled from Electron. Browser Control should follow the Codex-like loop of small assistant-directed browser actions with fresh DOM, screenshot, or page-state feedback after each meaningful step. This can later move behind a Playwright adapter if the Electron webContents surface becomes limiting. Semantic observe/act/extract helpers may be added above the deterministic browser surface later, but Browserbase or other paid hosted browser infrastructure is out of scope until there is a specific hosted-browser requirement.

When the user needs their normal browser profile, Jarvis may hand a URL off to the operating-system default browser, but it must not claim to inspect or control that external browser. Controlling the user's personal browser profile would require broad OS/browser automation access and would blur privacy boundaries, so interactive Browser Control remains inside the Jarvis-owned local Chromium surface.

The first implementation milestone is a minimal deterministic Browser Control loop that can open a page, report current state, capture a screenshot, click, type, wait, and evaluate diagnostic page state without invoking a legacy autonomous fallback. Each tool result should return enough state for the assistant to continue or recover, including the active URL, title, loading status, tab summary, visible text preview, optional screenshot artifact, and last action outcome.

Clicking, typing, and dragging will use structured browser targets rather than raw selectors alone. Browser Control should resolve targets by accessibility role and name first, visible text second, CSS selector third, and coordinates only as a last resort; this keeps normal assistant actions aligned with what the user can see while still allowing deterministic recovery paths. Matched elements are scrolled into view before Browser Control computes action coordinates.

Browser Control windows open maximized to reduce avoidable scrolling, and a dedicated scroll tool handles long pages or scrollable regions where the assistant needs to inspect more content before choosing an action.

Screenshots are transient by default and persisted only when requested, useful for user-visible trace/debugging, or captured as a failure artifact. This lets the assistant use visual feedback during the active loop without turning every browser step into permanent conversation storage.

Each conversation gets its own Browser Control window. A window persists across normal assistant turns in that conversation so follow-up requests can inspect and continue from the current page, and it closes when the user stops that conversation's stream, when the app shuts down, or when an explicit future reset/new-context command is added.

Browser Control does not roll out in parallel with the legacy autonomous browser tool as a competing model choice. Milestone 1 removed that tool from the assistant tool list and system prompt in the same change that introduced the new Browser Control tools; the legacy Python sidecar is no longer part of the app pipeline.
