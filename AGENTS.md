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

**Tool naming.** MCP tools use underscore form (`browser_navigate`, `procedures_search`) to stay within the MCP-spec `^[a-zA-Z0-9_-]+$` pattern. Procedure _names_ (e.g. `tempmail.get_email`) are internal identifiers and stay dotted — they're YAML filenames, not MCP tool names.

**Wire protocol.** The bridge translates each MCP `tools/call` into a WebSocket `{type:"request", id, method, params, timeout_ms}` envelope. The extension routes `method` to a handler registered in `packages/extension/src/background/handlers/`. Responses go back as `{type:"response", id, ok, result|error}`.

**Procedure runtime.** Named, parameterised action graphs stored under `~/browserops/procedures/` as YAML. Five `procedures_*` tools (search, get, save, delete, execute) manage them. The store ships empty — new procedures are authored on-demand by the `browserops-teach` skill (autonomous) or by hand.

**In-panel chat engine.** Besides the MCP path, the bridge can drive an agent as a **bidirectional chat** for the extension's side panel — turns normalized into `ChatMessage`s and streamed to the panel over **SSE** (`GET /chat/stream`); the panel sends turns via `POST /chat/new` / `/chat/send`. Each agent is a pluggable `AgentDriver` (Codex/Cursor slot in behind the same interface); **history is re-read from the agent's own transcript** (`~/.claude/projects/<slug>/<id>.jsonl`), not a bespoke store. For Claude there are two transports, chosen by the `chat_transport` config flag (env `BROWSEROPS_CHAT_TRANSPORT` overrides):

- **`terminal` (default) — `ClaudePtyDriver`.** Spawns ONE long-lived _interactive_ `claude` on a pty (node-pty). Turns are **injected at the TTY** (a single-line write + a discrete Enter — a combined write or a multi-line paste gets swallowed by the Ink TUI), and the clean chat feed is **tailed from the transcript** (no TUI scraping) by `TranscriptTailer`, which derives thinking/idle from a terminal `stop_reason` with a quiescence fallback. To Anthropic this is an ordinary interactive session — no `--print`, no `--dangerously-skip-permissions` (it uses `--permission-mode acceptEdits` + `--allowedTools mcp__browserops`; safe-mode prompts in the pane). The live raw TUI is exposed over a `/chat/pty` **WebSocket** the panel binds an embedded **xterm.js** pane to — type there and it drives the same session (and shows up in the chat).
- **`headless` — `ClaudeDriver`.** `claude --print --output-format stream-json --verbose`, one process per turn (`--session-id` then `--resume`), parsed from stdout; also the **automatic fallback** when node-pty can't load (the engine catches `pty_unavailable` at start). Its `POST /chat/terminal` mirror/takeover (read-only tail of a mirror log / `claude --resume` eject) remains.

The `/chat/*` endpoints reuse the `/launch` two-gate auth (pinned-extension origin + loopback token). However it's spawned, the agent loads the user's own browserops MCP → shim → same daemon socket → same Chrome, so `browser_*` works inside chat too.

## Where to look

| Want to understand…                                                                                                                 | File                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The tool catalogue (names, schemas, descriptions)                                                                                   | `packages/shared/src/tools.ts`                                                                                             |
| MCP dispatch pipeline (validate → rate-limit → risky-gate → forward)                                                                | `packages/bridge/src/mcp-server.ts`                                                                                        |
| Bridge↔extension WebSocket protocol                                                                                                 | `packages/shared/src/protocol.ts` + `packages/bridge/src/ws-server.ts` + `packages/extension/src/background/ws-client.ts`  |
| In-panel chat engine (drivers incl. `claude/terminal-driver` + `tail` + `pty`, manager, `/chat/*` + `/chat/pty`, side-panel client) | `packages/bridge/src/engine/` + `packages/shared/src/chat.ts` + `packages/extension/src/lib/{chat-client,pty-terminal}.ts` |
| Extension handlers (what actually runs in Chrome)                                                                                   | `packages/extension/src/background/handlers/`                                                                              |
| Procedure YAML schema + search ranker                                                                                               | `packages/shared/src/procedures.ts` + `packages/bridge/src/procedures/`                                                    |
| Error codes + WebSocket close codes                                                                                                 | `packages/shared/src/errors.ts`                                                                                            |
| Rate limiter + risky-action gate                                                                                                    | `packages/bridge/src/rate-limiter.ts` + `packages/bridge/src/safety.ts`                                                    |
| browserops-teach skill (autonomous procedure authoring, replaces teach + autoteach)                                                 | `~/.claude/skills/browserops-teach/SKILL.md` (mirror at `skills/browserops-teach.md`)                                      |
| User-facing setup (registration for every major MCP client)                                                                         | `README.md`                                                                                                                |

