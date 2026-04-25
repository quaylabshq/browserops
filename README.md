# browserops

An MCP server that drives your live Chrome browser. Any MCP-compatible client (Claude Code, Cursor, Zed, Continue, Windsurf, custom SDK agents, …) calls `browser_*` tools → a local Node bridge forwards them to a Chrome MV3 extension over WebSocket → the extension uses `chrome.tabs` / `chrome.scripting` / `chrome.debugger` to control your real browsing session (including logged-in sites).

## Prerequisites

- macOS or Linux (Windows via WSL)
- Node.js ≥ 20.10
- pnpm ≥ 9
- Chrome ≥ 120
- An MCP-compatible client (see [Connecting your MCP client](#connecting-your-mcp-client) below)

## Quick start

### 1. Clone and set up

```bash
git clone https://github.com/<org>/browserops.git
cd browserops
pnpm setup
```

`pnpm setup` runs install + build + `browserops-bridge init` in one shot. The init step generates `~/.browserops/token`, seeds the bundled procedure examples into `~/browserops/procedures/shared/`, and prints copy-paste MCP client config snippets for Claude Code, Cursor, Zed, and Continue. Pick the snippet for the client you use and add it to that client's MCP config.

### 2. Start the bridge

```bash
pnpm start
```

Leave this running in a dedicated terminal. The bridge is what the Chrome extension connects to over WebSocket — without it running, the extension shows **disconnected** and the popup buttons have nothing to talk to. `pnpm start` rebuilds first and then launches the bridge in the foreground; use `pnpm start:fast` to skip the rebuild when you haven't changed code.

(MCP clients like Claude Code and Cursor also spawn their own bridge instance over stdio when they call a `browser_*` tool. That coexists with the one you started here — the first process to bind `:8765` owns the WebSocket and later ones proxy through a local control socket.)

### 3. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select `packages/extension/dist/` from this repo (produced by `pnpm setup`).
4. An onboarding tab opens automatically, showing a 6-digit **pair code**.
5. Match it against the `pair code XXX-XXX` line the bridge printed to stderr, then click **Confirm & connect**.

Chrome's extension icon turns green within a second. If you missed the onboarding tab, open the popup and click **Run setup**. Prefer the old copy-paste flow? Open the extension's options page and paste `~/.browserops/token` there.

### 4. Load the agent instructions

**This step is required.** The repo ships `AGENTS.md` with rules that tell your agent how to use browserops correctly. Without it your agent will re-plan steps that are already encoded in procedures, take unnecessary screenshots, and produce broken YAML.

- **Claude Code** and **OpenAI Codex**: already done — they auto-discover `CLAUDE.md` / `AGENTS.md` in the repo root.
- **Every other client**: see [Agent instructions](#agent-instructions) below for where to paste the file.

### 5. Use it

Open your MCP client (already configured with the snippet from Step 1) and try:

> What tabs do I have open?

> Open a new tab to news.ycombinator.com and read the top story.

> Take a screenshot of this tab.

## Connecting your MCP client

`pnpm setup` prints a snippet per client (re-run `node packages/bridge/dist/index.js init` any time you want them reprinted). The reference snippets below are kept for clarity if you'd rather configure by hand. The bridge is a plain stdio MCP server — any client that can spawn one can use it.

Command (from a clone):

```
node <path-to-repo>/packages/bridge/dist/index.js
```

Pick your client below.

### Claude Code

```bash
claude mcp add browserops --scope user -- node "$PWD/packages/bridge/dist/index.js"
```

Verify:

```bash
claude mcp list
```

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "browserops": {
      "command": "node",
      "args": ["/absolute/path/to/browser-exp/packages/bridge/dist/index.js"]
    }
  }
}
```

Then enable **browserops** under Cursor Settings → MCP.

### Zed

Add to `~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "browserops": {
      "command": {
        "path": "node",
        "args": ["/absolute/path/to/browser-exp/packages/bridge/dist/index.js"]
      }
    }
  }
}
```

### Continue (VS Code / JetBrains)

Add to your Continue `config.json` under `experimental.modelContextProtocolServers`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "node",
          "args": ["/absolute/path/to/browser-exp/packages/bridge/dist/index.js"]
        }
      }
    ]
  }
}
```

