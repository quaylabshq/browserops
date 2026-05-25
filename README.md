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

This is a one-shot wizard. It mints `~/.browserops/token`, creates an empty `~/browserops/procedures/shared/` directory, starts the bridge daemon on `127.0.0.1:57321`, then detects your installed MCP clients (Claude Code, Cursor, Zed, Continue, Windsurf, Codex) and offers to register `browserops` in each of their configs. Re-running it is safe and idempotent.

Flags:
- `--yes` — non-interactive (accept all detected clients)
- `--no-mcp` — skip MCP-client install
- `--client claude-code,cursor` — explicit subset
- `--dry-run` — print diffs, don't write

### 3. Install the Chrome extension

Install the published extension from the Chrome Web Store:

[**browserops on the Chrome Web Store**](https://chromewebstore.google.com/detail/browserops/fcjcldlmaoincljnghkbhhalnjfmbhnp)

An onboarding tab opens automatically after install — click **Confirm & connect**. Chrome's toolbar icon turns green within a second.

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
browserops status            # PID, port, uptime, last errors
browserops start             # bring the daemon up (no-op if already running)
browserops stop
browserops restart
browserops logs -f           # tail ~/.browserops/log.jsonl
browserops doctor            # diagnose Node / port / token / clients / features
browserops upgrade           # bump the global install + run `browserops sync` + restart
browserops sync              # refresh skills + MCP-client config to match the installed package
browserops sync skills       # only refresh ~/.claude/skills/<name>/SKILL.md
browserops sync --dry-run    # preview without writing

browserops feature list                # show features and their state
browserops feature enable <name>       # opt in (e.g. procedures)
browserops feature disable <name>      # opt out (e.g. memory, if you don't want it)
```

**Heads-up on first sync after upgrading:** the next `browserops sync` (or `browserops upgrade`) installs the `browserops-teach` and `browserops-scribe` skills at `~/.claude/skills/<name>/SKILL.md` for the first time on machines that were on an earlier package version. Existing skills are refreshed in place, with a timestamped `.bak` if any local edits were detected.

`procedures` ships as an **experimental** feature — off by default. With it off, your agent gets the always-on `browser_*` tools and nothing else: minimum token overhead for users who only want basic browser automation. Opt in with `browserops feature enable procedures` and run `browserops restart` so the daemon broadcasts the new feature set to the extension. Once on, the agent gets the procedure-store tools (`procedures_search`, `_get`, `_save`, `_delete`, `_execute`) and the `browserops-teach` skill that authors new procedures autonomously.

`memory` is **on by default**. The agent gets six `memory_*` tools that read and write structured YAML records in `~/browserops/memory/` — visible to every MCP client on the same machine. Disable with `browserops feature disable memory` (then `browserops restart`) if you don't want cross-session memory.

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

`browserops init` registers the shim in every detected client automatically. The snippets below are for manual or non-detected setups — paste them into your client's MCP config. The shim is a plain stdio MCP server (`browserops-shim` on PATH after `npm i -g browserops`) that auto-spawns the long-lived daemon on first call, so multiple clients can share one Chrome profile concurrently.

### Claude Code

```bash
claude mcp add browserops --scope user -- browserops-shim
```

Verify with `claude mcp list`.

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "browserops": { "command": "browserops-shim" }
  }
}
```

### Zed

`~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "browserops": { "command": { "path": "browserops-shim", "args": [] } }
  }
}
```

### Continue (VS Code / JetBrains)

`~/.continue/config.json` under `experimental.modelContextProtocolServers`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      { "transport": { "type": "stdio", "command": "browserops-shim" } }
    ]
  }
}
```

### Windsurf / Codeium

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "browserops": { "command": "browserops-shim" }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.browserops]
command = "browserops-shim"
args = []
```

### Custom / SDK-based agents

Any client built on the official MCP SDKs can connect with `command: "browserops-shim"`, no args, no env vars (token + extension ID are handled through `~/.browserops/`).

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

Memory (always-on): `memory_save`, `memory_search`, `memory_get`, `memory_delete`, `memory_list_for_origin`, `memory_session_trace`

Procedures (opt-in via `browserops feature enable procedures`): `procedures_search`, `procedures_get`, `procedures_save`, `procedures_delete`, `procedures_execute`, `procedures_resume`

Full JSON schemas for each tool are declared in `packages/shared/src/tools.ts`.

**How click/type work.** First call `browser_read` with `mode: "a11y_tree"` on the tab — you get back a numbered tree of interactive elements and their refs. Then call `browser_click({tab_id, ref})` or `browser_type({tab_id, ref, text})` using those refs. Refs invalidate on navigation (same-doc or cross-doc) — re-read the tree after a navigation.

