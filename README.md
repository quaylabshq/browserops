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

browserops feature list                # show experimental features and their state
browserops feature enable <name>       # opt into procedures or lore
browserops feature disable <name>      # opt out
```

**Heads-up on first sync after upgrading:** the next `browserops sync` (or `browserops upgrade`) installs the `browserops-teach` skill at `~/.claude/skills/browserops-teach/SKILL.md` for the first time on machines that were on an earlier package version — earlier releases shipped the skill in the repo but not in the published CLI bundle, so it was never installable. Existing `~/.claude/skills/browserops/SKILL.md` is refreshed in place, with a timestamped `.bak` if any local edits were detected.

`procedures` ships as an **experimental** feature — off by default. With it off, your agent gets the always-on `browser_*` tools and nothing else: minimum token overhead for users who only want basic browser automation. Opt in with `browserops feature enable procedures` and run `browserops restart` so the daemon broadcasts the new feature set to the extension. Once on, the agent gets the procedure-store tools (`procedures_search`, `_get`, `_save`, `_delete`, `_execute`) and the `browserops-teach` skill that authors new procedures autonomously.

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

| Launcher    | What we pass                                                                 |
| ----------- | ---------------------------------------------------------------------------- |
| Claude Code | `claude --dangerously-skip-permissions`                                      |
| Codex CLI   | `codex exec --full-auto` (skips approvals, keeps the codex sandbox on)       |
| Cursor      | no CLI flag exists — set Cursor → **Settings → Agent → Auto-Run** to "Allow" |

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

| Client               | How                                                                        |
| -------------------- | -------------------------------------------------------------------------- |
| **Claude Code**      | Reads `CLAUDE.md` (symlink → `AGENTS.md`) from the repo root automatically |
| **OpenAI Codex CLI** | Reads `AGENTS.md` from the repo root automatically                         |

All other clients need a per-project copy into their rules slot. Run from inside the project:

```bash
browserops install-rules
```

This writes the appropriate file for each detected client:

| Client                 | Slot                                                     |
| ---------------------- | -------------------------------------------------------- |
| **Cursor**             | `.cursor/rules/browserops.mdc` (frontmatter + AGENTS.md) |
| **Windsurf / Codeium** | block in `.windsurfrules`                                |
| **GitHub Copilot**     | block in `.github/copilot-instructions.md`               |
| **Continue**           | `customInstructions` in `.continue/config.json`          |
| **Zed**                | manual paste into Settings → Assistant → System prompt   |

Re-running `install-rules` is idempotent — it replaces the existing block in place via sentinel comments rather than appending duplicates.

## Available tools

**Tabs:** `browser_list_tabs`, `browser_current_tab`, `browser_new_tab`, `browser_close_tab`, `browser_switch_tab`, `browser_set_session_name`, `browser_release_tab`

**Navigation:** `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`

**Observation:** `browser_observe` (auto-picks the cheapest representation per page), `browser_read` (full a11y tree as serialised blob), `browser_quick_read` (find an element by label), `browser_describe_ref`, `browser_query_selector`, `browser_screenshot`, `browser_wait_for`, `browser_wait_for_idle`

**Input:** `browser_click`, `browser_click_at`, `browser_click_by_text`, `browser_type`, `browser_find_and_replace`, `browser_press`, `browser_hover`, `browser_scroll`, `browser_execute_js`, `browser_set_cdp`

**Locator helpers (procedures feature):** `browser_locate`, `browser_propose_locator`

**Procedures (procedures feature):** `procedures_search`, `procedures_get`, `procedures_save`, `procedures_delete`, `procedures_execute`, `procedures_resume`

**Cross-agent lore (lore feature):** `lore_save`, `lore_search`, `lore_get`, `lore_delete`

Full JSON schemas for each tool are declared in `packages/shared/src/tools.ts`.

**How click/type work.** Every http(s) tab the agent drives gets persistent `chrome.debugger` attached automatically. `browser_click` / `browser_click_at` / `browser_click_by_text` / `browser_type` / `browser_press` / `browser_hover` dispatch through CDP `Input.*` — trusted compositor events (`isTrusted: true`) that traverse iframes, shadow DOM, and `isTrusted`-gated handlers (Slack, Discord, Linear, Notion, Gmail rich editors, hover-only menus, canvas apps). Chrome's "controlled by automated test software" banner appears on every driven tab while CDP is attached — this is expected, not a failure signal. Opt out per-tab with `browser_set_cdp(tab_id, false)` if a site genuinely needs synthetic dispatch instead.

For element addressing, `browser_observe` is the cheapest path for general state reads; `browser_quick_read` finds a specific element by label; `browser_read` returns the full a11y tree. When authoring a procedure, `browser_propose_locator` walks a tier-1-first ladder (`aria_label`, `data_testid`, `href`, `attr`) and returns the smallest stable locator descriptor for an element.

**Limitations:**

- `browser_screenshot` with `full_page: true` returns `INTERNAL` — viewport-only.

## Procedures

> **Experimental — off by default.** Enable with `browserops feature enable procedures` (then `browserops restart`), or pick it during `browserops init`. With this feature off, the five `procedures_*` tools are hidden from your agent's catalogue and the in-process index isn't built — minimal token overhead for users who only want browser automation.

Procedures are named, parameterised, reusable action graphs the agent can discover and replay without re-planning from a screenshot every time. They live in `~/browserops/procedures/` (user-visible, not hidden) and are surfaced through five MCP tools: `procedures_search`, `procedures_get`, `procedures_save`, `procedures_delete`, `procedures_execute`.

The store ships empty — there are no bundled "default" procedures. New ones are authored on-demand by the **`browserops-teach`** skill (autonomous) or by hand via `procedures_save`. Past sessions accumulate via `bump_success: true`, so the store grows as the user uses it; nothing is shipped in the box.

Procedures default to `status: draft` until verified. `procedures_search` excludes drafts by default and falls back to including them when no trusted match exists. To mark a procedure trusted, call `procedures_save` with `bump_success: true` after a verified run; status flips to `trusted` and the entry surfaces in default search.

Bindings of the form `{{step.field}}` are validated at save time against the referenced tool's `outputSchema`. References to fields that don't exist on the tool's output are rejected with `PROC_SCHEMA_INVALID` before the procedure ever runs.

The procedure schema and search ranking live in `packages/shared/src/procedures.ts`.

### Authoring new procedures: the `browserops-teach` skill

When the agent decides nothing trusted covers a flow, it invokes the **`browserops-teach`** skill (at `~/.claude/skills/browserops-teach/SKILL.md`, mirrored to `skills/browserops-teach.md`). The skill is autonomous-by-default: one user prompt in, one message out. It pre-flight checks for an existing procedure, reads lore for app priors, probes the live page directly with `browser_*` tools, drafts the YAML in-context, verifies via `procedures_execute` against a goal-grounded predicate, then saves with `bump_success: true` on a clean run.

The agent asks at most one clarifying question, only when a hard safety gate fires:

1. **Cross-user side effects with no safe self-test path** (real recipients, real visibility).
2. **Money or account-level irreversibility** (payments, transfers, deletions, plan changes).
3. **Goal genuinely unparseable AND no app context in tabs/lore.**

For typical messaging goals like _"DM Pratham on Slack"_ none of these gates fire — the agent goes silent immediately and reports once when done.

This replaces the older two-stage `teach` (manual demo recorder) + `autoteach` (iterative replay-and-optimize loop) machinery, which has been removed. With autonomous-by-default, the agent watches its own `browser_*` calls and authors the YAML in its own context — no separate keystroke recorder, no bridge-side replay loop, no transient session storage.

Authoring checklist (still applies when authoring procedures by hand):

- Search first. If an existing procedure already covers the flow, reuse it instead of writing a parallel version.
- Write leaves around real UI states. Each leaf should represent one stable transition.
- Test every leaf on the live site before composing it. Do not save unverified procedures (or save them as drafts and only `bump_success` after verification).
- Use only schema-supported fields from `packages/shared/src/procedures.ts`.
- Bind outputs only when the leaf returns those exact fields, and verify the bindings against the real result.
- Prefer explicit waits and success criteria over implicit assumptions.
- If the UI changes, fix the leaf first, then update the composite.

## Lore (cross-agent)

> **Experimental — off by default.** Enable with `browserops feature enable lore` (then `browserops restart`). With the feature off, the four `lore_*` tools below are hidden from `tools/list` and any direct call returns `FEATURE_DISABLED`.

A small markdown store at `~/browserops/lore/<name>.md` that any MCP client can read or write. The point is **cross-agent persistence**: a lesson saved from a Claude Code session is visible to a Cursor or Zed session opening the same browserops bridge later. It sits alongside (not on top of) Claude Code's own auto-memory at `~/.claude/projects/.../memory/`, which stays Claude-only by definition.

### When to use it

Save a lore entry when the lesson is useful to _any_ MCP client that might pick up the same browserops bridge — browserops behavior, browser-flow gotchas, selectors that survive across sessions, project context. Keep Claude-private things (keybindings, response style) in the auto-lore store.

### MCP tools

| Tool          | Inputs                                                                                              | Output                        |
| ------------- | --------------------------------------------------------------------------------------------------- | ----------------------------- |
| `lore_save`   | `name`, `description`, `type` (`user`\|`feedback`\|`project`\|`reference`), `body`, `replace?:bool` | `{saved, path, created}`      |
| `lore_search` | `query`, `type?`, `limit?` (1..25, default 10), `min_score?` (0..1, default 0.2)                    | `{matches, total, truncated}` |
| `lore_get`    | `name`                                                                                              | `{meta, body, path}`          |
| `lore_delete` | `name`                                                                                              | `{deleted, path}`             |

`name` matches `^[a-z][a-z0-9._-]{0,79}$`. Duplicate names reject with `LORE_ALREADY_EXISTS` unless `replace:true`. Search returns metadata only — fetch the body with `lore_get`.

### Storage

Each lore entry is one markdown file with YAML frontmatter:

```markdown
---
name: feedback_terse_responses
description: user wants terse responses
type: feedback
source: mcp-tool
created: 2026-04-29T12:00:00.000Z
updated: 2026-04-29T12:00:00.000Z
---

