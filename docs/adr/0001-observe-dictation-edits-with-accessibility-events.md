# Observe dictation edits with Accessibility events

Jarvis will replace timer-based snapshots of the entire focused field with an event-driven macOS Accessibility observer bound to the original element and inserted text span. An observation ends after the first meaningful edit, submission, focus change, or 30-second expiry; this added native integration complexity is accepted because polling cannot reliably distinguish delayed corrections from unrelated field changes.
