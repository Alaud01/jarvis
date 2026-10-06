# Persistence and execution limits

## Conversation persistence

The renderer coalesces snapshots for 400 ms. A revision is acknowledged only after
the main process confirms a successful write. Failed writes remain pending and
retry without another edit, with exponential backoff from one to thirty seconds.
New edits replace the pending snapshot; an older in-flight write cannot acknowledge
a newer revision. Dirty conversations stay loaded until their pending save finishes.
Immutable conversation objects cache their revision hashes, so streaming does not
repeatedly scan unchanged background histories or their attachments.

The initial transcript is saved when generation starts, and the completed or stopped
transcript is saved when streaming finishes. Intermediate tokens are not continuously
written to disk. Normal quit captures the latest rendered transcript, including a
partial streaming response, and flushes queued snapshots before shutting down services;
the renderer has ten seconds to acknowledge, and main-process storage has ten seconds
to drain. A failure opens a native Retry / Cancel / Quit Anyway dialog, with Cancel
as the default. Retry repeats saving; Cancel leaves Jarvis running. Quit Anyway
aborts streams and attempts pending main-process writes and service cleanup in
parallel for up to ten seconds, then exits without another renderer acknowledgement.
SIGINT/SIGTERM use that same bounded cleanup without a dialog and can interrupt an
existing save attempt or dismiss an open quit dialog. Service cleanup has a ten-second
deadline even after a successful save. Forced exit and process crashes cannot guarantee
preservation of unsaved changes or the latest streamed tokens.

Conversation files retain the existing JSON format, including archived branches.
The main process serializes conversation operations through one asynchronous queue.
Writes use a temporary file, file sync, and atomic rename. The previous validated
snapshot is retained as `.json.bak`. If a primary file is invalid, Jarvis restores the
backup and preserves the damaged primary as `.json.corrupt-<id>`. Unrecoverable or
missing histories produce a load error, rather than an empty transcript that could
overwrite the original. Deletion moves conversations into Recently Deleted rather
than removing transcript files. Metadata-list edits do not delete transcript files;
persistent deletion markers reject late snapshots even after restarting Jarvis.

Backups use additional disk space and recover the previous snapshot, not necessarily
the latest response. These files are local plaintext, like the existing conversation
store. The metadata index and transcript are separate files, not a multi-file database
transaction.

## Recently Deleted

The sidebar's Recently Deleted section retains deleted conversations for 30 days
from deletion (30 times 24 hours). It shows the remaining time and offers Restore
or Delete permanently, with confirmation before permanent deletion. Deleted chats
are excluded from the active conversation list, search, and model context.

Deleting a folder also moves its conversations, including pinned conversations, to
Recently Deleted. The folder itself is not retained. Restoring a conversation keeps
its messages, attachments, message versions, title, and pin state. It returns to its
original folder if that folder still exists, otherwise to the root conversation list.
Unsent composer drafts are not part of the retained transcript. Conversations with
an active response must be stopped before deletion; pending transcript saves are
flushed before the deletion is committed.

Expiry is checked at startup, every minute while Jarvis is running, and during
conversation storage operations. An expired conversation cannot be restored. If
Jarvis is closed or the computer is asleep at the deadline, physical removal occurs
when Jarvis next runs. Failed file removals are retried without blocking other chats.
Permanent removal deletes the transcript, backup, and quarantined recovery copies;
external backups and original attached files elsewhere on disk are not removed.

Deletion intent is persisted before removing a conversation from the active index.
Restore writes a new durable copy before retiring the deleted copy, using a new
internal ID so a delayed save cannot overwrite recovered content. Content-free ID
markers remain after permanent deletion to reject stale writes across restarts.
If a deletion reports an error after committing its marker, the renderer reconciles
against the active storage index before allowing further edits. If that index cannot
be read, editing is blocked until restart so new messages are not silently lost.
Private provider thread state is cleaned up on initial deletion and recreated from
the restored transcript when needed.

This retention applies to deletions made with this version. It cannot recover
conversations permanently deleted by older versions.

## Model discovery

Chat reads model metadata from the selected provider's cached catalog without waiting
for discovery. The picker also reads snapshots immediately and receives incremental
IPC updates as each source finishes. Available models stay selectable while other
sources load. Revision numbers prevent older invoke responses from replacing newer
events; incremental updates preserve the user's current selection.

