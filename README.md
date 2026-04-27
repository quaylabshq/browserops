# browserops

An MCP server that drives your live Chrome browser. Any MCP-compatible client (Claude Code, Cursor, Zed, Continue, Windsurf, custom SDK agents, …) calls `browser_*` tools → a local Node bridge forwards them to a Chrome MV3 extension over WebSocket → the extension uses `chrome.tabs` / `chrome.scripting` / `chrome.debugger` to control your real browsing session (including logged-in sites).

## Prerequisites

- macOS or Linux (Windows via WSL)
- Node.js ≥ 20.10
- Chrome ≥ 120

## Quick start

### 1. Install

```bash
npm i -g browserops
```

You can also use `pnpm add -g browserops` or run ad-hoc with `npx browserops`.

### 2. Initialize

```bash
browserops init
```

This is a one-shot wizard. It mints `~/.browserops/token`, seeds bundled procedure examples into `~/browserops/procedures/shared/`, starts the bridge daemon on `127.0.0.1:57321`, copies the unpacked Chrome extension to `~/.browserops/extension/`, then detects your installed MCP clients (Claude Code, Cursor, Zed, Continue, Windsurf, Codex) and offers to register `browserops` in each of their configs. Re-running it is safe and idempotent.

Flags:
- `--yes` — non-interactive (accept all detected clients)
- `--no-mcp` — skip MCP-client install
- `--client claude-code,cursor` — explicit subset
- `--dry-run` — print diffs, don't write

### 3. Pair the Chrome extension

1. Open `chrome://extensions`, toggle **Developer mode** on (top right).
2. Click **Load unpacked** and select `~/.browserops/extension/` (the path was copied to your clipboard by `init`).
3. An onboarding tab opens automatically — click **Confirm & connect**. Chrome's toolbar icon turns green within a second.

### 4. Use it

From the terminal — `browserops` ensures the bridge is running and hands off to your editor with the task pre-loaded:

```bash
# Universal first run — works for everyone
browserops "open hacker news and read me the top story"

# The capability demo — shows the live-profile advantage
browserops "check my gmail and summarize my last 3 emails"
```

A bare `browserops "task"` routes through your configured default launcher (set during `init`; change with `browserops config set default_launcher codex`). Force a specific launcher with `--claude`, `--codex`, or `--cursor`.

Or open the editor you registered in Step 2 and just talk to it — `browserops` is wired in as an MCP server, so any prompt that could use the browser will pick it up.

### Daily lifecycle

```bash
browserops status      # PID, port, uptime, last errors
browserops start       # bring the daemon up (no-op if already running)
browserops stop
browserops restart
browserops logs -f     # tail ~/.browserops/log.jsonl
browserops doctor      # diagnose Node / port / token / extension / clients
browserops upgrade     # bump the global install + refresh extension files
```

### Per-project rules (optional)

Two clients auto-discover the agent rules: Claude Code reads `CLAUDE.md`, Codex CLI reads `AGENTS.md`. Other clients (Cursor, Windsurf, Copilot, Continue) need a one-time copy into a per-project rules slot — run inside any project where you want browserops to be agent-aware:

```bash
browserops install-rules
```

## Approval mode

There are **two independent gates**: one inside browserops (which browser actions need confirmation), and one inside the launcher you spawn (whether the agent itself pauses for per-action approval).

### Browser-side: browserops auto-approve

browserops runs in **auto-approve mode by default**: risky actions (`browser_execute_js`, click/type on sensitive domains, procedures marked `risky: true`) proceed without prompting.

To require manual approval instead, use any of these:
- `BROWSEROPS_APPROVAL=gate browserops start`
- Check **Require approval for risky actions** in the extension popup.

Destructive keyboard chords (`Primary+W`, `Primary+Q`, `Primary+T`, `Primary+N`, `Primary+Shift+N`, `Alt+F4`) and navigations to `javascript:`, `file://`, or `chrome://` URLs are refused regardless of mode.