## browserops orchestration rules

_Agent runtime rules (planning, delegation, checkpoints, stuck-state escalation) live in the `browserops` skill at `~/.claude/skills/browserops/SKILL.md`. The rules below are a summary for repo contributors — the skill is the source of truth._

### Discover available tools from `tools/list` — do not assume `procedures_*` exist

The procedure family (`procedures_search`, `procedures_get`, `procedures_save`, `procedures_delete`, `procedures_execute`) is gated behind a single **experimental, opt-in feature**: `procedures`. Off by default; users enable it via `browserops feature enable procedures`. If a `procedures_*` tool isn't in the catalogue, the feature is off — fall back to direct `browser_*` orchestration for that conversation, and optionally suggest the user enable the feature for next time. Calling a disabled tool returns `FEATURE_DISABLED` with a hint that includes the enable command.

### Procedure-first: always search before planning

Before any browser task, call `procedures_search` with tokens from the user's request — but only when `procedures_search` is in your tool catalogue (the procedures feature is opt-in; see above).
If score >= 0.5, use that procedure. Do not re-plan steps that are already encoded.

### Cross-agent lore (`lore_*`) is opt-in too

The four `lore_*` tools (`lore_save`, `lore_search`, `lore_get`, `lore_delete`) are gated behind the `lore` feature, off by default. They live in `~/browserops/lore/` and are visible to every MCP client (Claude Code, Cursor, Zed, custom SDK), so a lesson saved from one session is reusable in another. Use them for browserops behavior, browser-flow gotchas, and project context that benefits any agent picking up the same bridge — keep Claude-only preferences (keybindings, response style) in the `~/.claude/projects/.../memory/` auto-lore store. The `browserops` skill section "lore_save / lore_search / lore_get / lore_delete" is the source of truth for tool shapes and decision rules.

### Skills stay in sync with the installed package

Skills bundled with the CLI (`browserops`, `browserops-teach`) are kept in sync via `browserops upgrade` (which now calls `browserops sync` internally) or directly via `browserops sync skills`. After every package bump the on-disk `~/.claude/skills/<name>/SKILL.md` is refreshed atomically, with a timestamped `.bak` if local edits were detected. If a skill ever feels out of step with the tool catalogue you're seeing, run `browserops sync skills`.

### Server instructions adapt to enabled features

The text the bridge surfaces via MCP `initialize.result.instructions` is built per-server-instance from the active feature set, so disabled features don't bloat the prompt with documentation for tools the agent can't call. With `procedures` off the Procedures section collapses to a one-line opt-in hint; with `lore` on a short Cross-agent-lore paragraph is appended; the procedure-prompt entry (`browserops_procedure`) is hidden from `prompts/list` whenever `procedures` is off. That's why the procedure-first orchestration rule above is conditional on `procedures_search` actually being in your tool catalogue.

### Prefer `browser_observe` for general state reads; `browser_quick_read` for element lookup

For general "look at the page" steps, prefer `browser_observe` over both `browser_read` and `browser_quick_read` — its `auto` mode picks the cheapest representation (augmented a11y, action-grade screenshot, box-drawing summary, or diff against a prior observation_token) based on page characteristics. When you specifically need to find an element by its label, `browser_quick_read` is still the cheapest path. Fall back to raw `browser_read` only when you need the full a11y tree as a serialised blob (procedure replay, debugging). `browser_read` and `browser_quick_read` both default to viewport scope now; pass `scope: "document"` for the legacy full-page walk.

### Sub-agent threshold

