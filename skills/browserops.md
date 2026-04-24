---
name: browserops
description: >
  Operating guide for the browserops MCP server (drives the user's live Chrome
  profile via a companion extension). Use this skill any time a task involves
  clicking, typing, reading, navigating, or scripting a real browser tab,
  or authoring/debugging a browserops procedure. Covers the full `browser_*`
  and `procedures_*` tool surface, the observation-centric execution model
  (page_effect), trusted vs synthetic dispatch, sub-agent delegation rules,
  and the common failure modes that produce silent successes. TRIGGER when:
  the user asks to "open slack / gmail / notion / <website>", "fill in /
  click / submit <something in the browser>", "navigate to <url>", "run /
  save / edit a procedure", "why did <browser action> silently fail", or
  names an MCP tool beginning with `browser_` or `procedures_`. DO NOT
  TRIGGER for: pure Playwright/Puppeteer work in a headless context,
  scripted browser automation outside the user's real profile, or MCP
  servers unrelated to browserops.
metadata:
  category: browser-automation
  tags: "browserops, mcp, chrome-extension, procedures, effect-observation"
---

# browserops

One skill, one goal: help an agent drive the user's live Chrome reliably through the browserops MCP server, without silent successes or procedure-authoring mistakes.

This file is the index. Read it top-to-bottom the first time you're about to call a `browser_*` or `procedures_*` tool; after that, jump to the section that matches your failure mode.

---

## 1. Mental model (read once)

**The server does not interpret the page.** It dispatches actions (click, type, press, navigate) and, as of Phase 1 of the observation-centric architecture, observes *measurable* page effects (DOM mutations, URL change, focus change, network activity) in a 300 ms window after each action.

- Dispatch fields (`clicked:true`, `typed:N`) are **self-reports**. They say "the event was sent", not "the page did the thing."
- `page_effect` is the **ground truth**. Treat an action with zero effect (`dom.added=0, removed=0, text_changes=0, network.requests_started=0`) on something that should have changed state as a silent-success bug. Retry, escalate, or fail loud — don't assume.

You cannot know from inside the agent how any given site will react to a synthetic event. You *can* read what actually happened. Lead with observation, not assumption.

**Trusted vs synthetic.** The extension defaults to synthetic events (`dispatchEvent`). Some sites (Slack, Figma, Gmail composer, Google Docs canvas, WhatsApp Web, ChatGPT, Claude, Discord, etc.) ignore non-`isTrusted` events. The SITE_REGISTRY at `packages/shared/src/editors.ts` forces trusted-mode dispatch (via CDP) for known hostnames. Bridge-side observation hints can *also* escalate a host to trusted based on empirical effect rates. You don't configure this — just know that you get it for free on known sites, and that unknown sites may need one retry with `mode:"trusted"` if the first attempt has zero effect.

---

## 2. Pre-flight — do these first, in order

1. **Search procedures.** Call `procedures_search` with tokens from the user's ask. If score ≥ 0.5, use that procedure; don't re-plan steps already encoded.
2. **Find the tab. Stay autonomous — don't stop to ask if you can recover yourself.**
   - `browser_pinned_tab` first. That is the user's explicit "work here" tab.
   - `NO_PINNED_TAB` → fall through silently: try `browser_current_tab`; if that also returns nothing usable, call `browser_new_tab` and proceed on the fresh tab.
   - Only surface the "click 'Use this tab' in the popup" suggestion to the user if *every* fallback above has failed (no current tab, new-tab creation denied, etc.) — not as the first move.
   - For cross-tab work, `browser_list_tabs` and pick explicitly by title/url.