**v1 limitations:**
- Click / type fire synthetic DOM events (`isTrusted: false`). Sites that hard-check trusted events (reCAPTCHA, some banks) will refuse them. A CDP-based trusted-events path is planned for v2.
- `browser_screenshot` with `full_page: true` returns `INTERNAL` — viewport-only in v1.

## Procedures

> **Experimental — off by default.** Enable with `browserops feature enable procedures` (then `browserops restart`), or pick it during `browserops init`. With this feature off, the five `procedures_*` tools are hidden from your agent's catalogue and the in-process index isn't built — minimal token overhead for users who only want browser automation.

Procedures are named, parameterised, reusable action graphs the agent can discover and replay without re-planning from a screenshot every time. They live in `~/browserops/procedures/` (user-visible, not hidden) and are surfaced through five MCP tools: `procedures_search`, `procedures_get`, `procedures_save`, `procedures_delete`, `procedures_execute`.

The store ships empty — there are no bundled "default" procedures. New ones are authored on-demand by the **`browserops-teach`** skill (autonomous) or by hand via `procedures_save`. Past sessions accumulate via `bump_success: true`, so the store grows as the user uses it; nothing is shipped in the box.

Procedures default to `status: draft` until verified. `procedures_search` excludes drafts by default and falls back to including them when no trusted match exists. To mark a procedure trusted, call `procedures_save` with `bump_success: true` after a verified run; status flips to `trusted` and the entry surfaces in default search.

Bindings of the form `{{step.field}}` are validated at save time against the referenced tool's `outputSchema`. References to fields that don't exist on the tool's output are rejected with `PROC_SCHEMA_INVALID` before the procedure ever runs.

The procedure schema and search ranking live in `packages/shared/src/procedures.ts`.

### Authoring new procedures: the `browserops-teach` skill

When the agent decides nothing trusted covers a flow, it invokes the **`browserops-teach`** skill (at `~/.claude/skills/browserops-teach/SKILL.md`, mirrored to `skills/browserops-teach.md`). The skill is autonomous-by-default: one user prompt in, one message out. It pre-flight checks for an existing procedure, reads memory for app priors, probes the live page directly with `browser_*` tools, drafts the YAML in-context, verifies via `procedures_execute` against a goal-grounded predicate, then saves with `bump_success: true` on a clean run.

The agent asks at most one clarifying question, only when a hard safety gate fires:
1. **Cross-user side effects with no safe self-test path** (real recipients, real visibility).
2. **Money or account-level irreversibility** (payments, transfers, deletions, plan changes).
3. **Goal genuinely unparseable AND no app context in tabs/memory.**

For typical messaging goals like *"DM Pratham on Slack"* none of these gates fire — the agent goes silent immediately and reports once when done.

This replaces the older two-stage `teach` (manual demo recorder) + `autoteach` (iterative replay-and-optimize loop) machinery, which has been removed. With autonomous-by-default, the agent watches its own `browser_*` calls and authors the YAML in its own context — no separate keystroke recorder, no bridge-side replay loop, no transient session storage.

Authoring checklist (still applies when authoring procedures by hand):
- Search first. If an existing procedure already covers the flow, reuse it instead of writing a parallel version.
- Write leaves around real UI states. Each leaf should represent one stable transition.
- Test every leaf on the live site before composing it. Do not save unverified procedures (or save them as drafts and only `bump_success` after verification).
- Use only schema-supported fields from `packages/shared/src/procedures.ts`.
- Bind outputs only when the leaf returns those exact fields, and verify the bindings against the real result.
- Prefer explicit waits and success criteria over implicit assumptions.
- If the UI changes, fix the leaf first, then update the composite.

## Memory (cross-agent)

> **On by default.** Disable with `browserops feature disable memory` (then `browserops restart`). With the feature off, the six `memory_*` tools are hidden from `tools/list` and any direct call returns `FEATURE_DISABLED`.

A structured YAML store at `~/browserops/memory/` that any MCP client can read or write. The point is **cross-agent persistence**: a lesson saved from a Claude Code session is visible to a Cursor or Zed session opening the same browserops bridge later. It sits alongside (not on top of) Claude Code's own auto-memory at `~/.claude/projects/.../memory/`, which stays Claude-only by definition.

### Two stores

Records use a single `MemoryRecord` schema with a `scope` discriminator:

- **`global/<name>.yaml`** (`scope: "global"`) — cross-site facts: patterns that hold everywhere.
- **`sites/<origin-slug>/<name>.yaml`** (`scope: "site"`) — per-host facts; `origin` (e.g. `https://slack.com`) is required.