- **≤ 8 steps, no retries needed**: run browser tool calls directly from the main agent. No sub-agent.
- **> 8 steps OR retry/branching logic needed**: delegate to a sub-agent.

### Sub-agent brief must be minimal

Pass only: procedure name, inputs, tab_id.
Do NOT copy procedure steps into the prompt — the sub-agent calls `procedures_get` itself.

```
Run <procedure_name> on tab t_3 with:
- <input_1>: <value_1>
- <input_2>: <value_2>
Report success or failure.
```

### Screenshots only on failure (with one nuance)

Never take a screenshot to "verify" a step that has a `wait_for` condition or an `expected:` predicate — the `effect` envelope already tells you whether anything changed. Screenshot when a step returns an error, unexpected state, OR when `browser_observe`'s auto-mode chose visual representation for you (canvas-dominant pages, ≥30% of the viewport). In auto mode, the bridge picks the screenshot path itself; in those cases the action-grade default (768px longest edge, ~800 tokens) is intentionally cheap, so you don't need to wave it off.

### Composite procedures = single fetch

When a composite procedure covers the full flow, the sub-agent brief references ONLY the composite name — one `procedures_get`, no re-planning steps.

```
Run <composite_procedure>. Report whether it succeeded.
```

## Keyboard chords

`browser_press` sends a keyboard chord to the focused element in a tab. The last entry of `keys` is the key; everything before it is a modifier.

**Use `Primary`, not `Meta` or `Control`.** `Primary` is a logical alias that the extension resolves at dispatch time to `Meta` on macOS and `Control` on Windows/Linux. Procedures authored once work on every contributor's machine.

Common chord recipes:

| Intent                   | `keys:`                                 |
| ------------------------ | --------------------------------------- |
| Select all               | `["Primary", "KeyA"]`                   |
| Copy                     | `["Primary", "KeyC"]`                   |
| Paste                    | `["Primary", "KeyV"]`                   |
| Cut                      | `["Primary", "KeyX"]`                   |
| Undo                     | `["Primary", "KeyZ"]`                   |
| Redo                     | `["Primary", "Shift", "KeyZ"]`          |
| Submit a form            | `["Enter"]`                             |
| Dismiss a modal          | `["Escape"]`                            |
| Move focus forward       | `["Tab"]`                               |
| Delete one char          | `["Backspace"]`                         |
| Delete forward           | `["Delete"]`                            |
| Clear a field (keyboard) | `["Primary", "KeyA"]` then `["Delete"]` |

**Clearing fields.** For the common case ("overwrite this bad text with new text"), use `browser_type` with `clear_mode: "auto"` rather than a two-step chord — `auto` picks the fastest safe strategy per element type, verifies emptiness, and falls back to keyboard Delete if execCommand was ignored by a rich editor.

For clearing as an independent step (no typing follow-up), bind a `browser_press` chord directly: `["Primary", "KeyA"]` followed by `["Delete"]`.

**Destructive chords are refused by the extension.** `Primary+W`, `Primary+Q`, `Primary+Shift+W`, `Alt+F4`, `Primary+T`, `Primary+N`, `Primary+Shift+N` would close tabs / quit the browser / open new contexts the user didn't ask for. Don't try to route around the deny-list — if you need something destructive, ask first.

## CDP-trusted input is the default

Every http(s) tab the agent navigates to gets persistent `chrome.debugger` attached automatically (`autoAttachAlways` in `packages/extension/src/background/cdp.ts`). All `browser_click`, `browser_click_at`, `browser_click_by_text`, `browser_type`, `browser_press`, and `browser_hover` calls dispatch through CDP `Input.*` — trusted compositor events that traverse iframes, shadow DOM, and `isTrusted`-gated handlers (Slack, Discord, Linear, Notion, Gmail rich editors, hover-only menus, canvas apps).

Chrome's "controlled by automated test software" banner appears on every driven tab while CDP is attached. This is expected, not a failure signal.

**Per-tab opt-out:** `browser_set_cdp(tab_id, false)` releases the persistent attach (5s idle detach kicks in). Synthetic DOM dispatch resumes for that tab — faster, no banner, but silently fails on `isTrusted`-gated UIs.