3. **Decompose → list → delegate (default).** Before calling any tool, break the user's request into a flat list of concrete subtasks and record it with your task-tracking primitive (e.g. `TaskCreate`). Then run each subtask in its own sub-agent. The main context stays an orchestrator; it does not accumulate page dumps, screenshots, or intermediate tool results, and it cannot lose sight of the overall goal because the list is the source of truth.

   **Write delegation into the list text.** Every non-trivial list item must be phrased as an instruction to *spawn a sub-agent*, not just a task description. This is a forcing function — agents that write "Send DM to Kartik" frequently forget to delegate and do it inline; agents that write "Spawn sub-agent to send DM to Kartik" don't. Good vs. bad:
   - ❌ `2. Search for Kartik in Slack sidebar`
   - ✅ `2. Spawn sub-agent (haiku) — search for Kartik in Slack sidebar, return matching DM tab_id or "not found"`

   - **Trivial single primitive** (one `browser_navigate`, one `browser_read`, one quick factual read): run directly, no list needed.
   - **Anything else** — multi-step flows, anything likely to need retries (`REF_STALE`, occluded clicks, `wait_for` loops), any composite procedure: one sub-agent per subtask. Brief = procedure name + inputs + tab_id (or, for ad-hoc work, the specific primitive sequence for *that subtask only*). **Never inline procedure steps** — the sub-agent calls `procedures_get` itself. **Never batch two subtasks into one brief** — that defeats the isolation and recreates main-context bloat inside the subagent.

   **Recursive decomposition.** A subtask can itself be complex enough to warrant its own decomposition. When the sub-agent receives a brief it considers compound, it applies this same rule inside its own context: decompose into a child list, spawn child sub-agents, and roll results back up. Only the final ≤ 5-line summary returns to the parent. Depth is not capped; use judgement — most flows bottom out at depth 2 (root → subtask-list → per-subtask sub-agent), some at depth 3 when a subtask is itself a multi-site workflow.

   - After each sub-agent returns, update the list (mark the subtask done, adjust the next one based on what was observed), then dispatch the next. The sub-agent should report in ≤ 5 lines: what it did, pass/fail gate (`page_effect`-based where applicable), tool result summary. Nothing else.
   - Pick the model per subtask: haiku for mechanical single-tool-call or fill-and-submit steps; sonnet when the subtask needs multi-step retry logic or non-trivial decisions.
4. **Thread the tab_id** through every subsequent call. Don't re-resolve it per step.

---

## 3. The observation contract (new — most agents miss this)

Every mutating tool (`browser_click`, `browser_type`, `browser_press`, `browser_navigate`) returns a `page_effect` object. Shape:

```ts
{
  dom:   { added, removed, attr_changes, text_changes },
  url:   { changed, before?, after? },
  focus: { changed, before_selector?, after_selector? },
  network: { requests_started, requests_completed, in_flight_at_end },
  console_errors,
  window_ms,
  truncated?
}
```

### How to use it

- **Confirm state changes.** If you clicked "Send" and expected a network call, require `network.requests_started ≥ 1`. If the effect is all zeros, the click was absorbed — the common culprits are occlusion, the element being off-screen, or a synthetic event on a site that requires trusted.
- **Confirm typing.** If you typed 8 chars and `dom.text_changes = 0`, the field didn't receive your input. The extension itself will usually throw `WRITE_NOT_REFLECTED` for this, but when it doesn't, `page_effect` is how you catch it.
- **Navigation settled.** After `browser_navigate`, a `url.changed:true` + non-zero `dom.added` is the minimum signal the page actually moved. An SPA that swaps history without mounting new DOM may return `url.changed:true` with `dom.added=0` — that means you're early; follow with `browser_wait_for` on a stable element, not URL alone.
- **Pass `observe_effects: false`** on a hot loop of known-no-effect calls (rare) to shave ~330 ms per call.
- **Pass `expect_effect`** to have the extension itself warn when observation diverges from expectation. For procedures, express this as an `expected_effect` field on the step (see Section 7).

### Silent-success patterns to catch with `page_effect`

| Symptom | Signal |
|---|---|
| Clicked, nothing happened | `dom.*` and `network.*` all zero after click on something that should have mutated state |
| Typed, nothing appeared | `dom.text_changes = 0` and `focus.before_selector == focus.after_selector` |
| Send button ignored | `network.requests_started = 0` after clicking a submit/send |
| Modal didn't dismiss | `dom.removed = 0` after clicking "close" / pressing Escape |

---

## 4. Tool cookbook

### `browser_click`