Keep responses under three sentences whenever possible.
```

There is no index manifest by design — the bridge globs the directory and parses frontmatter on every `lore_search`. Override the root with `BROWSEROPS_LORE_DIR`.

When the `lore` feature is on, the MCP `initialize` instructions surfaced to your agent grow a short paragraph about `lore_save` / `_search` / `_get` / `_delete` — agents pick it up automatically on the next session. With the feature off, those tools and their documentation are stripped from both `tools/list` and the server instructions, keeping the prompt minimal.

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

- `packages/cli/dist/index.js` — the `browserops` CLI binary
- `packages/bridge/dist/index.js` — the `browserops-shim` MCP server binary
- `packages/extension/dist/` — the unpacked Chrome extension

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
```

Currently ~220 unit tests total across shared (envelope guards, tool catalogue invariants, procedure schema) and bridge (rate limiter, risky-domain globs, procedure store, index builder, search ranker, handlers). A Playwright smoke suite is planned.

## Environment variables

| Var                       | Default     | Purpose                                                                                                                                                                                                                                                         |
| ------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWSEROPS_HOST`         | `127.0.0.1` | WebSocket bind host (never `0.0.0.0` — enforced at startup)                                                                                                                                                                                                     |
| `BROWSEROPS_PORT`         | `57321`     | WebSocket port                                                                                                                                                                                                                                                  |
| `BROWSEROPS_EXTENSION_ID` | empty = any | Origin allowlist; pin this to your extension id in production                                                                                                                                                                                                   |
| `BROWSEROPS_GLOBAL_CAP`   | `60`        | Global rate-limit cap per minute                                                                                                                                                                                                                                |
| `BROWSEROPS_LOG_LEVEL`    | `normal`    | `normal` truncates strings > 200 chars; `audit` logs full payloads                                                                                                                                                                                              |
| `BROWSEROPS_APPROVAL`     | `auto`      | `auto` (default) or `gate`; controls approval mode for risky actions                                                                                                                                                                                            |
| `BROWSEROPS_TRACE`        | unset       | `=1` writes trace events including auto-approvals to `~/.browserops/trace.jsonl`                                                                                                                                                                                |
| `BROWSEROPS_FEATURES`     | unset       | Comma-separated experimental feature names to force-enable (e.g. `procedures,lore`). Overrides `~/.browserops/config.json` when explicitly set; an empty string disables everything. Persistent toggles use `browserops feature enable/disable <name>` instead. |
| `DO_NOT_TRACK`            | unset       | Standard signal. `=1` disables telemetry entirely (no PostHog events, no install-id alias).                                                                                                                                                                     |
| `BROWSEROPS_TELEMETRY`    | unset       | browserops-specific telemetry toggle. `=0` disables telemetry. Either this or `DO_NOT_TRACK` disables.                                                                                                                                                          |
| `BROWSEROPS_ALIAS_EMAIL`  | unset       | Explicit consent to ship the user's email to PostHog as a distinct-id alias (needed for cross-machine merging). Default off — email is **never** sent without this flag set to `1`.                                                                             |

## Telemetry

browserops ships **anonymous usage telemetry** to a PostHog instance (`https://us.i.posthog.com`). The intent is to detect regressions and prioritise features. There is **no** product surface other than that — no third-party sharing, no ads, no profiling.

