# browserops

Claude Code plugin that drives your live Chrome browser. Claude calls MCP tools → a local Node bridge forwards them to a Chrome MV3 extension over WebSocket → the extension uses `chrome.tabs` / `chrome.scripting` / `chrome.debugger` to control your real browsing session (including logged-in sites).

See `plans/00-overview.md` for the full design.

## Prerequisites

- macOS or Linux (Windows via WSL)
- Node.js ≥ 20.10
- pnpm ≥ 9
- Chrome ≥ 120
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed

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

### 4. Register the bridge as an MCP server in Claude Code

```bash
claude mcp add browserops --scope user -- node "$PWD/packages/bridge/dist/index.js"
```

Verify:

```bash
claude mcp list
```

Claude Code launches the bridge on demand. You don't need to leave `node .../index.js` running — the MCP registration handles process lifecycle.

### 5. Use it

Open Claude Code. Chrome's extension icon turns green ("connected") within a second. Ask Claude things like:

> What tabs do I have open?

> Open a new tab to news.ycombinator.com and read the top story.

> Take a screenshot of this tab.

## Available tools (v1)

Observation (no rate cost): `browser.list_tabs`, `browser.current_tab`, `browser.wait_for`

Navigation: `browser.new_tab`, `browser.close_tab`, `browser.switch_tab`, `browser.navigate`, `browser.back`, `browser.forward`, `browser.reload`

Content: `browser.screenshot` (viewport), `browser.read` (`text` / `markdown` / `sanitized_html` / `a11y_tree`)

Input: `browser.click`, `browser.type`, `browser.press`, `browser.scroll`, `browser.hover`, `browser.execute_js`

See `plans/04-tools.md` for full schemas.

**How click/type work.** First call `browser.read` with `mode: "a11y_tree"` on the tab — you get back a numbered tree of interactive elements and their refs. Then call `browser.click({tab_id, ref})` or `browser.type({tab_id, ref, text})` using those refs. Refs invalidate on navigation (same-doc or cross-doc) — re-read the tree after a navigation.

**v1 limitations:**
- Click / type fire synthetic DOM events (`isTrusted: false`). Sites that hard-check trusted events (reCAPTCHA, some banks) will refuse them. The plan-05 CDP path is the v2 fix for trusted events.
- `browser.screenshot` with `full_page: true` returns `INTERNAL` — viewport-only in v1.
- Risky actions (`execute_js` always, click/type on financial domains) currently deny after the 30 s confirmation timeout because the extension popup doesn't yet render the confirmation UI. Set `BROWSEROPS_AUTOCONFIRM=1` to bypass during testing.

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

**Extension shows "disconnected" after Claude Code is running.**
Check `~/.browserops/log.jsonl` — look for `{"dir":"system","event":"boot"}`. If absent, the bridge didn't launch; `claude mcp list` should show it.

**"Bad token" close (code 4001) in the log.**
Token mismatch. Re-copy `~/.browserops/token` into the extension's options page. Save.

**`list_tabs` returns fewer tabs than I see in Chrome.**
The bridge mints `tab_id`s only for tabs the extension observed being created. Restart the extension (toggle off/on in `chrome://extensions`) to re-enumerate existing tabs — or close and reopen the tabs you care about.

**"full_page requires CDP attach (deferred to v2)".**
Use `full_page: false` (default). Full-page capture ships with the v2 CDP work.

**Port conflict on 8765.**
Set `BROWSEROPS_PORT=9876` in your MCP config's `env` block, and put the same in the extension's options page.

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
