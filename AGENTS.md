# browserops — agent instructions

Guidance for any MCP-compatible coding agent (Claude Code, Cursor, Zed, Continue, Windsurf, custom SDK agents) working in this repo or consuming the `browserops` MCP server. Claude Code auto-loads this file via the `CLAUDE.md` symlink.

## Project overview

browserops is an MCP server that drives the user's live Chrome profile. Three components in one pnpm workspace:

```
MCP client (Claude Code / Cursor / Zed / …)
      │ stdio MCP (JSON-RPC)
      ▼
packages/bridge  — Node process: MCP server + WebSocket server + rate limiter + risky-action gate + procedure runtime
      │ WebSocket on 127.0.0.1:57321, token-authed
      ▼
packages/extension  — Chrome MV3 extension: background service worker + content scripts + popup + options
      │ chrome.tabs / chrome.scripting / chrome.debugger
      ▼
user's real Chrome tabs (with existing logins intact)
```

`packages/shared` holds protocol types, error codes, the tool catalogue, and the procedure schema — consumed by both bridge and extension.

**Tool naming.** MCP tools use underscore form (`browser_navigate`, `procedures_search`) to stay within the MCP-spec `^[a-zA-Z0-9_-]+$` pattern. Procedure *names* (e.g. `tempmail.get_email`) are internal identifiers and stay dotted — they're YAML filenames, not MCP tool names.

**Wire protocol.** The bridge translates each MCP `tools/call` into a WebSocket `{type:"request", id, method, params, timeout_ms}` envelope. The extension routes `method` to a handler registered in `packages/extension/src/background/handlers/`. Responses go back as `{type:"response", id, ok, result|error}`.

**Procedure runtime.** Named, parameterised action graphs stored under `~/browserops/procedures/` as YAML. Six `procedures_*` tools (list, search, get, save, promote, delete) manage them. The bridge does NOT execute procedures — agents read the YAML and call the `browser_*` primitives themselves.

## Where to look

| Want to understand… | File |
|---|---|
| The tool catalogue (names, schemas, descriptions) | `packages/shared/src/tools.ts` |
| MCP dispatch pipeline (validate → rate-limit → risky-gate → forward) | `packages/bridge/src/mcp-server.ts` |
| Bridge↔extension WebSocket protocol | `packages/shared/src/protocol.ts` + `packages/bridge/src/ws-server.ts` + `packages/extension/src/background/ws-client.ts` |
| Extension handlers (what actually runs in Chrome) | `packages/extension/src/background/handlers/` |
| Procedure YAML schema + search ranker | `packages/shared/src/procedures.ts` + `packages/bridge/src/procedures/` |
| Error codes + WebSocket close codes | `packages/shared/src/errors.ts` |
| Rate limiter + risky-action gate | `packages/bridge/src/rate-limiter.ts` + `packages/bridge/src/safety.ts` |
| Seed procedures to copy and learn from | `examples/procedures/` |
| Teach mode (recorder, content script, session store, MCP tools) | `packages/extension/src/background/teach-recorder.ts` + `packages/extension/src/content/capture-events.ts` + `packages/bridge/src/teach/` |
| User-facing setup (registration for every major MCP client) | `README.md` |

## browserops orchestration rules

_Agent runtime rules (planning, delegation, checkpoints, stuck-state escalation) live in the `browserops` skill at `~/.claude/skills/browserops/SKILL.md`. The rules below are a summary for repo contributors — the skill is the source of truth._

### Discover available tools from `tools/list` — do not assume `procedures_*` or `procedures_teach_*` exist

Both the procedure family (`procedures_list`, `procedures_search`, `procedures_get`, `procedures_save`, `procedures_promote`, `procedures_delete`, `procedures_compile`, `procedures_execute`) and the teach-mode family (`procedures_teach_*`) are **experimental, opt-in features**. They are off by default; users enable them via `browserops feature enable <name>`. If a tool isn't in the catalogue, the feature is off — fall back to direct `browser_*` orchestration for that conversation, and optionally suggest the user enable the feature for next time. Calling a disabled tool returns `FEATURE_DISABLED` with a hint that includes the enable command.

### Procedure-first: always search before planning
Before any browser task, call `procedures_search` with tokens from the user's request — but only when `procedures_search` is in your tool catalogue (the procedures feature is opt-in; see above).
If score >= 0.5, use that procedure. Do not re-plan steps that are already encoded.

### Prefer `browser_quick_read` over `browser_read`
When you need to find a specific element (a button, input, link) by its label, use `browser_quick_read` instead of `browser_read`. It searches the a11y tree by accessible name and returns only matching refs — much cheaper than a full page read. Fall back to `browser_read` only when you need the full page structure or when `browser_quick_read` returns no matches.

### Sub-agent threshold
- **≤ 8 steps, no retries needed**: run browser tool calls directly from the main agent. No sub-agent.
- **> 8 steps OR retry/branching logic needed**: delegate to a sub-agent.

### Sub-agent brief must be minimal
Pass only: procedure name, inputs, tab_id.
Do NOT copy procedure steps into the prompt — the sub-agent calls `procedures_get` itself.