**Non-http URLs** (`chrome://`, `about:`, `file://`, `devtools://`) are skipped — CDP would fail to attach or have no useful effect.

## Rich-text editors (Slack, Gmail, Discord, Notion, Linear)

Rich editors (Quill, ProseMirror, Slate, Draft.js, Lexical) accept trusted `Input.insertText` and key events because CDP is universal. `browser_type` is the first thing to reach for.

If `browser_type` still returns `WRITE_NOT_REFLECTED` after the in-handler CDP rescue (rare — usually means the field is gated behind a custom event filter), drop to `browser_execute_js`:

```js
browser_execute_js(
  tab_id,
  `
  const el = document.querySelector('[contenteditable="true"]');
  el.focus();
  document.execCommand('insertText', false, 'your text here');
`,
);
```

**Dialog overlays are the #1 blocker on chat apps.** Before attempting any interaction, check the `browser_read` a11y tree for modal dialogs, upsell banners, or cookie prompts. Dismiss them first (Escape key or click the close button) before interacting with the editor.

## Approval mode

browserops runs in **auto-approve mode by default**: risky actions (`browser_execute_js`, click/type on sensitive domains, procedures marked `risky: true`) execute without prompting. Destructive keyboard chords and navigations to `javascript:`, `file://`, or `chrome://` URLs are refused regardless of mode.

If the user has opted into gating (via `--approval=gate`, `BROWSEROPS_APPROVAL=gate` env var, or the extension popup toggle), risky actions will be gated — respect a `USER_DECLINED` response and do not retry.

## Procedures (deterministic-first flows with LLM fallback)

> **Experimental — off by default.** The six procedure tools (`procedures_search`, `_get`, `_save`, `_delete`, `_execute`, `_resume`) plus the two locator helpers (`browser_locate`, `browser_propose_locator`) only appear in your catalogue when the user has run `browserops feature enable procedures`. With the feature off, the procedure store, the executor, and the browserops-teach skill aren't reachable — direct `browser_*` orchestration is the only path.

### The unified runtime

Each procedure step targets an element via a **semantic Locator descriptor** (re-resolved against the live a11y tree every step), polls a **retrying `expect:` predicate** until match or timeout, and escalates through an **explicit per-step fallback ladder** (`strict | retry | relocate | relocate_then_llm | llm`) when reality doesn't match the spec. The top-level **`forbidden{locators, actions}`** block is enforced on every dispatch including LLM-proposed resume patches.

`procedures_execute({name, tab_id, inputs?, strict?})` returns one of:

- `{completed: true, status: "completed"}` — all steps + top-level `verify:` passed.
- `{status: "halted", divergence}` — strict failure; no LLM fallback was available.
- `{status: "needs_assist", execution_id, envelope}` — paused; the envelope carries the failing step, the resolution attempts, the safety constraints, and a preview of remaining steps. Resume via `procedures_resume(execution_id, patch)` where `patch` is one of `{kind:"resume_with", with:{locator?, params?}}`, `{kind:"insert_steps", steps:[...]}`, or `{kind:"give_up", reason?}`.
- `{status: "gave_up"}` — terminal after a `give_up` patch.

Pass `strict: true` to refuse every LLM-fallback path even if a step declares one. Mandatory for CI / batch runs and for the post-authoring verification run that flips `bump_success: true → status: trusted`.

### Locator descriptors + the uniqueness scorer

A `Locator` is one of `{role, name, aria_label, data_testid, href, attr, has_text, has_text_not, in_frame, near, nth, scope}` — at least one field required. Stability tiers (used by the proposer):

- **Tier 1 (author/contract-controlled, survives rebuilds):** `aria_label`, `data_testid` (matches `data-testid` / `data-test` / `data-qa`), `href`, `attr{name,value}`, `role`, `in_frame`.
- **Tier 2 (text-derived, churns on copy/DOM changes):** `name`, `has_text`, `has_text_not`, `near`.
- **Tier 3 (fragile):** `nth` — depends on document order, breaks when a sibling appears.

