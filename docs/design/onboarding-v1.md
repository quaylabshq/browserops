# Onboarding v1 — single-command install

**Goal.** Take a brand-new user from "I heard about browserops" to "I'm using it" in one terminal command + one browser click. No copy-pasting tokens, no editing config files, no installing Node manually if we can avoid it.

**Status.** Plan locked 2026-06-10. Four open items at the bottom.

## End-state UX

```
$ curl -fsSL https://browserops.ai/install | bash

  browserops installer
  ────────────────────
  ✓ Node 20.11.1 detected
  ✓ Installed browserops@0.4.0 via npm
  ✓ Wrote MCP config for Claude Code
  ✓ Bridge started on 127.0.0.1:57321
  → Opening Chrome Web Store…
  → Waiting for extension install…
  ✓ Extension paired (id fcjc…bhnp)
  → Opening welcome page…
  ✓ Done.
```

Alternate paths, same end state:

```
$ npm install -g browserops && browserops init
$ npx browserops init                             # zero-install
```

User clicks once: **"Add to Chrome"** in the Web Store tab. Everything else is automatic.

## Architecture

```
┌──────────────────────────────────────────────────┐
│ npm registry — distribution + version control    │
│   browserops package (CLI + bridge, ~5 MB)       │
└──────────────────────────────────────────────────┘
        ▲                              │
        │ npm install -g               │ tarball fetch
        │                              ▼
┌──────────────────────────────────────────────────┐
│ install.sh (hosted browserops.ai/install)        │
│   ├─ Node ≥ 20 detect + actionable error         │
│   ├─ Optional brew-install offer (macOS)         │
│   ├─ npm install -g browserops                   │
│   └─ exec browserops init                        │
└──────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────┐
│ browserops init                                  │
│   ├─ detect Chrome (force-open via -a)           │
│   ├─ write MCP client configs                    │
│   ├─ spawn bridge in init-mode                   │
│   ├─ open Chrome → Web Store                     │
│   ├─ wait: pairConsumed → onConnectionChange     │
│   ├─ open Chrome → browserops.ai/welcome         │
│   └─ exit (MCP respawns bridge on next use)      │
└──────────────────────────────────────────────────┘
```

## Locked decisions

| #   | Decision                                                                                                                                                                     | Why                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| D1  | **npm is the sole distribution channel.** No GitHub Releases, no own CDN.                                                                                                    | Source repo is private; npm is the public CDN we'd need anyway. Free, version-pinned, well-trusted.     |
| D2  | **No vendored Node.** Require Node 20 LTS (or 18 if codebase allows — verify).                                                                                               | Audience already has Node. ~5 MB package, instant install, no codesigning concern.                      |
| D3  | **No codesigning.** Package is JS + shell shim, no native binaries.                                                                                                          | Eliminated by D1+D2.                                                                                    |
| D4  | **`install.sh` is a thin Node-check + npm wrapper.** Hosted at `browserops.ai/install` in `prathameshagrawal/browserops-web`.                                                | Cleaner UX than raw `npm install -g`; offers brew-install if Node missing; auto-runs init.              |
| D5  | **No human pair-code confirm.** Extension auto-stores token after `/pair` 200. Bridge pins first-pairing extension ID.                                                       | Confirm step's only purpose was anti-race against rogue extensions; ID pin covers it without the click. |
| D6  | **Bridge stays MCP-stdio-spawned.** Init-mode bridge exits after first hello; MCP respawns later via stored token.                                                           | Avoids daemon-arch change. Welcome page is static; tolerates the gap.                                   |
| D7  | **Force-open Chrome specifically** (not default browser). Detect via `/Applications/Google Chrome.app` / `which google-chrome`. Missing → open Chrome download page + abort. | Default-open sends Safari/Firefox users to a dead end.                                                  |
| D8  | **macOS + Linux for v1.** Windows is cheap to add (no native builds) but defer until extension flow is tested there.                                                         | Reduce v1 scope; ship faster.                                                                           |
| D9  | **Welcome page = `browserops.ai/welcome`** in `prathameshagrawal/browserops-web`. Static HTML.                                                                               | Push access confirmed.                                                                                  |
| D10 | **Extension ID hardcoded: `fcjcldlmaoincljnghkbhhalnjfmbhnp`.**                                                                                                              | Confirmed from live Web Store listing.                                                                  |
| D11 | **Install telemetry opt-out via `BROWSEROPS_NO_TELEMETRY=1`.** PostHog, `install.*` event prefix.                                                                            | Funnel measurement is worth it; opt-out is standard for dev tools.                                      |
| D12 | **npm package name:** `browserops` if available, else `@quaylabs/browserops`. Verify before Phase 1.                                                                         | TBD — see open questions.                                                                               |

## Phased delivery

### Phase 0 — browserops-web scaffolding _(half day)_

- Add `public/install` (bash script) and `public/welcome/index.html` to `prathameshagrawal/browserops-web`
- Configure Vercel/Next.js rewrites:
  - `browserops.ai/install` → returns script with `Content-Type: text/plain` (so `curl | bash` works reliably)
  - `browserops.ai/welcome` → static page