```
Run the gmail.send_email procedure on tab t_3 with:
- to: foo@example.com
- subject: Hello
- body: Hi there.
Report success or failure.
```

### Screenshots only on failure
Never take a screenshot to "verify" a step that has a `wait_for` condition.
Only screenshot when a step returns an error or unexpected state.

### Composite procedures = single fetch
When a composite procedure covers the full flow, the sub-agent brief references ONLY the composite name — one `procedures_get`, no re-planning steps.

```
Run gmail.send_email. Report whether the message was sent successfully.
```

## Keyboard chords

`browser_press` sends a keyboard chord to the focused element in a tab. The last entry of `keys` is the key; everything before it is a modifier.

**Use `Primary`, not `Meta` or `Control`.** `Primary` is a logical alias that the extension resolves at dispatch time to `Meta` on macOS and `Control` on Windows/Linux. Procedures authored once work on every contributor's machine.

Common chord recipes:

| Intent | `keys:` |
|---|---|
| Select all | `["Primary", "KeyA"]` |
| Copy | `["Primary", "KeyC"]` |
| Paste | `["Primary", "KeyV"]` |
| Cut | `["Primary", "KeyX"]` |
| Undo | `["Primary", "KeyZ"]` |
| Redo | `["Primary", "Shift", "KeyZ"]` |
| Submit a form | `["Enter"]` |
| Dismiss a modal | `["Escape"]` |
| Move focus forward | `["Tab"]` |
| Delete one char | `["Backspace"]` |
| Delete forward | `["Delete"]` |
| Clear a field (keyboard) | `["Primary", "KeyA"]` then `["Delete"]` |

**Clearing fields.** For the common case ("overwrite this bad text with new text"), use `browser_type` with `clear_mode: "auto"` (or `clear_first: true`) rather than a two-step chord — `auto` picks the fastest safe strategy per element type, verifies emptiness, and falls back to keyboard Delete if execCommand was ignored by a rich editor.

For clearing as an independent step (no typing follow-up), use the bundled `meta.clear_field` procedure.

**Destructive chords are refused by the extension.** `Primary+W`, `Primary+Q`, `Primary+Shift+W`, `Alt+F4`, `Primary+T`, `Primary+N`, `Primary+Shift+N` would close tabs / quit the browser / open new contexts the user didn't ask for. Don't try to route around the deny-list — if you need something destructive, ask first.

## Canvas apps (Figma, Google Docs, Sheets, Canva, Miro)

Canvas apps render their UI to `<canvas>` elements — synthetic DOM events have no effect. **CDP is auto-enabled** when `browser_navigate` lands on a known canvas domain (Google Docs, Sheets, Figma, Canva, Miro, Whimsical, Figjam). All `browser_click`, `browser_click_at`, `browser_type`, and `browser_press` calls on that tab automatically use trusted CDP `Input.*` methods. The debugger shows a "controlled by automation" banner while active — this is expected.

For other canvas sites not in the auto-list, call `browser_set_cdp(tab_id, true)` manually after navigating.

Do **not** enable CDP for standard websites — synthetic dispatch works fine and avoids the banner.

## Rich-text editors (Slack, Gmail, Discord, Notion, Linear)

The `gated-domains` feature is **on by default**. browserops automatically attaches CDP ("debug mode") on navigation to these domains, which pre-configures the trusted-input dispatch path. Navigation results include `gated_domain: true`, and synthetic `browser_click` / `browser_type` / `browser_press` calls are nudged toward `browser_execute_js` when they detect zero observable change on the page. The tradeoff is Chrome's "controlled by automation" banner, visible while the feature is active — users who want to avoid it can opt out with `browserops feature disable gated-domains`. Custom domains can be added by writing a JSON array of glob patterns to `~/.browserops/gated-domains.json` — same format as `~/.browserops/risky-domains.json`.

For users without the feature enabled, or as a fallback when CDP dispatch alone is insufficient: Rich editors (Quill, ProseMirror, Slate, Draft.js, Lexical) work with synthetic dispatch — `browser_type` automatically uses one-shot `execCommand("insertText")` on contenteditable elements, which avoids the focus-stealing issues that per-character keystroke mode has on these editors.

If `browser_type` still fails (returns `WRITE_NOT_REFLECTED`), **do not retry** — go straight to `browser_execute_js`:

```js
browser_execute_js(tab_id, `
  const el = document.querySelector('[contenteditable="true"]');
  el.focus();
  document.execCommand('insertText', false, 'your text here');
`)
```

**Dialog overlays are the #1 blocker on chat apps.** Before attempting any interaction, check the `browser_read` a11y tree for modal dialogs, upsell banners, or cookie prompts. Dismiss them first (Escape key or click the close button) before interacting with the editor.

## Approval mode

browserops runs in **auto-approve mode by default**: risky actions (`browser_execute_js`, click/type on sensitive domains, procedures marked `risky: true`) execute without prompting. Destructive keyboard chords and navigations to `javascript:`, `file://`, or `chrome://` URLs are refused regardless of mode.

