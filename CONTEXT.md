> Current voice runtime: Whisper large-v3-turbo on Apple MLX. Personal Dictionary, Vocabulary Guidance,
> Replacement Rules, and Observation Sessions are suspended for dictation. The domain model below is retained
> for future reactivation; saved entries remain stored. See [the Whisper runtime decision](docs/adr/0009-use-mlx-whisper-turbo-without-personalization.md).

# Voice Personalization

This context describes how Jarvis adapts voice transcription to a user's vocabulary without treating every text edit as a reusable correction.

## Language

**Vocabulary Entry**:
A preferred name, acronym, brand, technical term, or short proper-noun phrase that Jarvis should recognize as part of the user's vocabulary.
_Avoid_: Dictionary rule, correction

**Vocabulary Guidance**:
A reversible preference that makes a Vocabulary Entry more likely during speech recognition without forcing the output.
_Avoid_: Replacement, correction rule

**Replacement Rule**:
A mapping from one known recurring mishearing to its preferred text.
_Avoid_: Vocabulary entry, model training

**Rule Application**:
An instance where Jarvis used a Replacement Rule to alter dictated text.
_Avoid_: Correction observation, vocabulary guidance

**Application Context Window**:
The nearby dictated text around a Rule Application that helps identify the same applied change after later edits.
_Avoid_: Rule scope, observed app

**App Context**:
The frontmost application identity available during a Dictation.
_Avoid_: Application Context Window, Rule Scope

**Rule Rejection**:
Evidence that the user rejected the output of a Rule Application by reverting it or replacing it with different text.
_Avoid_: Inverse correction, new replacement rule

**Rule Suspension**:
The inactive state of an automatic Replacement Rule after a Rule Rejection.
_Avoid_: Deletion, manual override

**Rule Scope**:
The set of application contexts in which a Replacement Rule is valid.
_Avoid_: Observed app, vocabulary ownership

**Correction Observation**:
Evidence that a user changed recently dictated text, without implying that the change should be learned.
_Avoid_: Learned correction, replacement rule

**Classification Reason**:
The explanation for why a Correction Observation or Vocabulary Candidate is eligible, ambiguous, or ineligible.
_Avoid_: Confidence score, learned rule

**Vocabulary Candidate**:
A proposed Vocabulary Entry derived from a Correction Observation and awaiting an eligibility decision.
_Avoid_: Vocabulary entry, replacement rule

**Manual Vocabulary Addition**:
A user-created Vocabulary Entry that does not depend on a Correction Observation.
_Avoid_: Replacement rule, learned correction

**Personal Dictionary**:
The user's place to manage Vocabulary Entries, Replacement Rules, and Vocabulary Candidates.
_Avoid_: Replacement-rule list, vocabulary-only list

**Dictation**:
One voice recording and its resulting text insertion.
_Avoid_: Observation, transcript fragment

**Observation Session**:
The bounded opportunity after a Dictation during which one subsequent edit may become a Correction Observation.
_Avoid_: Polling window, edit history

**Browser Control**:
Jarvis capability for using a web browser as an interactive workspace under assistant direction.
_Avoid_: autonomous browser sidecar, browser task

## Relationships

- A **Vocabulary Entry** may exist without a **Replacement Rule**
- A **Vocabulary Entry** belongs to the user globally, while its priority may vary by application context
- A **Dictation** may carry **App Context**
- A **Manual Vocabulary Addition** activates **Vocabulary Guidance** without creating a **Replacement Rule**
- **Vocabulary Guidance** uses active **Vocabulary Entries** selected by relevance
- One high-confidence **Correction Observation** may activate **Vocabulary Guidance** for an eligible **Vocabulary Entry**
- A **Replacement Rule** maps one mishearing to exactly one **Vocabulary Entry** within one **Rule Scope**
- A **Replacement Rule** is applied after recognition and is not used as **Vocabulary Guidance**
- A safe unambiguous **Replacement Rule** may have a global **Rule Scope**
- A **Replacement Rule** whose source is a valid common word requires explicit approval and an application-specific **Rule Scope**
- A **Rule Application** is attributable to exactly one **Replacement Rule**
- A **Rule Application** includes an **Application Context Window**
- A **Rule Rejection** is evidence against the applied **Replacement Rule**, not evidence for an inverse **Replacement Rule**
- A **Rule Rejection** suspends an automatic **Replacement Rule**
- A **Rule Rejection** records conflict evidence for a manually approved **Replacement Rule** without suspending it automatically
- A **Correction Observation** may suggest a **Vocabulary Entry** or provide evidence for a **Replacement Rule**
- A **Correction Observation** may carry **Classification Reasons**
- A **Correction Observation** is retained only while it remains useful for learning, review, or explanation
- A **Vocabulary Candidate** may carry **Classification Reasons**
- An eligible **Vocabulary Candidate** activates **Vocabulary Guidance** automatically
- An ambiguous **Vocabulary Candidate** requires explicit confirmation
- An ineligible **Vocabulary Candidate** is discarded
- The **Personal Dictionary** presents **Vocabulary Entries**, **Replacement Rules**, and ambiguous **Vocabulary Candidates** without treating them as the same thing
- A **Dictation** opens at most one **Observation Session**
- An **Observation Session** ends after its first meaningful edit, submission, focus change, or expiry
- An automatic **Replacement Rule** requires matching **Correction Observations** from two distinct **Dictations**
- A valid common word cannot become the source of an automatic **Replacement Rule** without explicit approval
- Conflicting or inverse mappings cannot become automatic **Replacement Rules**
- Common-word substitutions and sentence-level edits are not **Vocabulary Entries**

## Example dialogue

> **Dev:** "The user changed `cloud` to `Claude`; should that immediately become a **Replacement Rule**?"
> **Domain expert:** "No. Record a **Correction Observation** and use `Claude` as **Vocabulary Guidance**. `cloud` only becomes its **Replacement Rule** after we know that mishearing recurs."

## Flagged ambiguities

- "Dictionary entry" previously meant both recognition vocabulary and deterministic replacement; these are now distinct concepts.
- "Correction" does not include ordinary rewrites for automatic learning; common-word and sentence-level changes require manual entry.
- "Observed app" is evidence about where vocabulary appears, not ownership of the Vocabulary Entry.
- The retired autonomous browser sidecar previously shared terminology with **Browser Control**; the product capability is now **Browser Control**.

# Conversation versions

Editing and resubmitting a user message creates a sibling version. The original message and its entire continuation remain available through the version controls beneath the message. Regenerating an assistant response creates a sibling answer in the same way. An unchanged edit does not create a version.

A conversation stores one active transcript plus archived message nodes, parent links, and remembered child selections. Shared prefixes are stored once. Switching a version restores that branch's most recently selected continuation, including nested edits and subsequent replies. Only the active transcript is rendered, searched, or sent to a model. Existing conversations need no migration; branch data is added on the first edit or regeneration.

Version changes are disabled while the conversation is streaming. Errors and stopped responses remain on their branch, leaving previous versions accessible. Branch context keys invalidate the Codex provider's private history when switching branches, including branches with identical user text but different assistant answers. Conversation serialization and cache eviction preserve branch data on disk and release archived nodes from memory when evicting a conversation.