**Click escalation ladder** (try in order, stop at the first one whose `page_effect` shows the intended effect):

1. **`browser_click` with a ref** from `browser_read`. Default; cheapest; most addressable.
2. **`browser_click` with `dismiss_overlay: true`** if (1) returns `{clicked:false, occluded:true, suggestion:"dismiss_overlay"}`, or if (1) has `clicked:true` but zero `page_effect`.
3. **`browser_click_by_text`** with the visible label, for `div`-with-onclick targets that never surface as a ref.
4. **`browser_click_at` (coordinate click)** — the last resort, and genuinely useful on complex SPAs (Instagram, TikTok, some retail checkouts) where (1–3) all fail because the clickable surface is a gesture handler on a parent div, shadow DOM, or canvas. Pass viewport coordinates from `browser_read` or a visible-rect query. Do not guess pixels.

**Coordinate clicks are underused but unreliable. The rule is: always verify with `page_effect` immediately.** A ref-based click that returns `clicked:true` is usually true; a coordinate click that returns `clicked:true` tells you only that a mouse event was dispatched at that point — it could have landed on the parent container, on a sibling overlay that just appeared, or on dead space within a flex gap. Zero `page_effect` after a `browser_click_at` means the click landed somewhere harmless; treat it as a failure even though the return said `clicked:true`. Retry with adjusted coordinates, or fall back to `click_by_text`.

**Other rules**

- `REF_STALE` → `browser_read` the container again, retry with the fresh ref. Do not `dismiss_overlay` for this error.
- On Slack / Figma / Docs / Sheets / Canva / Miro / Whimsical the registry auto-forces trusted click mode. You don't need to do anything; just don't manually downgrade.
- If you climb the ladder to step 4 for a given site, consider saving the recipe as a procedure (`procedures_save`) so the next agent doesn't repeat the escalation from scratch.

### `browser_type`