Audit trail: every auto-approved action is written to the trace file when `BROWSEROPS_TRACE=1` is set.

### Launcher-side: safe mode

When you run `browserops "task"`, the CLI spawns your default launcher with permission prompts skipped so the agent can complete the task without you babysitting:

| Launcher | What we pass |
|---|---|
| Claude Code | `claude --dangerously-skip-permissions` |
| Codex CLI | `codex exec --full-auto` (skips approvals, keeps the codex sandbox on) |
| Cursor | no CLI flag exists — set Cursor → **Settings → Agent → Auto-Run** to "Allow" |

Flip on safe mode any time to restore the launcher's own per-action prompts:

```bash
browserops config set safe_mode true
```

The browser-side gate above is independent and unaffected.

## Connecting your MCP client

`browserops init` registers the bridge in every detected client automatically. The snippets below are for manual or non-detected setups — paste them into your client's MCP config. The bridge is a plain stdio MCP server (`browserops-bridge` on PATH after `npm i -g browserops`); any client that can spawn one can use it.

### Claude Code

```bash
claude mcp add browserops --scope user -- browserops-bridge
```

Verify with `claude mcp list`.

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "browserops": { "command": "browserops-bridge" }
  }
}
```

### Zed

`~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "browserops": { "command": { "path": "browserops-bridge", "args": [] } }
  }
}
```

### Continue (VS Code / JetBrains)

`~/.continue/config.json` under `experimental.modelContextProtocolServers`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      { "transport": { "type": "stdio", "command": "browserops-bridge" } }
    ]
  }
}
```

