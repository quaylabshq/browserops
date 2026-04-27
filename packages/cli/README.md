# browserops

> Drive your real Chrome browser from any MCP-compatible AI client.

`browserops` is a CLI + MCP server that lets Claude Code, Cursor, Codex CLI, Continue, Windsurf, and any other MCP-aware agent control your live Chrome — clicking, typing, reading, navigating in tabs where you're already logged in.

## Install

```bash
npm i -g browserops
```

Requires: macOS · Linux · Windows-via-WSL · Node ≥ 20.10 · Chrome ≥ 120

## Quick start

### 1. Initialize

```bash
browserops init
```

One-shot wizard. Mints an auth token, starts the bridge daemon on `127.0.0.1:57321`, copies the unpacked Chrome extension to `~/.browserops/extension/`, detects your MCP clients (Claude Code · Cursor · Zed · Continue · Windsurf · Codex CLI) and offers to register `browserops` in each, and installs the Claude skill at `~/.claude/skills/browserops/`.

### 2. Pair the Chrome extension

1. Open `chrome://extensions`, toggle **Developer mode** on
2. Click **Load unpacked** and select `~/.browserops/extension/` (the path is copied to your clipboard during `init`)
3. Click **Confirm & connect** in the onboarding tab that opens

### 3. Use it

From the terminal — `browserops` ensures the bridge is running and hands off to your editor with the task pre-loaded:

```bash
# Universal first run — works for anyone
browserops "open hacker news and read me the top story"

# The capability demo — shows what a real, logged-in profile lets the agent do
browserops "check my gmail and summarize my last 3 emails"

# Force a specific launcher
browserops --claude "summarize my open tabs"
browserops --codex  "scrape the table on this page"
browserops --cursor "fill in the signup form with my profile"
```

A bare `browserops "task"` routes through your configured default launcher (set during init; change with `browserops config set default_launcher codex`).

Or just open the editor you registered in step 1 — `browserops` is now wired in as an MCP server, so any browser-related task picks it up automatically.

### 4. Per-project rules (optional)

```bash
cd /path/to/your/project
browserops install-rules
```

Writes the appropriate rules slot for each detected client: `.cursor/rules/browserops.mdc`, `.windsurfrules`, `.github/copilot-instructions.md`, `<cwd>/AGENTS.md` (Codex CLI), or `.continue/config.json`. Idempotent — re-running replaces the block in place via sentinel comments.

## Command surface

```
browserops init                     first-run wizard
browserops "task"                   route to configured default launcher
browserops --claude "task"          force-route to Claude Code
browserops --cursor "task"          force-route to Cursor
browserops --codex  "task"          force-route to Codex CLI
browserops status                   PID, port, uptime, last errors
browserops start | stop | restart   daemon lifecycle
browserops logs [-f]                tail ~/.browserops/log.jsonl
browserops doctor                   diagnose Node / port / token / extension / clients
browserops upgrade                  bump global install + refresh extension
browserops install-rules            per-project rules slots for non-auto-discover clients
browserops install-skill            install/refresh the Claude Code skill
browserops config [get|set|unset]   read/write ~/.browserops/config.json
```

## MCP prompts

Once registered as an MCP server, prompt-aware clients (Claude Code, Cursor, Continue, Codex CLI) surface these as slash commands:

- **`/browserops "task"`** — injects the full operating guide plus your task as a user message
- **`/browserops_procedure name=gmail.send_email task="..."`** — inlines a saved procedure's YAML so the agent has the exact step graph

## Tool surface

**Observation:** `browser_list_tabs` · `browser_current_tab` · `browser_wait_for` · `browser_wait_for_idle` · `browser_describe_ref` · `browser_query_selector` · `browser_quick_read` · `browser_read`

**Navigation:** `browser_new_tab` · `browser_close_tab` · `browser_switch_tab` · `browser_navigate` · `browser_back` · `browser_forward` · `browser_reload`

**Input:** `browser_click` · `browser_click_at` · `browser_click_by_text` · `browser_type` · `browser_press` · `browser_scroll` · `browser_hover` · `browser_find_and_replace` · `browser_execute_js`

**Media:** `browser_screenshot`

**Procedure runtime:** `procedures_list` · `procedures_search` · `procedures_get` · `procedures_save` · `procedures_promote` · `procedures_delete` · `procedures_compile` · `procedures_execute`

## Approval mode

Two independent gates:

**Browser-side** — auto-approve is the default. Risky actions (`browser_execute_js`, sensitive domains, procedures marked `risky: true`) run without prompting. Switch to gate mode with `BROWSEROPS_APPROVAL=gate browserops start`, or check the toggle in the extension popup. Destructive keyboard chords (`Cmd+W`, `Cmd+Q`, `Cmd+T`, `Cmd+N`, `Cmd+Shift+N`, `Alt+F4`) and navigations to `javascript:`, `file://`, or `chrome://` URLs are always refused regardless of mode.

**Launcher-side** — when you run `browserops "task"`, by default the CLI spawns the launcher with its permission prompts skipped so the agent can finish without pausing on every tool call:

| Launcher | What we pass |
|---|---|
| Claude Code | `claude --dangerously-skip-permissions` |
| Codex CLI | `codex exec --full-auto` (skips approvals, keeps the codex sandbox on) |
| Cursor | no CLI flag — set **Settings → Agent → Auto-Run** to "Allow" inside Cursor |

Restore the launcher's own per-action prompts with `browserops config set safe_mode true`. Browser-side gating (above) is unaffected.

## Procedure runtime

Procedures are named, parameterized, replayable action graphs stored under `~/browserops/procedures/`. The agent can search and run them with `procedures_search` / `procedures_execute` instead of re-planning from a screenshot every time. Six bundled examples seed on first run; you can save your own with `procedures_save`.

## Architecture

```
MCP client (Claude Code / Cursor / Codex / …)
      │ stdio MCP
      ▼
browserops-bridge   ← Node daemon · MCP server · WebSocket primary · rate limiter · risky-action gate
      │ ws://127.0.0.1:57321 (token-authed)
      ▼
browserops Chrome extension   ← chrome.tabs / chrome.scripting / chrome.debugger
      │
      ▼
your real Chrome tabs (logged-in sessions intact)
```

## Source

[github.com/quaylabshq/browserops](https://github.com/quaylabshq/browserops) — issues, contributions, full developer docs.

## License

MIT