### Windsurf / Codeium

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "browserops": {
      "command": "node",
      "args": ["/absolute/path/to/browser-exp/packages/bridge/dist/index.js"]
    }
  }
}
```

### Custom / SDK-based agents

The bridge speaks MCP over stdio using `@modelcontextprotocol/sdk`. Any client built on the official Python, TypeScript, Java, or C# SDKs can connect with:

- `command`: `node`
- `args`: `["/absolute/path/to/browser-exp/packages/bridge/dist/index.js"]`
- no env vars required (token + extension ID are handled through `~/.browserops/`)

The bridge also runs fine as `npx browserops-bridge` when the `@browserops/bridge` package is published.

### Setting environment variables

All clients support an `env` block next to `command` / `args`. For example, to bind a non-default port, put:

```json
"env": { "BROWSEROPS_PORT": "9876" }
```

Then mirror the same port in the extension's options page.

## Agent instructions

**`AGENTS.md` is required every time you run browserops.** It contains the orchestration rules your agent must follow: procedure-first search before planning, when to use sub-agents, keyboard chord syntax, and procedure authoring rules. Without it, agents re-plan steps that are already encoded in procedures, take unnecessary screenshots, skip the `procedures_search` call, and produce invalid YAML. Load it once per client setup and it will be injected automatically on every session.

Two clients auto-discover it with no setup:

| Client | How |
|---|---|
| **Claude Code** | Reads `CLAUDE.md` (symlink → `AGENTS.md`) from the repo root automatically |
| **OpenAI Codex CLI** | Reads `AGENTS.md` from the repo root automatically |

All other clients need a one-time copy into their rules / system-prompt slot:

| Client | Where to add |
|---|---|
| **Cursor** | Create `.cursor/rules/browserops.mdc`. Add frontmatter `---\nalwaysApply: true\n---` at the top, then paste `AGENTS.md` below it. |
| **Windsurf / Codeium** | Append `AGENTS.md` to `.windsurfrules` in the repo root (create it if absent). |
| **GitHub Copilot** | Append `AGENTS.md` to `.github/copilot-instructions.md` (create it if absent). |
| **Continue** | Add the content to the `customInstructions` field in `.continue/config.json`. |
| **Zed** | Open Settings → Assistant → System prompt and paste the content. |
| **Amp** | Add a `.amp/instructions.md` file in the repo root with the content. |
| **Custom SDK agent** | Pass the full content as the system prompt when constructing the agent. |

The file is client-agnostic — the same text works in every slot listed above.

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
- Risky actions (`execute_js` always, click/type on financial domains) currently deny after the 30 s confirmation timeout because the extension popup doesn't yet render the confirmation UI. Set `BROWSEROPS_AUTOCONFIRM=1` to bypass during testing.

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
- **Risky actions** (execute_js always; click and type on financial / credential-manager domains): the bridge sends a `safety_prompt` to the extension; the popup UI for it is stubbed in v1, so these currently deny after the 30 s timeout. For unattended testing, set `BROWSEROPS_AUTOCONFIRM=1`.
- **Sensitive domain list:** `~/.browserops/risky-domains.json` (extends the built-in defaults in `packages/bridge/src/risky-domains.ts`).

## Develop locally

The Quick Start already clones and builds. `pnpm setup` = `pnpm install && pnpm build && node packages/bridge/dist/index.js init`; if you'd rather run the steps individually (or just rerun `init` to reprint the MCP snippets), they work standalone. The build produces `packages/bridge/dist/index.js` (the MCP server, shebanged) and `packages/extension/dist/` (the unpacked extension).

## Dev loop

```bash
pnpm dev
```

Starts three watchers in one terminal:

- `@browserops/shared` — `tsc -b --watch`, emits types on save
- `@browserops/bridge` — `tsx watch`, hot-restarts on save
- `@browserops/extension` — `vite build --watch`, rewrites `dist/` on save (crxjs auto-reloads the extension in Chrome)

Edit shared protocol types in `packages/shared/src/`, implement handlers in `packages/extension/src/background/handlers/`, or tweak the bridge dispatch pipeline in `packages/bridge/src/mcp-server.ts`.

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
| `BROWSEROPS_PORT` | `8765` | WebSocket port |
| `BROWSEROPS_EXTENSION_ID` | empty = any | Origin allowlist; pin this to your extension id in production |
| `BROWSEROPS_GLOBAL_CAP` | `60` | Global rate-limit cap per minute |
| `BROWSEROPS_LOG_LEVEL` | `normal` | `normal` truncates strings > 200 chars; `audit` logs full payloads |
| `BROWSEROPS_AUTOCONFIRM` | unset | `=1` auto-approves risky prompts (testing only; warns on stderr) |

## Troubleshooting

**Extension shows "disconnected" after the client is running.**
Check `~/.browserops/log.jsonl` — look for `{"dir":"system","event":"boot"}`. If absent, the bridge didn't launch. Run the client's MCP-list command (e.g. `claude mcp list`, Cursor's MCP settings page) to confirm it's registered and the command path resolves.

**"Bad token" close (code 4001) in the log.**
Token mismatch — usually because `~/.browserops/token` was regenerated since the extension last paired. Easiest fix: restart the bridge (so it mints a fresh pair code), open the extension popup → **Run setup**, and confirm. Or paste the current token into the options page manually.

**`list_tabs` returns fewer tabs than I see in Chrome.**
The bridge mints `tab_id`s only for tabs the extension observed being created. Restart the extension (toggle off/on in `chrome://extensions`) to re-enumerate existing tabs — or close and reopen the tabs you care about.

**"full_page requires CDP attach (deferred to v2)".**
Use `full_page: false` (default). Full-page capture ships with the v2 CDP work.

**Port conflict on 8765.**
Set `BROWSEROPS_PORT=9876` in your MCP config's `env` block, and put the same in the extension's options page.

**Multiple MCP clients at once.**
The bridge supports a primary/secondary role split: the first process to bind `:8765` owns the WebSocket to the extension, and subsequent bridge processes (e.g. a second client in another editor) proxy through a local control socket. No config change needed — just register the same command in both clients.

## Project layout

```
browserops/
├── packages/
│   ├── shared/        # protocol types, error codes, tool catalogue
│   ├── bridge/        # MCP + WebSocket server (single Node process)
│   └── extension/     # MV3 extension (background SW, options, popup)
└── examples/          # seed procedures you can copy into ~/browserops/procedures
```
