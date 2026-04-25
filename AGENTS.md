# browserops — agent instructions

Guidance for any MCP-compatible coding agent (Claude Code, Cursor, Zed, Continue, Windsurf, custom SDK agents) working in this repo or consuming the `browserops` MCP server. Claude Code auto-loads this file via the `CLAUDE.md` symlink.

## Project overview

browserops is an MCP server that drives the user's live Chrome profile. Three components in one pnpm workspace:

```
MCP client (Claude Code / Cursor / Zed / …)
      │ stdio MCP (JSON-RPC)
      ▼
packages/bridge  — Node process: MCP server + WebSocket server + rate limiter + risky-action gate + procedure memory
      │ WebSocket on 127.0.0.1:8765, token-authed
      ▼
packages/extension  — Chrome MV3 extension: background service worker + content scripts + popup + options
      │ chrome.tabs / chrome.scripting / chrome.debugger
      ▼
user's real Chrome tabs (with existing logins intact)
```

`packages/shared` holds protocol types, error codes, the tool catalogue, and the procedure schema — consumed by both bridge and extension.

**Tool naming.** MCP tools use underscore form (`browser_navigate`, `procedures_search`) to stay within the MCP-spec `^[a-zA-Z0-9_-]+$` pattern. Procedure *names* (e.g. `tempmail.get_email`) are internal identifiers and stay dotted — they're YAML filenames, not MCP tool names.

**Wire protocol.** The bridge translates each MCP `tools/call` into a WebSocket `{type:"request", id, method, params, timeout_ms}` envelope. The extension routes `method` to a handler registered in `packages/extension/src/background/handlers/`. Responses go back as `{type:"response", id, ok, result|error}`.

**Procedure memory.** Named, parameterised action graphs stored under `~/browserops/procedures/` as YAML. Six `procedures_*` tools (list, search, get, save, promote, delete) manage them. The bridge does NOT execute procedures — agents read the YAML and call the `browser_*` primitives themselves.

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
| User-facing setup (registration for every major MCP client) | `README.md` |

## browserops orchestration rules

### Procedure-first: always search before planning
Before any browser task, call `procedures_search` with tokens from the user's request.
If score >= 0.5, use that procedure. Do not re-plan steps that are already encoded.

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
Run mem0.qa_signup. Report the temp email used and the API key string.
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

Canvas apps render their UI to `<canvas>` elements — synthetic DOM events have no effect. After navigating to a canvas site, call `browser_set_cdp(tab_id, true)` to enable persistent CDP (Chrome DevTools Protocol) attachment. This routes all `browser_click`, `browser_click_at`, `browser_type`, and `browser_press` calls through trusted CDP `Input.*` methods (`isTrusted: true`).

```
browser_navigate(tab_id, "https://docs.google.com/document/d/...")
browser_set_cdp(tab_id, true)
// All subsequent input on this tab uses CDP — clicks land on the canvas,
// keyboard shortcuts work, text insertion goes through Input.insertText.
browser_click_at(tab_id, 400, 300)
browser_type(tab_id, ref, "Hello")
browser_press(tab_id, ["Primary", "KeyZ"])   // undo
```

When done with the canvas site, call `browser_set_cdp(tab_id, false)` or just close the tab. The debugger shows a "controlled by automated software" banner while active — this is expected.

Do **not** enable CDP for standard websites — synthetic dispatch works fine and avoids the banner. CDP is only needed when the site ignores untrusted events (canvas rendering, some chat apps).

## Approval mode

browserops runs in **auto-approve mode by default**: risky actions (`browser_execute_js`, click/type on sensitive domains, procedures marked `risky: true`) execute without prompting. Destructive keyboard chords and navigations to `javascript:`, `file://`, or `chrome://` URLs are refused regardless of mode.

If the user has opted into gating (via `--approval=gate`, `BROWSEROPS_APPROVAL=gate` env var, or the extension popup toggle), risky actions will be gated — respect a `USER_DECLINED` response and do not retry.

## Procedure authoring rules

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