**What is sent.** Tool name, error code, timing, OS platform/arch, Node major, bridge/cli version, install-id (random UUID, generated locally and stored at `~/.browserops/install-id`). The exact event allowlist is in [`packages/bridge/src/telemetry/redact.ts`](packages/bridge/src/telemetry/redact.ts) — every key not on the allowlist is dropped at the source.

**What is never sent.** Page text, URLs, tab titles, screenshots, the contents of typed input, file paths, MCP-tool payloads, search queries, procedure YAML bodies, lore entries, your email (unless you explicitly opt in — see below).

**Disabling telemetry.** Any of the following:

- `DO_NOT_TRACK=1` — industry-standard signal.
- `BROWSEROPS_TELEMETRY=0` — browserops-specific flag.

Either disables the PostHog client at boot. There is no fallback channel.

**Email alias is opt-in.** If you've set `identity.email` in `~/.browserops/config.json` (via `browserops identify` or `browserops init`), your email is **not** shipped unless you also export `BROWSEROPS_ALIAS_EMAIL=1`. This is deliberate: the email is only useful as an alias for cross-machine identity merging, and consent matters more than aliasing.

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
└── skills/            # browserops + browserops-teach skill prompts
```

## Published packages

| Package                                                                  | Purpose                                                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| [`browserops`](https://www.npmjs.com/package/browserops)                 | CLI orchestrator. Provides `browserops init`, `--claude/--cursor/--codex`, lifecycle commands. Depends on `@browserops/bridge`. |
| [`@browserops/bridge`](https://www.npmjs.com/package/@browserops/bridge) | The MCP stdio server (`browserops-shim` binary). What MCP clients spawn.                                                        |