If the user has opted into gating (via `--approval=gate`, `BROWSEROPS_APPROVAL=gate` env var, or the extension popup toggle), risky actions will be gated — respect a `USER_DECLINED` response and do not retry.

## Teach mode

> **Experimental — off by default.** The `procedures_teach_*` tools only appear in your catalogue when the user has run `browserops feature enable teach`. If they aren't present, do not suggest teach mode — there is nothing you can call. When suggesting teach to a user whose catalogue doesn't have it, point them at `browserops feature enable teach` (and `procedures`, since teach's output is a procedure draft).

Teach mode lets the user demonstrate a flow in their real browser while you watch live. It's the bootstrap path for any flow that has no existing procedure: instead of re-planning from scratch every time, the user shows you once and you turn it into a procedure.

### When to suggest it

If `procedures_search` returns nothing relevant for a non-trivial flow the user is asking about, ask once: *"I don't have a procedure for this. Want to teach me — just demonstrate it once and I'll record it?"* If they agree, proceed. Don't suggest teach mode for one-shot tasks where the user is unlikely to repeat the flow.

### The loop (strictly agent-driven)

1. `procedures_teach_start({ narration_hint? })` → returns `session_id`.
2. Tell the user "go ahead — click through the flow." Stay quiet while they work.
3. `procedures_teach_observe({ session_id, since_seq, wait_ms: 30000 })` to long-poll the timeline. Loop until `finished: true` or you have enough context to insert a sync point.
4. As the user demonstrates, optionally insert sync points:
   - `procedures_teach_marker({ label? })` — hard split boundary the distiller respects.
   - `procedures_teach_narration({ text })` — free-text note attached to the timeline.
5. When the user signals they're done (or you observe a clear terminal state), call `procedures_teach_stop`. Returns `event_count` and `duration_ms`.
6. Build the procedure from the timeline and call `procedures_save` **only after replay succeeds** — same "never save an untested procedure" rule as everywhere else.

### Activation is agent-only

There is no "Start teaching" button in the popup. The user starts by talking to you. While a session is active the popup shows a red `REC` bar with a single Stop button — that's an escape valve, not a normal control surface. Don't tell users to press it; tell them to ask you to stop.

### Privacy: redaction is at capture, not afterthought

The content script blanks the value of any input where:
- `type="password"`, or `autocomplete` is `current-password` / `new-password` / `one-time-code`, or `name`/`id` matches `/(password|secret|otp|2fa|mfa)/`
- The free-text content matches a known secret regex (`sk-*`, `AKIA*`, `ghp_*`, `xox*-*`, JWTs)

Redacted typing arrives with `value: ""`, `redacted: true`, and a `redaction_reason`. Treat redacted fields as required parameters: when distilling, surface them as procedure inputs the runner provides at execution time, not literals baked into the YAML.

### Sessions live on disk

`~/browserops/teach-sessions/<session_id>.jsonl` (events) + `<session_id>.meta.json` (sidecar). Override with `BROWSEROPS_TEACH_DIR`. Use `procedures_teach_list` to find sessions started before you had context — useful if the user starts demonstrating from the popup or via another agent before naming the goal.

## Procedure authoring rules

> Applies whenever the `procedures` feature is enabled and you're authoring or maintaining procedure YAML. With `procedures` off these tools and rules don't apply — the user is on the minimal `browser_*`-only path.

### Never save an untested procedure
- Write the procedure → run it in the same session → fix what breaks → then call `procedures_save`.
- A procedure is trusted only when `success_count >= 1` and the current UI still matches what was verified.
- For multi-step flows: test each leaf individually first, then compose.
- Treat the live UI as source of truth. If the next screen, button label, or route is not confirmed, do not guess it.
- Model every stable UI transition as its own leaf. Split setup, onboarding, branching, and final extraction into separate procedures.
- Keep leaves executable, not descriptive. Each leaf should have explicit inputs, concrete waits, and a concrete success condition.
- Use only fields supported by `packages/shared/src/procedures.ts` and tools defined in `packages/shared/src/tools.ts`.
- If a step returns structured data, bind and consume the exact returned field names. Do not invent `magic_url`, `api_key`, or similar outputs.
- Prefer `browser_read` / `browser_query_selector` / `browser_click_by_text` / `browser_type` on the real element over guessed coordinates or broad JS when the UI can be addressed directly.
- Use `browser_execute_js` only when the UI genuinely requires it, and keep the script narrow enough that it is still tied to one page state.
- Any step that waits for async state must use `browser_wait_for` or `browser_wait_for_idle` with an explicit timeout. Do not use `browser_reload` for polling.
- Branching logic must be explicit. If the UI can take different paths, write separate steps or leaves for each path and wire the composite to the right one.
- Add `success_criteria` for any leaf whose completion is otherwise ambiguous.
- Verify each leaf against the live site before saving the composite that depends on it.

### Use `browser_wait_for` for polling, not manual reloads
- Any step that waits for async state (email arriving, page loading, element appearing) must use a `browser_wait_for` action step with an explicit `timeout`.
- Never use `browser_reload` as a substitute for polling — it fires once and does not retry.