- **To overwrite a field, use `clear_mode: "auto"`** — not a two-step clear-then-type chord. `auto` picks the fastest safe strategy per element type, verifies emptiness, and falls back to keyboard Delete for rich editors that ignore execCommand.
- **Never force `mode: "trusted"` on Quill / ProseMirror / Slate.** The registry handles these; manually passing trusted re-introduces the 2× doubling bug (framework's beforeinput + CDP char event both insert).
- `WRITE_NOT_REFLECTED` — the dispatch was ignored. Usually an overlay, a non-editable focused element, or the editor hadn't mounted. Dismiss/wait and retry. Do not treat this as "probably fine."
- `WRITE_AMPLIFIED` — the framework inserted ≥ 2× your text. File a bug in the editor registry; do not silently retry (you'll append more garbage).
- For secrets, assume the typed text is logged in traces (`BROWSEROPS_TRACE=1`). If the user cares about redaction, warn them before typing.

### `browser_press`

- **Always use `Primary`, never `Meta` or `Control`.** The extension resolves Primary → Meta on macOS, Control on Windows/Linux.
- **Destructive chords are refused server-side**: `Primary+W`, `Primary+Q`, `Primary+Shift+W`, `Alt+F4`, `Primary+T`, `Primary+N`, `Primary+Shift+N`. Don't try to route around; ask the user if you really need this.
- `Enter` / `Escape` / `Tab` on rich editors are automatically escalated to the trusted CDP path on registered sites. Synthetic-only sites can still drop them — if your Enter does nothing on an unknown site, retry once through the trusted path (or use the relevant procedure primitive that forces it).

Common chord recipes:

| Intent | `keys:` |
|---|---|
| Select all | `["Primary", "KeyA"]` |
| Copy / paste / cut | `["Primary", "KeyC"]` / `["Primary", "KeyV"]` / `["Primary", "KeyX"]` |
| Undo / redo | `["Primary", "KeyZ"]` / `["Primary", "Shift", "KeyZ"]` |
| Submit form | `["Enter"]` |
| Dismiss modal | `["Escape"]` |
| Next field | `["Tab"]` |
| Delete one char / forward | `["Backspace"]` / `["Delete"]` |
| Clear field (keyboard path) | `["Primary","KeyA"]` then `["Delete"]` — but prefer `browser_type` with `clear_mode:"auto"` |

### `browser_navigate`

- After navigating, **do not trust `url.changed` alone** as "the page is ready". SPAs swap history before the target route mounts. Follow with `browser_wait_for` matching a stable element (a heading, a known ref pattern), not a URL substring.
- On initial load, `page_effect.dom.added` should be substantial (usually > 50). If it's near zero, the page is still loading — wait.
- **Never use `browser_reload` as a polling loop.** It fires once. Use `browser_wait_for` / `browser_wait_for_idle` with an explicit timeout.

### `browser_read`

- Cheap and safe. Call it whenever you're about to re-click after `REF_STALE`, or before guessing a selector.
- Prefer reading over `browser_execute_js` for addressable UI. JS is a last resort because it bypasses the observation/effect layer — you won't get `page_effect` for the side effects of raw JS.

### `browser_execute_js`

- Last resort. Explicitly flagged as risky; may prompt the user.
- Keep the script narrow — tied to one page state, no loops, no network I/O.
- Never use JS to synthesize a click on a rich editor; use `browser_click` with a ref.
- Do not use JS to read secrets from the page; that's a trust violation even if the user consented.

### `browser_wait_for` / `browser_wait_for_idle`

- Every async step must have one of these with an explicit `timeout_ms`.
- `wait_for` against a **stable DOM marker** is far more reliable than against URL or `document.title`.
- Do not screenshot to "verify" a step that already has a `wait_for`. Screenshots are for failure inspection, not success confirmation.

### `browser_screenshot`

- Only on unexpected error or when the user explicitly asks. Not a verification tool.

### `procedures_search` / `procedures_get`

- Always before planning a flow. A composite procedure covers the whole flow in one `procedures_get`; don't re-plan its steps, just call the primitives it lists.
- If you find yourself writing a 15-step plan from scratch for a common flow, stop and search again — you probably missed an existing procedure.

### `procedures_save` / `procedures_promote` / `procedures_delete`

- **Never save an untested procedure.** Run it end-to-end in the session, fix what breaks, then save.
- A procedure is trusted only once `success_count ≥ 1` *and* the live UI still matches.
- `procedures_promote` moves a session-scoped procedure to the user's library — only promote after you've observed it succeed on the actual target site.

### `procedures_compile` (recording → procedure)

- Best tool for codifying a flow you just did by hand. With `BROWSEROPS_TRACE=1` set on the bridge, every successful run produces a JSONL trace at `~/browserops/traces/`. Pass the trace id to `procedures_compile` and it emits a candidate YAML — review, tune, `procedures_save`.
- The compiler derives loose `expected_effect` assertions from observed effects. Tighten or relax these by hand before saving if the defaults are too strict/loose.

### `procedures_execute`

- Replays a saved procedure step-by-step, checking expected effects at each step. Halts on divergence. Use when reproducing a flaky flow for debugging, or when the user wants a dry-run before committing.

---

## 5. Failure mode → fix-it map

Keyed by the symptom you observe, not the root cause. Root causes differ; fixes from the agent side are usually one of a small set.

| Symptom | First retry | If still failing |
|---|---|---|
| `clicked:true` but no page change | `browser_read` + retry with fresh ref | Climb the ladder: `dismiss_overlay:true` → `browser_click_by_text` → `browser_click_at` with coordinates. Verify `page_effect` at each step. |
| `{clicked:false, occluded:true}` | Retry with `dismiss_overlay: true` | `browser_read` to find the occluder, click it first; if the occluder isn't addressable, fall through to `browser_click_at` on the target's coords |
| `browser_click_at` returned `clicked:true` but `page_effect` is all zeros | Treat as failure — the click landed on a parent/sibling, not the target | Adjust coordinates (try the visible-rect centre, not the edge); or fall back to `browser_click_by_text` |
| `REF_STALE` | `browser_read`, retry with new ref | Investigate why the container re-rendered — usually a late-arriving skeleton |
| `WRITE_NOT_REFLECTED` | `browser_wait_for` the editor is focusable, retry | Confirm the field isn't disabled; check for overlay |
| `WRITE_AMPLIFIED` | Do NOT retry | Report the bug with host + framework. Registry needs fixing. |
| Typing produced "DDoouubblleedd" text | Do NOT retry with same params | Remove any manually-forced `mode:"trusted"`; let the registry handle it |
| `Enter` on chat composer does nothing | Retry once (trusted path often takes one warm-up on unknown sites) | Verify focus is actually on the composer with `page_effect.focus.after_selector`; re-focus if not |
| `browser_navigate` "succeeds" but page shows old content | Follow with `browser_wait_for` on a new-route element | SPA may have dropped your navigation; try a hard reload once |
| `NO_PINNED_TAB` | Ask user to click "Use this tab" in popup | Fall back to `browser_current_tab` with a warning |
| `USER_DECLINED` on risky action | Do not silently retry | Surface the decline to the user; they chose for a reason |
| Procedure fails at step N | Read the procedure YAML; diagnose the specific leaf | Do not "fix" by skipping the step or inlining a workaround — file the procedure bug |

---

## 6. Sub-agent delegation

Delegation is the default, not the exception (§2 step 3). The main agent decomposes the task, tracks the list, and hands each subtask to a fresh sub-agent. The brief must be minimal. Bad and good examples:

**Bad** (inlining steps the sub-agent can fetch itself):
> Run gmail.send_email: open https://mail.google.com, click Compose, type the recipient, type the subject, type the body, click Send, wait for the sent confirmation…

**Good**:
> Run the `gmail.send_email` procedure on tab `t_3` with:
> - to: foo@example.com
> - subject: Hello
> - body: Hi there.
> Report success or the exact error.

The sub-agent calls `procedures_get` once and executes from YAML. It doesn't need — and shouldn't carry — the expanded step list.

Composite procedures: brief references the composite name only. One `procedures_get` call, no re-planning.

---

## 7. Procedure authoring rules

If you're writing a YAML procedure (as opposed to just calling primitives ad-hoc), additional discipline applies.

- **Test before save.** Write → run end-to-end → fix breaks → only then `procedures_save`.
- **Schema compliance.** Use only fields in `packages/shared/src/procedures.ts` and tools in `packages/shared/src/tools.ts`. Do not invent outputs like `magic_url` or `api_key` — bind the field names the step *actually returns*.
- **One stable UI transition per leaf.** Each leaf has explicit inputs, concrete waits (with `timeout_ms`), and either a `success_criteria` or an `expected_effect`.
- **`expected_effect` on ambiguous steps.** Anything whose success isn't visually self-evident (e.g. a silent form submit) should declare:
  ```yaml
  expected_effect:
    dom:
      any: true
      added_min: 1
    network:
      requests_started_min: 1
  ```
  The runtime checks this against the observed `page_effect` and halts on divergence.
- **Explicit branching.** If the UI forks (logged-in vs logged-out, empty vs populated list), write separate leaves per path and wire the composite to the right one. Don't branch implicitly inside a leaf.
- **No `browser_reload` polls.** Use `browser_wait_for` with a target and timeout. Reload fires once; it's not a polling primitive.
- **Prefer addressable actions.** `browser_read` + `browser_click` / `browser_type` on a real element > `browser_execute_js` for everything it can express. Reserve JS for cases where the UI genuinely isn't addressable.
- **Leaf → composite.** Verify each leaf in isolation on the live site before assembling the composite that depends on it.
- **Known landmines.**
  - `gmail.send_email` v2 intentionally removed `mode: trusted` from `fill_body` — Gmail's Quill-like composer doubled characters with trusted. Don't re-add it.
  - `meta.clear_field` is the cross-editor clear primitive. Use it when a `browser_type` with `clear_mode:"auto"` isn't the right fit (e.g. clearing without a follow-up type).

---

## 8. Debugging flaky flows

When a flow intermittently fails:

1. **Rerun the bridge with tracing.** `BROWSEROPS_TRACE=1 pnpm start` (bridge package). Every tool call, params, result, and `page_effect` is written to `~/browserops/traces/<session>.jsonl`.
2. **Reproduce once under trace.** Even if it passes this time, you now have a baseline.
3. **Diff traces** between a pass and a fail. Look first at `page_effect` divergences — that's usually where the flakiness lives. Dispatch fields are usually identical across both runs.
4. **Observed facts store.** The bridge maintains `~/browserops/observed/facts.json` — per-host rolling stats on synthetic-effect-rate vs trusted-effect-rate. A host that's sub-20% on synthetic and >50% on trusted is auto-escalated by the bridge for future calls. Read this file to sanity-check which hosts the bridge thinks are flaky.
5. **`procedures_execute` for replay.** Point it at the failing procedure and watch it halt on the first diverging step. The divergence is the bug.
6. **Do NOT** "fix" flakiness by adding `browser_wait_for` with longer timeouts unless you can name the specific thing you're waiting for. Longer waits hide races; they don't fix them.

---

## 9. Risk and user trust

- Risky tools (`browser_execute_js`, and click/type on sensitive domains) prompt the user in the extension popup. `USER_DECLINED` is not an error to work around — it's an explicit "no." Surface it.
- Procedures can be marked risky; the bridge gates them the same way.
- Do not paste secrets (API keys, passwords, tokens) into tool calls without first confirming the user wants them in the trace. If trace mode is on and the user didn't consent, warn them and pause.
- `browser_navigate` to `file://`, `chrome://`, or `javascript:` URLs is restricted server-side. Don't try to route around.

---

## 10. Quick reference — canonical files in the repo

If you're editing browserops itself (not just using it):

| Want to understand… | File |
|---|---|
| Tool catalogue (names, schemas, descriptions) | `packages/shared/src/tools.ts` |
| MCP dispatch (validate → rate-limit → risky-gate → forward) | `packages/bridge/src/mcp-server.ts` |
| Bridge ↔ extension WebSocket protocol | `packages/shared/src/protocol.ts`, `packages/bridge/src/ws-server.ts`, `packages/extension/src/background/ws-client.ts` |
| Extension handlers (what runs in Chrome) | `packages/extension/src/background/handlers/` |
| Effect observation helper | `packages/extension/src/background/handlers/effects.ts` |
| Site / editor registry | `packages/shared/src/editors.ts` |
| Procedure YAML schema + search ranker | `packages/shared/src/procedures.ts`, `packages/bridge/src/procedures/` |
| Trace writer / observed facts | `packages/bridge/src/trace-writer.ts`, `packages/bridge/src/observed-facts.ts` |
| Rate limiter + risky-action gate | `packages/bridge/src/rate-limiter.ts`, `packages/bridge/src/safety.ts` |
| Seed procedures to copy and learn from | `examples/procedures/` |
| Error codes + WS close codes | `packages/shared/src/errors.ts` |

---

## 11. Non-negotiables (the "never" list)

1. Never start a compound task without decomposing it into a tracked subtask list and delegating each subtask to its own sub-agent (§2 step 3).
2. Never treat a dispatch self-report (`clicked:true`, `typed:N`) as proof of state change. Check `page_effect`.
3. Never manually force `mode:"trusted"` on `browser_type` for Quill/ProseMirror/Slate.
4. Never save an untested procedure.
5. Never inline procedure steps into a sub-agent brief. Never batch two subtasks into one brief.
6. Never use `browser_reload` as a polling primitive.
7. Never screenshot to verify a step that has a `wait_for` condition.
8. Never bypass `USER_DECLINED` by retrying silently.
9. Never use `Meta`/`Control` in chords — use `Primary`.
10. Never route around a refused destructive chord. Ask instead.
11. Never "fix" `WRITE_AMPLIFIED` by retrying with the same params. It's a registry bug; report it.
12. Never treat `browser_click_at` `clicked:true` as success on its own. Always verify with `page_effect` — coordinate clicks silently land on wrong elements (parent container, sibling overlay, flex gap) far more often than ref-based clicks do. Zero effect = failure, regardless of what the return field says.