`browser_propose_locator({tab_id, ref})` is the author-time helper. Given a target ref (from `browser_read`), it walks a candidate ladder and returns `{unique, locator, tier, fragile, warnings, candidates}` — the smallest, highest-tier descriptor that resolves to exactly that element. Prefer the proposed descriptor over hand-written `{role, name}` pairs. `browser_locate({tab_id, locator})` is the runtime resolver the executor calls before every step — you rarely call it directly.

### Drift health + auto-demote

The executor records per-step health (runs, relocates, ambiguous_resolves, target_changed, avg_match_count, last_tier) into `meta.health` after every run. On `procedures_save({bump_success:true})`, the runtime checks the prior health and refuses the trusted flip when:

- relocate-rate > 0.4 across ≥5 runs, OR
- target_changed > 0 across ≥3 runs, OR
- last_tier === 3 AND relocate-rate > 0.1.

The save still proceeds, but the response carries `{demoted: true, demote_reason: "..."}` and the procedure persists as draft. Surface `demote_reason` to the user — don't claim success.

### Composition

A `do: procedure_call` step recurses into another saved procedure in-process (no extension round-trip). Composite procedures declare `kind: composite` + `uses: [<leaf names>]`. **Caveat:** pass `tab_id: "{{tab_id}}"` inside `with.inputs` of the procedure_call step — top-level `tab_id` is ignored on the recursive call.

### Storage

`~/browserops/procedures/` holds the YAML files plus the `index.json` search manifest. Schema lives in `packages/shared/src/procedures.ts`; execute loop, validator, search, handlers, and the drift-health recorder in `packages/bridge/src/procedures/`. Override the storage root with `BROWSEROPS_PROCEDURES_DIR`.

### Authoring (browserops-teach skill)

When `procedures_search` returns nothing trusted for a non-trivial flow AND the user signals they want to remember it ("learn to do X", "figure this out and save it", "remember how to <task>"), the **`browserops-teach` skill** at `~/.claude/skills/browserops-teach/SKILL.md` (mirrored to `skills/browserops-teach.md`) is the canonical guide. It owns the autonomous flow end-to-end: pre-flight reuse check, the three hard safety gates (cross-user side effects / money or account irreversibility / genuinely unparseable goal), the per-app safe-dummy registry, the `browser_propose_locator`-driven YAML authoring loop, strict-mode verification + an external goal-grounded predicate, and drift-health-aware promotion. Don't drive authoring from this file alone — the skill is the source of truth.

If `procedures_search` returns a trusted match at score ≥0.5, point the user at the existing procedure rather than re-authoring.

## Procedure authoring rules (summary; skill is canonical)

- **Never save an untested procedure.** Write → run via `procedures_execute({strict: true})` → fix → save with `bump_success: true`. Trusted only when the strict run was clean AND the live UI still matches.
- **Use `browser_propose_locator` for every control.** Don't eyeball `{role, name}` — tier-1 fields the proposer finds (aria_label/data_testid/href/attr) survive UI rebuilds; text-derived names don't.
- **Declare `expect:` on every action step with a positive success criterion.** Required on any step whose `fallback.strategy` is `llm` — without it the runtime can't tell when to ask for help.
- **Declare `forbidden{locators, actions}` for nearby destructive controls.** A misfired LLM patch on Gmail can click "Delete message" instead of "Send". One `{name: "/^delete/i"}` regex stops it before dispatch.
- **Declare a top-level `verify:` block.** It's the one-shot success predicate evaluated after the last step (`text_visible: "Sent"`, `url_matches: "/inbox/"`, `network_endpoint: "/sendmessage"`, etc.).
- **Branching is explicit.** Different UI paths → separate steps or separate leaves wired by a composite.
- **No `browser_reload` for polling.** Use `do: wait` with an explicit `timeout_ms` (the underlying `browser_wait_for`).
- **Use `do: js` only when the UI is genuinely not addressable** (canvas/WebGL/badly-marked-up SPA). Otherwise prefer locator-driven steps.
- **Use only fields in `packages/shared/src/procedures.ts` and tools in `packages/shared/src/tools.ts`.** No `expected_effect` / `success_criteria` / `on_fail` / `for_each` / `preconditions` — those legacy fields are gone.