Record kinds: `blocker` (symptom `wall` + workaround `door`), `affordance`, `gotcha`, `lesson`, `selector` (carries a `Locator` descriptor, same as procedures).

### When to use it

Save a memory when the lesson is useful to *any* MCP client that might pick up the same browserops bridge — browserops behavior, browser-flow gotchas, per-site selectors, project context. Keep Claude-private things (keybindings, response style) in the auto-memory store.

### MCP tools

| Tool | Inputs | Output |
|---|---|---|
| `memory_save` | `record` (full `MemoryRecord`), `merge_into?`, `replace?:bool` | `{saved, path, created}` or `{possible_duplicate: {name, score}}` |
| `memory_search` | `query`, `scope?`, `origin?`, `kind?`, `limit?` | `{matches, total}` with `confidence` per match |
| `memory_get` | `name` | `{record, path}` |
| `memory_delete` | `name` | `{deleted, path}` |
| `memory_list_for_origin` | `origin`, filters | `{records}` for a specific host |
| `memory_session_trace` | `tab_id?` or `session_id?`, `limit?` | recent tool calls from the session ring buffer |

`name` matches `^[a-z][a-z0-9._-]{0,79}$`. Duplicate names reject with `MEMORY_ALREADY_EXISTS` unless `replace:true`. `memory_save` returns `possible_duplicate` when a near-match exists and `merge_into` is not supplied — pass `merge_into: "<name>"` to merge instead of creating a parallel record. Search results carry a `confidence` score; records whose delivered doors later fail are demoted automatically.

### Auto-capture

The bridge detects roadblock clusters (repeated errors, write-not-reflected, no-op effects, wait-for timeouts) and attaches a `capture_hint` to tool responses. The main agent reads the hint and spawns a background **`browserops-scribe`** subagent (haiku) that fetches the session trace, dedups against existing records, authors a structured YAML record, and saves it. No user action required.

### Delivery

When `memory` is on, the MCP `initialize` instructions always include a **global digest** — a confidence-ranked index of your top global records. Per-site records are injected as a terse `site_context` entry on the first tool call for each new (session, origin) pair, then suppressed for the rest of the session. Disable the feature to strip all memory tooling and documentation from the prompt. Override the storage root with `BROWSEROPS_MEMORY_DIR`.

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
- `packages/bridge/dist/index.js`     — the `browserops-shim` MCP server binary
- `packages/extension/dist/`          — the unpacked Chrome extension

For local development, load the unpacked extension from `packages/extension/dist/` via `chrome://extensions` → **Load unpacked**, instead of installing from the Chrome Web Store. That way you're testing your local changes.

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
pnpm eval:memory       # behavioral evals for the memory system (scorecard)
```

Unit tests span shared (envelope guards, tool catalogue invariants, procedure + memory schema) and bridge (rate limiter, risky-domain globs, procedure/memory stores, index builder, search ranker, confidence model, delivery, handlers). Beyond the unit tests, `pnpm eval:memory` runs a behavioral eval suite (`evals/memory/`) that verifies the memory system as named end-to-end capabilities — schema/redaction, store/migration, search/confidence/decay, hybrid delivery, capture signals, trace, and the headline "stops hitting the same wall twice" integration — printing a pass/fail scorecard. `evals/memory/tasks/` holds agentic (LLM-in-the-loop / live-browser) task specs with rubrics. A Playwright smoke suite is planned.

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
| `BROWSEROPS_FEATURES` | unset | Comma-separated feature overrides (e.g. `procedures`, `memory:false`). Overrides `~/.browserops/config.json` when explicitly set; an empty string disables all optional features. Persistent toggles use `browserops feature enable/disable <name>` instead. |
| `BROWSEROPS_MEMORY_DIR` | `~/browserops/memory` | Override the memory store root (`global/` and `sites/` subdirs are created inside it). |

## Troubleshooting

`browserops doctor` checks Node version, port availability, token presence, control-socket reachability, and which client binaries are on PATH. Start there.

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
└── skills/            # browserops + browserops-teach + browserops-scribe skill prompts
```

## Published packages

| Package | Purpose |
|---|---|
| [`browserops`](https://www.npmjs.com/package/browserops) | CLI orchestrator. Provides `browserops init`, `--claude/--cursor/--codex`, lifecycle commands. Depends on `@browserops/bridge`. |
| [`@browserops/bridge`](https://www.npmjs.com/package/@browserops/bridge) | The MCP stdio server (`browserops-shim` binary). What MCP clients spawn. |
