# Future plans — trusted-input follow-ups and architecture moves

A living roadmap of work surfaced by the browserevals comparison against
browser-harness. Captured here so the ideas survive the conversation that
produced them.

## Context

| Run | Connector | Success | Notes |
|---|---|---|---|
| Run 1 | 0.0.7 | 17/30 (57%) | pre-PR, synthetic-dispatch default |
| Run 2 | 0.0.9 | 22/30 (73%) | post-PR #6 (CDP-trusted input default) |
| Browser-harness baseline | n/a | 26/30 (~86%) | screenshot-driven, Python-script per-call |

PR #7 (`feat/trusted-input-long-tail`) adds: full key-event geometry,
two-stage hover, screenshot byte budget, auto-IIFE in execute_js, and
awaitPromise honoring. Hypothesized to land at 25-27/30 next run.

The remaining gap after PR #7 is **not** primitive-level. The surviving
failures are agent-loop timeouts: the agent's structural verification
signals (`page_effect` deltas) are too weak to decide "did my action
achieve the goal?", so it retries past the wall-clock cap.
Browser-harness avoids this with two structural choices — screenshot-
first verification, and Python-script per-call latency — that are
captured below as "Tier 4: architectural moves."

---

## Tier 1 — Quick wins already shipped

### A. Auto-IIFE wrap for `browser_execute_js`

When CDP `Runtime.evaluate` errors with "Illegal return statement", retry
the code wrapped in `(() => { ... })()`. Agents naturally write
`return value;` as if execute_js takes a function body; this absorbs it.

Tasks helped: e03 hn_show_top, e05 github_trending, h02 discord_codeblock,
and several gmail / linear reflections that all mention "needed to wrap in
IIFE".

### B. Honor `awaitPromise` in `browser_execute_js`

Set `awaitPromise: true` on `Runtime.evaluate`. Async IIFEs
(`(async () => { await ...; return v; })()`) now return the resolved
value instead of `{}` (Promise serialized empty).