- Smoke test: `curl -fsSL https://browserops.ai/install | head -5` returns script header

### Phase 1 — npm release pipeline _(1 day)_

- `pnpm build` produces `dist/cli.js` + `dist/bridge.js` (esbuild bundle)
- `package.json` `"files"`: `["dist/", "bin/", "README.md", "LICENSE"]`
- `bin/browserops` shell shim → `exec node "$DIR/../dist/cli.js" "$@"`
- GitHub Actions: on tag → `pnpm build` → `npm publish` with `NPM_TOKEN`
- Verify: `npm view browserops` returns published version

### Phase 2 — `install.sh` _(1 day)_

- `set -euo pipefail`, trap cleanup on failure
- Detect Node: missing → actionable error (brew install on macOS with `[y/N]` consent if detected; else print platform-specific URL)
- Detect Node version: `< 20` → print upgrade path
- `npm install -g browserops@latest` (handle EACCES → suggest `--prefix=$HOME/.npm-global` or use sudo path)
- `exec browserops init`
- Hosted at `browserops.ai/install`

### Phase 3 — extension auto-pair _(1-2 days)_

- `packages/extension/src/onboard/index.ts`: remove Confirm button; auto-store token on `/pair` 200; trigger reconnect
- `packages/bridge/src/ws-server.ts`:
  - On first successful hello, persist `extension_id` to `~/.browserops/extension_id` (0600)
  - On subsequent `/pair` calls, reject if Origin's extension ID doesn't match the persisted one
  - `/pair` open for 10 min after bridge start OR until first successful pair (whichever sooner)
- Tests: `ws-server.test.ts` cases for ID persistence + rejection of mismatched origin

### Phase 4 — `browserops init` refactor _(2 days)_

- Chrome detection: `open -a "Google Chrome"` (mac), `which google-chrome` (linux); missing → open download page, abort with clear message
- Spawn bridge with `BROWSEROPS_INIT_MODE=1` (foreground, exits after hello)
- Open Chrome → `https://chromewebstore.google.com/detail/browserops/fcjcldlmaoincljnghkbhhalnjfmbhnp`
- Progress loop: poll `pairConsumed`, then await `onConnectionChange(true)` (5-min timeout; print pair-code fallback at 30s if no progress)
- On hello: open Chrome → `https://browserops.ai/welcome`
- Print MCP-client next-steps summary, exit cleanly
- New flags:
  - `--repair` — clear `extension_id`, redo pair
  - `--skip-extension` — CI / config-only mode

### Phase 5 — welcome page content _(half day, parallel)_

- Static HTML in `browserops-web/public/welcome/`
- Per-MCP-client tiles (Claude Code, Cursor, Zed) each with: logo + copyable example prompt
- Footer: docs link, `saket@browserops.ai` support

### Phase 6 — polish + safety _(1-2 days)_

- `browserops upgrade` → `npm install -g browserops@latest` + skills sync
- `browserops uninstall [--purge]` → `npm uninstall -g browserops` + optional token/extension_id/config wipe
- `SECURITY.md` update: document auto-pair rationale + ID pin
- Re-pair detection: if init waits 60s with no hello AND `extension_id` exists, prompt user to `--repair`

### Phase 7 — install telemetry _(half day)_

Funnel events from `install.sh` + `browserops init`:

- `install.start` `{os, arch}`
- `install.node_missing` / `install.node_old`
- `install.npm_complete` `{duration_ms}`
- `install.bridge_up`
- `install.webstore_opened`
- `install.pair_received`
- `install.hello_received`
- `install.welcome_opened`
- `install.abort` `{reason}`

No PII. PostHog same project as bridge telemetry, `install.*` prefix. Opt-out: `BROWSEROPS_NO_TELEMETRY=1`.

**Total: ~7-8 working days end-to-end.** Phase 0 / 1 / 3 parallelizable.

## Deferred to v2

- Windows installer (PowerShell + Edge store support)
- Homebrew tap (`brew install quaylabs/tap/browserops`) — fast follow after npm path proven
- Brave/Arc/Edge support via `--browser` flag
- Native messaging transport (revisit if `/pair` race attacks observed in the wild)
- Live-status welcome page (would need CORS allowance from browserops.ai → 127.0.0.1)
- Daemon-mode bridge (current MCP-stdio model is fine for v1)

## Open questions (need answers before Phase 1)

1. **npm package name.** Is `browserops` available on npmjs.org? If taken, fall back to `@quaylabs/browserops` (or another scope).
2. **Node version floor.** OK to require Node 20 LTS, or stretch to 18? Will grep the codebase to find the actual minimum once the answer is locked.
3. **Canonical source repo.** Confirm GitHub org/name (assumed `quaylabshq/browserops`) for CI workflow.
4. **`browserops.ai/install` content-type.** Vercel default may serve `.sh` as `text/x-sh`, which can confuse `curl | bash` in some shells. Will configure explicit `text/plain` header in the rewrite rule.
