# browserops

**The MCP server that drives your live Chrome — observation-verified, with procedure memory.**

browserops plugs your real, logged-in Chrome browser into any MCP-compatible agent (Claude Code, Cursor, Zed, Continue, Windsurf, Codex CLI). Every mutating action returns a measurable `page_effect` — DOM mutations, URL/focus changes, network requests, console errors — so the agent can tell the difference between a click that worked and a click that vanished into a canvas. On top of that primitive: **procedure memory** (YAML action graphs the agent searches before re-planning) and **teach mode** (demonstrate once, replay forever, with capture-time secret redaction).

---

## Why browserops exists

LLM browser agents fail in one specific, expensive way: **silent success.** The tool returns `clicked: true` and the agent confidently moves on — but on a canvas-drawn editor, an SPA that swallowed the synthetic event, or a site that hard-checks `isTrusted`, nothing happened. The next step types into the wrong field. The step after that destroys data, or hallucinates an outcome that never occurred.

The standard fixes don't work. Headless browsers can't see your logged-in state, so they restart from a cold profile every run. Pure-vision agents re-screenshot and re-plan from pixels every single step, burning tokens and time to rediscover the same five clicks they made yesterday. Imperative scripting (Playwright, Puppeteer) gets the trusted-events story right but cedes the agentic part to whoever has time to author the script.

browserops takes the opposite stance:

1. **Drive the user's real Chrome profile.** Logged-in tabs, real cookies, real extensions. Not a shadow profile, not a mock.
2. **Observe after every action.** Every browser call returns a `page_effect` envelope the agent can assert on. Silent successes surface immediately — within one tool call — instead of cascading three steps later.
3. **Remember procedures.** Once a flow works, save it as a YAML action graph. Next time, `procedures_search` returns it before the agent ever plans from a screenshot. Effect-asserted replay catches drift the moment the UI changes.

That's the whole thesis: **observation-after-action plus procedure memory beats prompt-engineering your way around silent failures.**

## 30-second demo

```bash
# Universal first run — works for everyone
browserops "open hacker news and read me the top story"

# The capability demo — shows the live-profile advantage
browserops "check my gmail and summarize my last 3 emails"

# What procedure memory feels like once it warms up
browserops "weekly status: pull my last week of linear issues, my merged PRs, and draft a summary"
```

The first call to a flow does the work. The second call hits a saved procedure and replays it with effect-asserted steps. No prompt engineering, no re-planning from a fresh screenshot.

## Architecture

```
  ┌───────────────────────┐                       ┌──────────────────────┐
  │  MCP client           │                       │  Real Chrome         │
  │  (Claude Code,        │                       │  (your profile,      │
  │   Cursor, Zed,        │                       │   logged-in tabs)    │
  │   Continue, Windsurf, │                       │                      │
  │   Codex CLI)          │                       │  ┌────────────────┐  │
  └────────────┬──────────┘                       │  │ MV3 extension  │  │
               │ MCP / stdio                      │  │ (background SW │  │
               │ browser_*  procedures_*  teach_* │  │  + options +   │  │
               ▼                                  │  │  popup)        │  │
  ┌───────────────────────┐                       │  └───────┬────────┘  │
  │  browserops bridge    │   token-authed WS     │          │           │
  │  (Node, ~/.browserops)│◄─────────────────────►│          │           │
  │  ● MCP server         │   127.0.0.1:57321     │          │           │
  │  ● procedure store    │                       │          │           │
  │  ● rate limiter       │                       │   chrome.tabs        │
  │  ● risky-domain glob  │                       │   chrome.scripting   │
  │  ● teach recorder     │                       │   chrome.debugger    │
  └────────────┬──────────┘                       │   (gated domains)    │
               │                                  │          │           │
               │ control socket                   │          ▼           │
               │ (primary / secondary             │  ┌────────────────┐  │
               │  for multi-client)               │  │ Your real tabs │  │
               ▼                                  │  └────────────────┘  │
  ┌───────────────────────┐                       └──────────────────────┘
  │  Second MCP client    │
  │  proxied through      │
  │  primary bridge       │
  └───────────────────────┘
```