### Windsurf / Codeium

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "browserops": { "command": "browserops-bridge" }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.browserops]
command = "browserops-bridge"
args = []
```

### Custom / SDK-based agents

Any client built on the official MCP SDKs can connect with `command: "browserops-bridge"`, no args, no env vars (token + extension ID are handled through `~/.browserops/`).

### Setting environment variables

All clients support an `env` block next to `command`. For example, to bind a non-default port, put:

```json
"env": { "BROWSEROPS_PORT": "9876" }
```

Then mirror the same port in the extension's options page.

## Agent instructions

**`AGENTS.md` is required every time you run browserops.** It contains the orchestration rules your agent must follow: procedure-first search before planning, when to use sub-agents, keyboard chord syntax, and procedure authoring rules. Without it, agents re-plan steps that are already encoded in procedures, take unnecessary screenshots, skip the `procedures_search` call, and produce invalid YAML.

Two clients auto-discover it with no setup:

| Client | How |
|---|---|
| **Claude Code** | Reads `CLAUDE.md` (symlink → `AGENTS.md`) from the repo root automatically |
| **OpenAI Codex CLI** | Reads `AGENTS.md` from the repo root automatically |

All other clients need a per-project copy into their rules slot. Run from inside the project:

```bash
browserops install-rules
```

This writes the appropriate file for each detected client:

| Client | Slot |
|---|---|
| **Cursor** | `.cursor/rules/browserops.mdc` (frontmatter + AGENTS.md) |
| **Windsurf / Codeium** | block in `.windsurfrules` |
| **GitHub Copilot** | block in `.github/copilot-instructions.md` |
| **Continue** | `customInstructions` in `.continue/config.json` |
| **Zed** | manual paste into Settings → Assistant → System prompt |

Re-running `install-rules` is idempotent — it replaces the existing block in place via sentinel comments rather than appending duplicates.

## Available tools (v1)

Observation (no rate cost): `browser_list_tabs`, `browser_current_tab`, `browser_wait_for`

Navigation: `browser_new_tab`, `browser_close_tab`, `browser_switch_tab`, `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`

Content: `browser_screenshot` (viewport), `browser_read` (`text` / `markdown` / `sanitized_html` / `a11y_tree`)

Input: `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_hover`, `browser_execute_js`

Full JSON schemas for each tool are declared in `packages/shared/src/tools.ts`.

**How click/type work.** First call `browser_read` with `mode: "a11y_tree"` on the tab — you get back a numbered tree of interactive elements and their refs. Then call `browser_click({tab_id, ref})` or `browser_type({tab_id, ref, text})` using those refs. Refs invalidate on navigation (same-doc or cross-doc) — re-read the tree after a navigation.

**v1 limitations:**
- Click / type fire synthetic DOM events (`isTrusted: false`). Sites that hard-check trusted events (reCAPTCHA, some banks) will refuse them. A CDP-based trusted-events path is planned for v2.
- `browser_screenshot` with `full_page: true` returns `INTERNAL` — viewport-only in v1.

## Procedure runtime

Procedures are named, parameterised, reusable action graphs that the agent can discover and replay without re-planning from a screenshot every time. They live in `~/browserops/procedures/` (user-visible, not hidden) and are surfaced through six MCP tools: `procedures_list`, `procedures_search`, `procedures_get`, `procedures_save`, `procedures_promote`, `procedures_delete`.

The bridge auto-seeds `examples/procedures/` into `~/browserops/procedures/shared/` on first start (and on every `pnpm setup` / `node packages/bridge/dist/index.js init` run). Local copies are never overwritten — if a bundled example ships an update, the bridge logs a notice on stderr and you copy it manually if you want the new version.

Procedures default to `status: draft` until you record a successful run. `procedures_search` excludes drafts unless called with `include_drafts: true`. To mark one trusted, call `procedures_save` again with `bump_success: true` after a verified run; success_count increments and status flips to `trusted` once it reaches 1.

Bindings of the form `{{step.field}}` are validated at save time against the referenced tool's `outputSchema`. References to fields that don't exist on the tool's output are rejected with `PROC_SCHEMA_INVALID` before the procedure ever runs.

The procedure schema and search ranking live in `packages/shared/src/procedures.ts`.

Authoring checklist:
- Search first. If an existing procedure already covers the flow, reuse it and update it instead of writing a parallel version.
- Write leaves around real UI states. Each leaf should represent one stable transition and should not assume hidden onboarding, modal, or branching screens.
- Test every leaf on the live site before composing it. Do not save unverified procedures.
- Use only schema-supported fields from `packages/shared/src/procedures.ts`; do not invent `wait_for` or step-result shapes.
- Bind outputs only when the leaf returns those exact fields, and verify the bindings against the real result.
- Prefer explicit waits and success criteria over implicit assumptions.
- Split setup, onboarding, and final extraction into separate procedures when they are distinct screens or branches.
- If the UI changes, fix the leaf first, then update the composite.

## Safety defaults

- **Rate limit:** 16 actions/minute per tab, 60/minute globally. Exceeded → `RATE_LIMITED` with `retry_after_ms`.
- **Kill switch:** click the extension toolbar icon → **Disconnect**. Reconnect only from the options page (deliberate friction).
- **Approval mode:** auto-approve is the default. To require manual approval for risky actions, see [Approval mode](#approval-mode) above.
- **Sensitive domain list:** `~/.browserops/risky-domains.json` (extends the built-in defaults in `packages/bridge/src/risky-domains.ts`).

## Develop locally

If you want to hack on browserops itself rather than just use it:

```bash
git clone https://github.com/quaylabshq/browserops.git
cd browserops
pnpm setup
```

`pnpm setup` = `pnpm install && pnpm build && node packages/cli/dist/index.js init` (same wizard as the published `browserops init`, just driven from your clone). The build produces:

- `packages/cli/dist/index.js`        — the `browserops` CLI binary
- `packages/bridge/dist/index.js`     — the `browserops-bridge` MCP server binary
- `packages/extension/dist/`          — the unpacked Chrome extension

## Dev loop

```bash
pnpm dev
```

Starts four watchers in one terminal:

- `@browserops/shared` — `tsc -b --watch`, emits types on save
- `@browserops/bridge` — `tsx watch`, hot-restarts on save
- `@browserops/extension` — `vite build --watch`, rewrites `dist/` on save (crxjs auto-reloads the extension in Chrome)
- `browserops` (CLI) — `tsx watch`, hot-restarts on save

Edit shared protocol types in `packages/shared/src/`, implement handlers in `packages/extension/src/background/handlers/`, tweak the bridge dispatch pipeline in `packages/bridge/src/mcp-server.ts`, or extend the CLI in `packages/cli/src/`.

## Tests

```bash
pnpm test              # all unit tests
pnpm -F @browserops/bridge test   # bridge only
```

Currently ~220 unit tests total across shared (envelope guards, tool catalogue invariants, procedure schema) and bridge (rate limiter, risky-domain globs, procedure store, index builder, search ranker, handlers). A Playwright smoke suite is planned.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `BROWSEROPS_HOST` | `127.0.0.1` | WebSocket bind host (never `0.0.0.0` — enforced at startup) |
| `BROWSEROPS_PORT` | `57321` | WebSocket port |
| `BROWSEROPS_EXTENSION_ID` | empty = any | Origin allowlist; pin this to your extension id in production |
| `BROWSEROPS_GLOBAL_CAP` | `60` | Global rate-limit cap per minute |
| `BROWSEROPS_LOG_LEVEL` | `normal` | `normal` truncates strings > 200 chars; `audit` logs full payloads |
| `BROWSEROPS_APPROVAL` | `auto` | `auto` (default) or `gate`; controls approval mode for risky actions |
| `BROWSEROPS_TRACE` | unset | `=1` writes trace events including auto-approvals to `~/.browserops/trace.jsonl` |

## Troubleshooting

`browserops doctor` checks Node version, port availability, token presence, control-socket reachability, bundled-extension state, and which client binaries are on PATH. Start there.

**Extension shows "disconnected" after the client is running.**
Check `~/.browserops/log.jsonl` — look for `{"dir":"system","event":"boot"}`. If absent, the bridge didn't launch. Try `browserops status` (is the daemon up?) and `browserops doctor`. If the bridge is up but the extension can't reach it, confirm port and host in the extension's options page match the bridge.

**"Bad token" close (code 4001) in the log.**
Token mismatch — usually because `~/.browserops/token` was regenerated since the extension last paired. Easiest fix: restart the bridge (so it mints a fresh pair code), open the extension popup → **Run setup**, and confirm. Or paste the current token into the options page manually.

**`list_tabs` returns fewer tabs than I see in Chrome.**
The bridge mints `tab_id`s only for tabs the extension observed being created. Restart the extension (toggle off/on in `chrome://extensions`) to re-enumerate existing tabs — or close and reopen the tabs you care about.

