---
name: browserops_x_publish_blocked
description: "SOLVED 2026-07-07: X public post publishing works via synthetic
  ClipboardEvent paste into the Draft.js composer — CDP insertText/keystroke
  never enables the Post button, a dispatched paste event does. Trusted
  procedure: x.post_tweet."
type: reference
source: mcp-tool
created: 2026-07-07T14:18:42.842Z
updated: 2026-07-07T15:12:42.845Z
---

# X public publish — SOLVED (was: blocked)

Date: 2026-07-07 (same-day update of the earlier blocker entry)

## The fix

X's composer is Draft.js. CDP-trusted input (`Input.insertText`, per-char keystrokes) puts text in the DOM but never registers in Draft's editor state, so `tweetButton`/`tweetButtonInline` stays disabled. What DOES register: a **synthetic ClipboardEvent paste** dispatched from page JS:

```js
const editor = document.querySelector('[data-testid="tweetTextarea_0"]');
editor.focus();
const dt = new DataTransfer();
dt.setData("text/plain", text);
editor.dispatchEvent(
  new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
);
```

Draft.js handles `onPaste` from non-trusted events. Text lands in editor state, Post button enables, a trusted `browser_click` on `[data-testid="tweetButtonInline"]` publishes (fires `graphql/.../CreateTweet`).

## Gotchas learned

- After `execCommand('selectAll')+('delete')` clearing, re-read the editor node before pasting again and poll for state — an immediate second paste can silently no-op. Poll `textContent === text && !btn.disabled`.
- The Post button can briefly read `enabled` while the editor is empty (stale state). An empty-composer Post click no-ops (no CreateTweet) — safe, but don't trust button state alone.
- `browser_quick_read`'s `disabled_visual` heuristic reports `tweetButtonInline` as disabled even when DOM `disabled === false`. Trust the DOM property.
- The click's `effect.network.endpoints` list is capped (~5 entries); under home-timeline load CreateTweet gets crowded out → a `network_endpoint_seen: CreateTweet` expect false-negatives. Use `text_visible: /your post was sent/i` (the toast, live-polled) as the step expect; keep `with.expected.network_endpoint: CreateTweet` as the handler-side soft signal.
- Only ONE `role: button` named exactly `Post` exists on /home (the side-nav Post is `role: link`), so `{data_testid: tweetButtonInline, name: /^Post$/}` is unique. The `name` field must be present because the forbidden-guard conservatively refuses name-less locators against name-based deny rules.

## Artefact

Trusted procedure **`x.post_tweet`** (input: `text`; no backticks/`${` in text — it's injected into a JS template literal). Verified 3x consecutive strict runs + profile-visible tweets on @prthmo.