**The flow.** Your MCP client spawns `browserops-bridge` over stdio. The bridge opens a token-authed WebSocket on `127.0.0.1:57321` and waits for the extension to dial in. Tool calls travel client → bridge → WS → extension → real tab. The extension dispatches via `chrome.scripting` (synthetic events) or `chrome.debugger` (CDP, on gated domains for trusted events), then **observes the page for ~300 ms** and returns a `page_effect` envelope the agent can assert on.

**Multi-client.** The first bridge process to bind `:57321` becomes the primary and owns the extension WebSocket. Later bridge processes (a second editor, a sub-agent) proxy through a local control socket. No config change — register the same command in every client.

## Install & pair

### 1. Install the CLI

```bash
npm i -g browserops
```

`pnpm add -g browserops` and ad-hoc `npx browserops` also work.

### 2. Initialize

```bash
browserops init
```

One-shot wizard. Mints `~/.browserops/token`, seeds bundled procedures into `~/browserops/procedures/shared/`, starts the bridge daemon on `127.0.0.1:57321`, copies the unpacked Chrome extension to `~/.browserops/extension/`, detects your installed MCP clients (Claude Code, Cursor, Zed, Continue, Windsurf, Codex), and offers to register `browserops` in each. Idempotent — re-run any time.

Flags: `--yes` (non-interactive), `--no-mcp` (skip client install), `--client claude-code,cursor` (subset), `--dry-run` (print diffs).

### 3. Pair the Chrome extension

1. Open `chrome://extensions`, toggle **Developer mode** on (top right).
2. Click **Load unpacked** and select `~/.browserops/extension/` (the path was copied to your clipboard by `init`).
3. The onboarding tab opens automatically — click **Confirm & connect**. The toolbar icon turns green within a second.

### 4. Daily lifecycle

```bash
browserops status            # PID, port, uptime, last errors
browserops start             # bring the daemon up (no-op if already running)
browserops stop
browserops restart
browserops logs -f           # tail ~/.browserops/log.jsonl
browserops doctor            # diagnose Node / port / token / extension / clients
browserops upgrade           # bump global install + refresh extension files

browserops feature list                # show experimental features and state
browserops feature enable procedures   # opt into procedure memory
browserops feature enable teach        # opt into record-once teach mode
```

`procedures` and `teach` ship as **experimental** features, off by default. With both off, your agent gets the 26 always-on `browser_*` tools and nothing else — minimum token overhead. Run `browserops restart` after toggling.

## Quick start

Three example prompts, one per persona:

```bash
# Researcher
browserops "open the top 5 stories on hn and give me a one-line summary of each"

# Developer
browserops "go to my linear, pull every issue assigned to me in the current cycle,
            and group them by status"

# Ops / founder
browserops "check stripe for any failed payments today and draft me a follow-up email"
```

A bare `browserops "task"` routes through your default launcher (set during `init`). Force a specific one with `--claude`, `--codex`, or `--cursor`. Or just open the editor you registered and talk to it — the bridge is wired in as an MCP server.

## MCP clients

`browserops init` registers the bridge in every detected client automatically. The snippets below are for manual or non-detected setups. The bridge is a plain stdio MCP server (`browserops-bridge` on PATH after `npm i -g browserops`); any client that can spawn one can use it.

| Client | How to register |
|---|---|
| **Claude Code** | `claude mcp add browserops --scope user -- browserops-bridge` (verify with `claude mcp list`) |
| **Cursor** | `~/.cursor/mcp.json` → `{"mcpServers":{"browserops":{"command":"browserops-bridge"}}}` |
| **Zed** | `~/.config/zed/settings.json` → `{"context_servers":{"browserops":{"command":{"path":"browserops-bridge","args":[]}}}}` |
| **Continue** | `~/.continue/config.json` under `experimental.modelContextProtocolServers` → `[{"transport":{"type":"stdio","command":"browserops-bridge"}}]` |
| **Windsurf / Codeium** | `~/.codeium/windsurf/mcp_config.json` → `{"mcpServers":{"browserops":{"command":"browserops-bridge"}}}` |
| **Codex CLI** | `~/.codex/config.toml` → `[mcp_servers.browserops]\ncommand = "browserops-bridge"\nargs = []` |
| **Custom / SDK** | Spawn `browserops-bridge`, no args, no env vars (token + extension ID handled in `~/.browserops/`). |