**"full_page requires CDP attach (deferred to v2)".**
Use `full_page: false` (default). Full-page capture ships with the v2 CDP work.

**Port conflict on 57321.**
Set `BROWSEROPS_PORT=9876` in your MCP config's `env` block, and put the same in the extension's options page.

**Multiple MCP clients at once.**
The bridge supports a primary/secondary role split: the first process to bind `:57321` owns the WebSocket to the extension, and subsequent bridge processes (e.g. a second client in another editor) proxy through a local control socket. No config change needed — just register the same command in both clients.

## Project layout

```
browserops/
├── packages/
│   ├── shared/        # protocol types, error codes, tool catalogue
│   ├── bridge/        # @browserops/bridge — MCP + WebSocket server
│   ├── extension/     # MV3 extension (background SW, options, popup)
│   └── cli/           # browserops — CLI orchestrator (init, daemon, launchers)
└── examples/          # seed procedures you can copy into ~/browserops/procedures
```

## Published packages

| Package | Purpose |
|---|---|
| [`browserops`](https://www.npmjs.com/package/browserops) | CLI orchestrator. Provides `browserops init`, `--claude/--cursor/--codex`, lifecycle commands. Depends on `@browserops/bridge`. |
| [`@browserops/bridge`](https://www.npmjs.com/package/@browserops/bridge) | The MCP stdio server (`browserops-bridge` binary). What MCP clients spawn. |