Ollama local and cloud discovery run independently with separate caches, abort signals,
and five-second deadlines. A cloud timeout cannot discard successful local results,
including on a cold cache. Sources refresh when stale after five minutes; failures
retain their own last usable list and back off for thirty seconds. Ordinary catalog
reads respect TTL/backoff; an explicit refresh can bypass them. Concurrent refreshes
share pending requests. Late results after a deadline or catalog reset cannot replace
current results. A successful empty Ollama source removes its previous models; legacy
providers that return an empty list on failure retain their last usable catalog.

Ollama and OpenRouter chat/model discovery registration are temporarily commented out.
The discovery behavior above applies when Ollama is registered. OpenRouter remains
available for optional voice text refinement; transcription runs locally. OpenCode Go
bounds optional models.dev reasoning discovery to one second and uses bundled metadata
when it is unavailable, preserving the provider model-list deadline.

On a cold cache or for models without context metadata, context compaction retains its
existing default context-length estimate until metadata becomes available. Model IDs
are resolved within their provider so two providers cannot supply each other's limits.

## Voice worker

Both voice endpoints admit one pipeline at a time onto a dedicated worker thread.
Health checks stay on the event loop. Additional dictations receive HTTP 429 with
`Retry-After: 1` rather than accumulating audio in an unbounded work queue. The worker
owns the upload until the pipeline finishes, including when the request is canceled.
Local inference and idle unloading share a lock; a recently used model is rechecked
before unloading.

Transcription uses local MLX Whisper Turbo on Apple Silicon. Model loading, inference,
and unloading share the same persistent worker thread. Model-load and inference errors
surface locally; there is no hosted transcription fallback. Optional OpenRouter text
refinement retains its conservative spoken-revision fallback. Vocabulary Guidance,
Replacement Rules, and correction observations are suspended, with saved entries kept
for future reactivation as described in ADR 0009. Native model inference remains
noninterruptible.

Electron starts microphone setup and target-app detection concurrently. Stopping a
dictation stops audio capture while the remaining context lookup finishes; upload
waits for both results. Open-lid capture relies on `getUserMedia` for missing-device
errors, while closed-lid capture checks the default microphone before opening it.
The audio-worklet module URL is cached per renderer and loaded into each new audio
context. Existing request IDs tie finer microphone timings to service and delivery
measurements.

On macOS, the click-through overlay is preloaded and kept shown with fully transparent
idle content. Dismissal stops painting and spinner animation; the next recording
reveals the same renderer. A window hidden externally or a failed renderer is replaced.
The overlay stays off Mission Control and shows Starting microphone before capture is
ready. Faster transitions retain the existing styles and reduced-motion behavior.

## Tool turns

A native provider turn permits twelve model rounds and thirty-two total attempted tool
calls. Invalid calls and calls rejected by individual tool limits count toward the
aggregate budget. At exhaustion, Jarvis makes at most one additional tools-disabled
synthesis request using the results already gathered. Unexpected tool calls in that
final response are not executed.

Codex owns its internal model loop through app-server. Its Jarvis dynamic-tool callbacks
share the thirty-two-call budget; an additional call interrupts the turn and appends a
limit notice while preserving already streamed text. Jarvis does not start a separate
replacement model turn, consistent with ADR 0007. Codex-native capabilities are outside
the Jarvis callback counter.

All providers have a fifteen-minute overall turn deadline. Cancellation is checked
between rounds and tool operations, and is passed through search, fetch, compaction,
and provider requests. Cancellation stops further dispatch; it does not undo an
external write that already completed.

## Documentation review

The persistence and execution changes preserve the existing domain boundaries in
`CONTEXT-MAP.md` and the dynamic-tool bridge in ADR 0007. The file format, retry policy,
cache TTL, and execution budgets remain reversible implementation choices. ADR 0009
records the Whisper runtime change and suspension of personalization; `CONTEXT.md`
retains the personalization domain model for future reactivation.

Regression tests exercise failed saves, edits during in-flight saves, deletion ordering,
corruption recovery, provider-isolated metadata, independent discovery and cold-cache
cloud stalls, quit retry/cancel/force paths and signal escalation, voice admission and
cancellation, tool exhaustion, and stalled-turn interruption.
