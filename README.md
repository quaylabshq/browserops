# browserops

An MCP server that drives your live Chrome browser. Any MCP-compatible client (Claude Code, Cursor, Zed, Continue, Windsurf, custom SDK agents, …) calls `browser_*` tools → a local Node bridge forwards them to a Chrome MV3 extension over WebSocket → the extension uses `chrome.tabs` / `chrome.scripting` / `chrome.debugger` to control your real browsing session (including logged-in sites).

See `plans/00-overview.md` for the full design.

## Prerequisites

- macOS or Linux (Windows via WSL)
- Node.js ≥ 20.10
- pnpm ≥ 9
- Chrome ≥ 120
- An MCP-compatible client (see [Connecting your MCP client](#connecting-your-mcp-client) below)

## Quick start

### 1. Install & build

```bash
pnpm install
pnpm build
```

This produces:

- `packages/bridge/dist/index.js` — the MCP server (Node binary, shebanged)
- `packages/extension/dist/` — the unpacked extension

### 2. Boot the bridge once to generate the token

```bash
node packages/bridge/dist/index.js
```

On first run it creates `~/.browserops/token` (32-byte hex, mode 0600) and prints its path on stderr. Copy the token to your clipboard, then `Ctrl-C` to stop.

```bash
cat ~/.browserops/token
```

### 3. Load the extension in Chrome

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked**.
4. **Select `packages/extension/dist/`** — not `packages/extension/`. Common mistake.
5. Note the extension id Chrome shows (32 chars, like `abcdefghijklmnopabcdefghijklmnop`).
6. Click the extension's **Details → Extension options**.
7. Paste the token from step 2. Leave host / port at defaults (`127.0.0.1` / `8765`). **Save**.

The options page status pill stays red ("disconnected") until the bridge is running — that's fine.

### 4. Register the bridge with your MCP client

See the next section. Pick the client you use.

### 5. Use it

Open your MCP client. Chrome's extension icon turns green ("connected") within a second of the client spawning the bridge. Ask the agent things like:

> What tabs do I have open?

> Open a new tab to news.ycombinator.com and read the top story.

> Take a screenshot of this tab.

## Connecting your MCP client

The bridge is a plain stdio MCP server. Any client that can spawn such a server can use it. The command to run is always:

```
node <path-to-repo>/packages/bridge/dist/index.js
```

(or, once published to npm, `npx browserops-bridge`).

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

## Available tools (v1)

Observation (no rate cost): `browser_list_tabs`, `browser_current_tab`, `browser_wait_for`

Navigation: `browser_new_tab`, `browser_close_tab`, `browser_switch_tab`, `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`

Content: `browser_screenshot` (viewport), `browser_read` (`text` / `markdown` / `sanitized_html` / `a11y_tree`)

Input: `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_hover`, `browser_execute_js`

See `plans/04-tools.md` for full schemas.

**How click/type work.** First call `browser_read` with `mode: "a11y_tree"` on the tab — you get back a numbered tree of interactive elements and their refs. Then call `browser_click({tab_id, ref})` or `browser_type({tab_id, ref, text})` using those refs. Refs invalidate on navigation (same-doc or cross-doc) — re-read the tree after a navigation.

**v1 limitations:**
- Click / type fire synthetic DOM events (`isTrusted: false`). Sites that hard-check trusted events (reCAPTCHA, some banks) will refuse them. The plan-05 CDP path is the v2 fix for trusted events.
- `browser_screenshot` with `full_page: true` returns `INTERNAL` — viewport-only in v1.
- Risky actions (`execute_js` always, click/type on financial domains) currently deny after the 30 s confirmation timeout because the extension popup doesn't yet render the confirmation UI. Set `BROWSEROPS_AUTOCONFIRM=1` to bypass during testing.

## Procedure runtime

Procedures are named, parameterised, reusable action graphs that the agent can discover and replay without re-planning from a screenshot every time. They live in `~/browserops/procedures/` (user-visible, not hidden) and are surfaced through six MCP tools: `procedures_list`, `procedures_search`, `procedures_get`, `procedures_save`, `procedures_promote`, `procedures_delete`.

To get started, copy an example from `examples/procedures/` into `~/browserops/procedures/shared/`:

```bash
mkdir -p ~/browserops/procedures/shared/gmail.send_email
cp examples/procedures/gmail.send_email/procedure.yaml \
   ~/browserops/procedures/shared/gmail.send_email/procedure.yaml
```

See `examples/procedures/` for annotated seed procedures and `plans/impl-06-procedures.md` for the full design (schema, search ranking, MCP tool specs, and disk layout).

## Safety defaults

- **Rate limit:** 16 actions/minute per tab, 60/minute globally. Exceeded → `RATE_LIMITED` with `retry_after_ms`.
- **Kill switch:** click the extension toolbar icon → **Disconnect**. Reconnect only from the options page (deliberate friction).
- **Risky actions** (execute_js always; click and type on financial / credential-manager domains): the bridge sends a `safety_prompt` to the extension; the popup UI for it is stubbed in v1, so these currently deny after the 30 s timeout. For unattended testing, set `BROWSEROPS_AUTOCONFIRM=1`.
- **Sensitive domain list:** `~/.browserops/risky-domains.json` (extends the built-in defaults in `packages/bridge/src/risky-domains.ts`).

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

Currently: 14 shared tests (envelope guards + tool catalogue invariants), 12 bridge tests (rate limiter math + risky-domain glob matching). Playwright smoke suite is planned; see `plans/08-testing.md`.

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
Token mismatch. Re-copy `~/.browserops/token` into the extension's options page. Save.

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
├── plans/             # design docs — 00-overview + 8 sub-plans
└── sanitize_html.py   # reference HTML sanitizer reused by read tool
```
