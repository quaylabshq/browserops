---
name: browserops_linkedin_send_message_flow
description: 'LinkedIn send-DM flow: verified locators + typeahead gotchas (4
  same-name strangers; anchor on "• 1st"), and the strict-mode runtime wall
  (single-shot locates race LinkedIn''s SPA render tails; REF_STALE after
  recipient pick). Draft procedure: linkedin.send_message.'
type: reference
source: mcp-tool
created: 2026-07-09T19:23:08.108Z
updated: 2026-07-09T19:23:08.108Z
---

# LinkedIn — send a DM (verified live 2026-07-10)

Draft procedure: `linkedin.send_message` (inputs: recipient full name, message).
Completed non-strict with `used_llm_fallback: false`, verify passed, message
ground-truthed in thread. Strict streak blocked by runtime gaps (below).

## Working locators (all resolve unique)

- Compose entry: `{role: button, name: "Compose a new message"}` (tier 2; no tier-1 attrs exist)
- Recipient typeahead: `{role: combobox, name: "Type a name or multiple names"}` — type with `mode: keystroke` (paste may skip typeahead)
- Suggestion: `{role: option, has_text: "<Full Name> • 1st"}` — MUST anchor on the degree badge
- Message box: `{aria_label: "Write a message…"}` (tier 1; note U+2026 ellipsis, not three dots)
- Send: `{role: button, name: "/^send$/i", near: {locator: {aria_label: "Write a message…"}, radius_px: 300}}`

## Gotchas

1. **Typeahead shows same-name strangers.** "Saket Aryan" surfaced FOUR people
   (one 1st-degree + three 3rd+). Unanchored `has_text: name` is a
   message-a-stranger hazard. Anchor `• 1st` in has_text AND add forbidden
   `{has_text: "/•\\s*(2nd|3rd)/"}` so a drifted resolve is refused at dispatch.
2. **Unanchored `name:` is substring match**: `name: "Send"` also matches
   "Open **send** options". Use `"/^send$/i"`.
3. **Compose pane is NOT an ARIA dialog** — `new_dialog` predicates never fire.
   Gate on `text_visible: "New message"` instead.
4. **Success signal**: conversation list renders `You: <message>` after send;
   send fires `voyagerMessagingDashMessengerMessages`. Substring verify can
   false-positive on older messages containing the same text — use a distinct
   message or check timestamps externally.
5. **Placeholder text is invisible to `browser_wait_for text:`** (input
   attribute, not DOM text). "Type a name" is not waitable.
6. **Entry after compose click**: SPA URL flips to `/messaging/thread/new/`,
   then `?isTYAHFlow=true` after picking a recipient; picking triggers an async
   composer re-render (thread history load) that kills cached refs.

## Runtime wall for strict mode (fingerprint, PR #24 testing 2026-07-10)

- Executor `tryStepOnce` does ONE prime read + ONE locate; `auto_wait.timeout_ms`
  is passed as the locate CALL timeout, not an actionability poll
  (execute.ts ~line 488). Schema documents auto_wait as "actionability poll caps".
- `strict: true` forces strategy "strict" on EVERY step (resolveStrategy),
  refusing even deterministic retry/relocate.
- Net effect: on churn-heavy SPAs (LinkedIn), strict runs fail
  non-deterministically at step boundaries — observed LOCATOR_NOT_FOUND on a
  combobox that resolves fine 2s later, and REF_STALE dispatching type after
  the recipient-pick re-render. Same YAML completes non-strict via ONE retry.
- Wanted runtime fixes: (a) honor auto_wait as re-prime+re-locate poll,
  (b) re-locate once on REF_STALE (deterministic, should be strict-legal),
  (c) expose browser_wait_for_idle as a step (`do: wait` + `quiet_ms`) for
  settle gates.
- Also: effect envelope `mutations`/`endpoints` often zero while page_effect
  shows real values → avoid `dom_added_min`/`mutations_at_least`-style
  predicates; `expected.value_contains` on browser_type crashed INTERNAL
  (null field_values) AFTER the text landed (side effect: double-typed text).