Tasks helped: h02 explicitly ("async JS via execute_js returned empty {}
for return values from async IIFEs even with await_promise:true"), gdocs
save-state polling, plausibly several others.

---

## Tier 2 — Medium quick wins (next PR-sized chunks)

### C. Selector-scoped `browser_read`

Surface change: `browser_read({tab_id, selector?, mode})`. When
`selector` is supplied, return just the subtree.

Tasks helped: e05 (51k-char GitHub trending overflowed the read budget →
agent fell back to execute_js), h05 (Gmail compose section), e07
(OpenAI pricing table), m07 (Gmail search rows). At least 4 tasks where
the agent does a targeted scrape via execute_js because read is too
coarse.

Effort: ~40-60 lines + schema change in `packages/shared/src/tools.ts`.

### D. `<option>` text in `browser_quick_read`

a11y walker today skips `<option>` text (option elements aren't typically
focusable). e07 reflection: "browser_quick_read missed 'gpt-4o' on the
main page because it lives inside a `<select>`'s option text" → fell back
to `query_selector` + `execute_js`.

Effort: ~20 lines a11y walker patch.

---

## Tier 3 — Bigger targeted fixes (gate on next eval data)

### E. CDP keydown-stream mode for `cdpType` on canvas tabs

If gdocs typing (m12, m13, m14) stays broken after PR #7's key-event
geometry fix, the hypothesis is that Google Docs' canvas painter listens
to `keydown` events, not `beforeinput`. `Input.insertText` only fires
`beforeinput`. Add a per-character `Input.dispatchKeyEvent` mode to
`cdpType` that activates for canvas-detected tabs (the existing
`AUTO_CDP_DOMAINS` set in `cdp.ts`).

Effort: ~80 lines. **Gate:** next eval must confirm gdocs cluster stays
broken before committing.

### F. `browser_type` execCommand fallback inside the CDP path

h06 reflection (run 2): "browser_type modes produced zero DOM mutations
against Slack Quill even with CDP attached." Quill listens to
`beforeinput` and may `preventDefault` non-execCommand sources. The CDP-
first path should fall back to a content-script
`execCommand('insertText')` injection before returning
`WRITE_NOT_REFLECTED`. The synthetic path already does this.

Effort: ~50 lines. **Gate:** next eval must confirm Quill is still
ignoring CDP `Input.insertText` after PR #7.

---

## Tier 4 — Architectural moves (the real shape of the gap)

After PR #7, the 7 timeouts are agent loops, not silent tool failures.
Each architectural move below addresses one specific dimension of how
browser-harness structurally avoids these loops.

### Move 1 — Screenshot-first verification (auto-thumbnail in action results)

**The single highest-leverage change.** Have `browser_click`,
`browser_type`, `browser_press`, `browser_hover` return a small thumbnail
of the post-action viewport alongside `page_effect`. Default ~256-wide
JPEG, ~3KB. The agent's *next inference* sees both the structural and
visual state.

Why this matters: browser-harness's reliability comes from
`screenshot → look → click → screenshot`. Browserops's `page_effect` is
a numerical proxy that says "5 DOM mutations happened" — the agent can't
tell if that's their intended action or some unrelated mutation. With a
thumbnail in the result, the agent sees.

Expected impact: collapses the agent-loop timeouts (m01 slack-DM-
formatted, m09 linear-create, m12/13/14 gdocs typing, h01/07 notion).
Each of those is "agent did X, isn't sure if X worked, retried."

Effort: ~80 lines in `screenshot.ts` + `effects.ts` + the click/type/
press/hover handlers. Reuses the screenshot byte-budget logic from PR #7.

### Move 2 — Composite tools to cut round-trip count

Add `browser_act({tab_id, ops: [...]})` that runs a sequence of
primitives in one tool call and returns the combined result. Example:

```
browser_act({
  tab_id,
  ops: [
    {click: {ref: 5}},
    {wait_for: {text: "Sent"}, timeout_ms: 5000},
    {screenshot: {}}
  ]
})
```

One round-trip for a 5-step flow that today is 5 round-trips. Cost data:
browserops spent $22 for the 30-task suite where browser-harness spends
much less — per-call MCP overhead is the cause. This is what
browser-harness gets for free by being a Python script.

Effort: ~150-200 lines. Protocol-level work. Needs careful design around
error semantics in the middle of a sequence (abort vs. continue, partial
results).

### Move 3 — Shrink the tool surface

Today the agent picks between `browser_click(ref)`,
`browser_click_by_text(text)`, `browser_click_at(x, y)`,
`browser_quick_read + browser_click`, and
`browser_execute_js → element.click()`. Five paths to "click a thing."
Reflections show agents climbing the ladder rung-by-rung, burning calls.

Replace with one canonical primitive:

```
browser_click({tab_id, target: {ref?, text?, xy?}, button?, modifiers?})
browser_type({tab_id, target: {ref?, text?, xy?}, text})
```

Internal escalation handles the rungs. Reduces agent decision fatigue.

Effort: ~120 lines refactor. Old tools can alias to the canonical for a
deprecation window; no protocol break needed.

---

## Tier 5 — Deferred / out of scope

- **Linear listbox click no-op (m11)** — workaround works (type-to-filter
  + Enter). Investigation only, no shipping plan.
- **TrustedHTML on Gmail body** — known limitation; agents have a robust
  `execute_js` + `execCommand('insertText')` workaround.
- **Notion add-subpage / Linear create / Slack DM flows** — these belong
  in `browserops-teach` as named procedures, not in core tool surface.
- **Eval harness SIGTERM flush** — when the harness wall-clock-kills the
  agent, partial transcript is lost. Fix: SIGTERM, wait briefly for the
  agent to flush, then SIGKILL. Not browserops code — upstream eval
  harness change.
- **API-side eval verification** — current eval is agent-claimed. Real
  numbers need per-task API verification (did the Gmail message actually
  leave the outbox?). See EVALS.md §6.

---

## Honest qualifier on the 86% number

Both browser-harness's 86% and browserops's 73% are agent-claimed, not
API-verified. The `summary.md` from each eval run explicitly notes this.
The gap is real but the absolute numbers are upper bounds. A clean
comparison requires API-side verification (Tier 5 item).