All clients support an `env` block next to `command`. To bind a non-default port: `"env": { "BROWSEROPS_PORT": "9876" }` (mirror it in the extension's options page).

### Per-project agent rules

Claude Code and Codex CLI auto-discover rules (`CLAUDE.md` → symlink to `AGENTS.md`, and `AGENTS.md` respectively). Other clients need a one-time copy. Run inside any project where you want browserops to be agent-aware:

```bash
browserops install-rules
```

| Client | Slot |
|---|---|
| **Cursor** | `.cursor/rules/browserops.mdc` |
| **Windsurf / Codeium** | block in `.windsurfrules` |
| **GitHub Copilot** | block in `.github/copilot-instructions.md` |
| **Continue** | `customInstructions` in `.continue/config.json` |
| **Zed** | manual paste into Settings → Assistant → System prompt |

Re-running is idempotent — sentinel-comment block replacement, not append.

## The observation model

This is the thesis. The reason browserops exists.

Every mutating tool — `browser_click`, `browser_type`, `browser_press`, `browser_navigate`, `browser_execute_js`, and the rest — returns more than a boolean. It returns a `page_effect` envelope describing what actually happened in the page during a ~300 ms observation window after the action: which DOM nodes mutated, whether the URL or focus changed, what network requests fired, what was logged to the console, whether the active element shifted. The agent can read that envelope and ask the question every browser-driving agent should be asking but almost none do: *did anything actually happen?*

This single primitive kills the dominant failure mode of LLM browser agents — **silent success**. A click on a canvas-drawn doc editor that absorbs synthetic events without dispatching real handlers used to return `clicked: true` and the agent would charge forward. With observation-after-action, that same click returns `clicked: true, page_effect: { dom_mutations: 0, url_changed: false, network: [] }` and the agent immediately knows: nothing happened, try a different ref, escalate to CDP-attached trusted events, ask the user, or fail loudly. The cost of detecting the failure drops from "three steps later, after the flow has corrupted state" to "in the same call."

Tool calls can also declare `expect_effect` — an assertion the bridge evaluates on the agent's behalf. If you click "Send" and `expect_effect: { url_changed: true | network: [{ url: "/api/send", status: 200 }] }`, the bridge fails the call with a structured error if neither happens. This collapses the click-then-verify pattern from two LLM round-trips into one deterministic check, and gives procedure replay a way to halt the moment a UI drifts.

The deeper consequence is structural: agents stop re-planning every step from a screenshot. Once the first action is observation-verified, the next can be too. A flow that used to be "screenshot → reason → click → screenshot → reason → click" becomes "click with expectation → assert → click with expectation → assert," with the LLM only entering the loop on observation-detected anomalies. That's how you get from "agent can sort of use a browser" to "agent finishes the task on the first try."

## Procedure memory

> **Experimental — off by default.** Enable with `browserops feature enable procedures` (then `browserops restart`).

Procedures are named, parameterised, reusable action graphs that the agent can discover and replay without re-planning from a screenshot every time. They live in `~/browserops/procedures/` (user-visible, not hidden) and are surfaced through `procedures_list`, `procedures_search`, `procedures_get`, `procedures_save`, `procedures_promote`, `procedures_execute`, and `procedures_delete`.

A procedure is a YAML file. The minimum shape:

```yaml
id: gmail.summarize_inbox
title: "Summarize the most recent N emails in Gmail inbox"
status: draft           # → trusted after a verified successful run
inputs:
  - name: count
    type: integer
    default: 5
steps:
  - id: open_inbox
    tool: browser_navigate
    args:
      url: "https://mail.google.com/mail/u/0/#inbox"
    expect_effect:
      url_changed: true
  - id: read_list
    tool: browser_read
    args:
      tab_id: "{{open_inbox.tab_id}}"
      mode: "a11y_tree"
  - id: extract
    tool: browser_execute_js
    args:
      tab_id: "{{open_inbox.tab_id}}"
      code: "..."
```

**Search-first.** `procedures_search` ranks procedures against the query using title, tag, and step-tool signals, with a small recency boost for trusted procedures. Drafts are excluded by default — pass `include_drafts: true` to see them.

**Draft → trusted promotion.** Procedures default to `status: draft` until you record a successful run. Call `procedures_save` with `bump_success: true` after a verified run; `success_count` increments and `status` flips to `trusted` when it reaches 1. The agent only auto-uses trusted procedures.

**Effect-asserted replay.** `procedures_execute` walks the steps, applies bindings (`{{step.field}}` is validated at save time against the referenced tool's `outputSchema` — no runtime "field doesn't exist" surprises), and halts on the first step whose `expect_effect` doesn't match. The error envelope tells the agent which step drifted and why, so it can patch the leaf, not rewrite the procedure.

The seed examples in `examples/procedures/` are auto-copied into `~/browserops/procedures/shared/` on first run. Local copies are never overwritten — bundled updates log a notice on stderr and you copy them manually.

## Teach mode

> **Experimental — off by default.** Enable with `browserops feature enable teach` (requires `procedures` enabled). Restart after toggling.

Teach mode lets you demonstrate a flow once in your real browser while your agent watches live, then turns the recording into a reusable procedure. The whole workflow is agent-driven — there is no "record" button in the popup.

Tell your agent something like *"I don't think you have a procedure for this — watch what I do."* The agent calls the bridge's teach tools, you demonstrate the flow normally (clicking through pages, typing into fields, navigating between tabs — capture is **all-tabs** by default, not just the front tab), and the agent observes the timeline live. Say *"that's the flow"* when you're done; the agent stops the session, replays it to confirm, and saves it as a procedure draft.

**Privacy: redaction is at capture, not afterthought.** The content script blanks any password, OTP, or secret-pattern field at capture time before the value ever leaves the page. Redacted fields surface as inputs the agent will ask you for at run time, not constants baked into the saved procedure. Default secret patterns: `sk-*`, `AKIA*`, `ghp_*`, `xox*-*`, JWTs.

**Recording indicator.** While a session is active the toolbar badge shows red `REC` text and the popup gains a one-row red bar with an emergency Stop button. The badge is on regardless of whether the bridge is connected — capture is local to the extension; you'll always see when it's on.

**Storage.** Each session is two files in `~/browserops/teach-sessions/`: `<session_id>.jsonl` (one event per line) and `<session_id>.meta.json` (start/stop times, event count). Override with `BROWSEROPS_TEACH_DIR`.

## How browserops differs

| Capability | browserops | Playwright | Puppeteer | Browser-Use | Selenium |
|---|---|---|---|---|---|
| **Live, logged-in profile** (your real cookies, your real extensions) | Yes | No (fresh profile) | No (fresh profile) | No (fresh profile) | No (fresh profile) |
| **Observation-after-action** (`page_effect` envelope returned per call) | Yes | Manual (`waitFor`) | Manual (`waitFor`) | No (re-screenshot) | Manual (explicit waits) |
| **Procedure memory** (search-first action graphs, effect-asserted replay) | Yes | No | No | No | No |
| **Multi-client** (primary/secondary bridge, two editors at once) | Yes | N/A | N/A | N/A | N/A |
| **MCP-native** (zero-glue with Claude Code, Cursor, Zed, Continue, Windsurf, Codex) | Yes | No (script wrapper) | No (script wrapper) | Partial | No |
| **Teach mode** (record-once in real profile, redact at capture) | Yes | No | No | No | Recorder IDE |

## Safety model

- **Token-authed WebSocket.** The bridge mints a per-install token at `~/.browserops/token`; the extension presents it on connect, and the bridge closes any socket without it (code 4001).
- **Origin-pinned `EXTENSION_ID`.** Set `BROWSEROPS_EXTENSION_ID` to your installed extension's id and the bridge rejects connections from any other origin. Empty = any (development default).
- **Bind enforcement.** `BROWSEROPS_HOST` is enforced to be loopback-only at startup — never `0.0.0.0`.
- **Rate limits.** 16 actions/minute per tab, 60/minute globally. Exceeded → `RATE_LIMITED` with `retry_after_ms`. Override globally with `BROWSEROPS_GLOBAL_CAP`.
- **Risky-domain glob list.** `~/.browserops/risky-domains.json` extends the built-in defaults in `packages/bridge/src/risky-domains.ts`. Click/type/JS on a matching domain prompts under `BROWSEROPS_APPROVAL=gate`.
- **Hard refusals (any mode).** `javascript:`, `file://`, `chrome://` URLs. Destructive keyboard chords: `Primary+W`, `Primary+Q`, `Primary+T`, `Primary+N`, `Primary+Shift+N`, `Alt+F4`.
- **Gated-domain CDP attach.** On a curated domain list (Gmail, Slack, Notion, Linear, Discord, Figma) the extension auto-attaches `chrome.debugger` so synthetic input dispatches as trusted events. Chrome shows a "controlled by automation" banner while attached. Disable with `browserops feature disable gated-domains`.
- **Approval mode.** `BROWSEROPS_APPROVAL=gate` (or extension popup checkbox) flips to manual approval for risky actions. Default is auto-approve with a trace file when `BROWSEROPS_TRACE=1`.
- **Kill switch.** Click the toolbar icon → **Disconnect**. Reconnect only from the options page (deliberate friction).

### Launcher-side: safe mode

When `browserops "task"` spawns a launcher, it passes flags that skip the launcher's per-action approvals so the agent can complete autonomously:

| Launcher | What we pass |
|---|---|
| Claude Code | `claude --dangerously-skip-permissions` |
| Codex CLI | `codex exec --full-auto` (sandbox stays on) |
| Cursor | no CLI flag exists — set Cursor → Settings → Agent → Auto-Run to "Allow" |

Flip on `browserops config set safe_mode true` to restore the launcher's own per-action prompts. The browser-side gate is independent and unaffected.

## Available tools (v1)

Observation (no rate cost): `browser_list_tabs`, `browser_current_tab`, `browser_wait_for`

Navigation: `browser_new_tab`, `browser_close_tab`, `browser_switch_tab`, `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`

Content: `browser_screenshot` (viewport), `browser_read` (`text` / `markdown` / `sanitized_html` / `a11y_tree`)

Input: `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_hover`, `browser_execute_js`

Full JSON schemas in `packages/shared/src/tools.ts`.

**How click/type work.** First call `browser_read` with `mode: "a11y_tree"` on the tab — you get back a numbered tree of interactive elements and their refs. Then call `browser_click({tab_id, ref})` or `browser_type({tab_id, ref, text})` using those refs. Refs invalidate on navigation (same-doc or cross-doc) — re-read the tree after a navigation.

**v1 limitations.** Synthetic dispatch outside gated domains (`isTrusted: false` — reCAPTCHA and some banks will refuse). `browser_screenshot` with `full_page: true` returns `INTERNAL` — viewport-only in v1.

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
| `BROWSEROPS_TEACH_DIR` | `~/browserops/teach-sessions` | Override the directory where teach-mode sessions are recorded |
| `BROWSEROPS_FEATURES` | unset | Comma-separated experimental feature names to force-enable (e.g. `teach,procedures`). Overrides `~/.browserops/config.json` when set; empty string disables everything. Persistent toggles use `browserops feature enable/disable <name>` instead. |

## Troubleshooting

`browserops doctor` checks Node version, port availability, token presence, control-socket reachability, bundled-extension state, and which client binaries are on PATH. Start there.

**Extension shows "disconnected" after the client is running.** Check `~/.browserops/log.jsonl` — look for `{"dir":"system","event":"boot"}`. If absent, the bridge didn't launch. Try `browserops status` and `browserops doctor`. If the bridge is up but the extension can't reach it, confirm port and host in the extension's options page match.

**"Bad token" close (code 4001) in the log.** Token mismatch — usually because `~/.browserops/token` was regenerated since the extension last paired. Easiest fix: restart the bridge (so it mints a fresh pair code), open the extension popup → **Run setup**, and confirm. Or paste the current token into the options page manually.

**`list_tabs` returns fewer tabs than I see in Chrome.** The bridge mints `tab_id`s only for tabs the extension observed being created. Restart the extension (toggle off/on in `chrome://extensions`) to re-enumerate existing tabs — or close and reopen the tabs you care about.

**"full_page requires CDP attach (deferred to v2)".** Use `full_page: false` (default). Full-page capture ships with the v2 CDP work.

**Port conflict on 57321.** Set `BROWSEROPS_PORT=9876` in your MCP config's `env` block, and put the same in the extension's options page.

**Multiple MCP clients at once.** The bridge supports a primary/secondary role split: the first process to bind `:57321` owns the WebSocket to the extension; subsequent bridge processes proxy through a local control socket. No config change — register the same command in both clients.

## Roadmap

- **CDP trusted-events v2.** Promote click/type/press out of synthetic dispatch on every domain, not just the gated list — for sites that hard-check `isTrusted` (reCAPTCHA, some banks).
- **Full-page screenshots.** Pairs with the CDP work above. `browser_screenshot { full_page: true }` will return the full scroll height, not just the viewport.
- **Playwright smoke suite.** Cross-version regression coverage on top of the existing ~220 unit tests across shared (envelope guards, tool catalogue invariants, procedure schema) and bridge (rate limiter, risky-domain globs, procedure store, index builder, search ranker, handlers).

## Develop locally

```bash
git clone https://github.com/quaylabshq/browserops.git
cd browserops
pnpm setup
```

`pnpm setup` = `pnpm install && pnpm build && node packages/cli/dist/index.js init` (same wizard as the published `browserops init`, just driven from your clone).

```bash
pnpm dev    # four watchers: shared, bridge, extension, cli
pnpm test   # all unit tests
```

Build outputs:

- `packages/cli/dist/index.js` — the `browserops` CLI binary
- `packages/bridge/dist/index.js` — the `browserops-bridge` MCP server binary
- `packages/extension/dist/` — the unpacked Chrome extension

Layout:

```
browserops/
├── packages/
│   ├── shared/        # protocol types, error codes, tool catalogue
│   ├── bridge/        # @browserops/bridge — MCP + WebSocket server
│   ├── extension/     # MV3 extension (background SW, options, popup)
│   └── cli/           # browserops — CLI orchestrator
└── examples/          # seed procedures copied into ~/browserops/procedures
```

## Published packages

| Package | Purpose |
|---|---|
| [`browserops`](https://www.npmjs.com/package/browserops) | CLI orchestrator. `browserops init`, `--claude/--cursor/--codex`, lifecycle commands. Depends on `@browserops/bridge`. |
| [`@browserops/bridge`](https://www.npmjs.com/package/@browserops/bridge) | The MCP stdio server (`browserops-bridge` binary). What MCP clients spawn. |

## Contributing

The orchestration rules your agent must follow live in [`AGENTS.md`](./AGENTS.md) (Claude Code reads it via the `CLAUDE.md` symlink; Codex CLI reads it directly). The full operating guide for the `browser_*` and `procedures_*` tool surface — including the observation-centric execution model, trusted-vs-synthetic dispatch, sub-agent delegation rules, the per-tool cookbook, and the failure-mode → fix-it map — lives in [`skills/browserops.md`](./skills/browserops.md). Read both before opening a PR that touches tool semantics, the procedure schema, or the extension dispatch path.

## License

MIT.
