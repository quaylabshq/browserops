# 07 — Dev Setup

## Scope

Everything a new contributor needs to clone `browser-exp`, install deps, build all three packages, run the dev loop, load the extension into Chrome, and connect Claude Code to the bridge. Covers toolchain versions, pnpm workspace layout, per-package build choices, dev runners, extension loading, MCP registration, token bootstrap, and lint/format/git hygiene. **Out of scope:** component design (01–06), test strategy (08), CI, release/distribution (Chrome Web Store, npm publish). Those are either other sub-plans or deferred.

## Inputs from other plans

- **00-overview §8** — repo layout (`packages/shared`, `packages/bridge`, `packages/extension`) and the fact that this is a single `pnpm` workspace with one root `package.json`, one `tsconfig.base.json`.
- **00-overview §5** — shared-secret token lives at `~/.browser-exp/token`; extension options page needs to accept it.
- **00-overview §4** — WebSocket envelope types (`Request`/`Response`/`Event`) and error codes must be expressible from `packages/shared` to both bridge and extension.
- **01-mcp-server** — the bridge entry point is a Node binary that speaks MCP over stdio. Dev setup must produce a runnable `dist/index.js` with a shebang.
- **03-extension** — the extension is MV3; `dist/` must contain a valid `manifest.json` plus bundled background/options/popup assets loadable via "Load unpacked".

## Outputs to other plans

- **Package name scheme.** `@browser-exp/shared`, `@browser-exp/bridge`, `@browser-exp/extension`. Sub-plans should import types from `@browser-exp/shared` and reference these names in their code examples.
- **Runnable bridge path.** `packages/bridge/dist/index.js` is the absolute-path target users register as an MCP server. 01/02 should assume this path.
- **Extension load target.** **`packages/extension/dist/`** is what the user points Chrome at (NOT `packages/extension/` — a common first-time mistake). 03 writes its manifest and bundle there.
- **Token file path.** `~/.browser-exp/token`. Bridge creates it on first run; extension options page reads and stores it. Both sides reference this exact path.
- **Root scripts.** `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`. 08-testing hooks into `pnpm test`.

## Design

### 1. Toolchain

| Tool | Min version | Why |
|---|---|---|
| Node.js | 20.10 LTS | Native `fetch`, stable `node:test`, stable ESM, `--env-file` flag. |
| pnpm | 9.x | Workspace protocol, fast installs, strict peer handling. |
| TypeScript | 5.4 | `moduleResolution: "bundler"`, const type params, workspace `tsc -b` references. |
| Chrome | 120+ | Stable MV3 `chrome.debugger` + `chrome.scripting.executeScript` world: "MAIN". |

Declare engines in root `package.json`:

```json
{
  "engines": { "node": ">=20.10", "pnpm": ">=9" },
  "packageManager": "pnpm@9.12.0"
}
```

A `.nvmrc` pinned to `20` at repo root. A `.tool-versions` file for asdf users is optional; skip for v1.

### 2. Workspace layout

```
browser-exp/
├── package.json              # private: true, root scripts + devDeps only
├── pnpm-workspace.yaml
├── tsconfig.base.json        # strict: true, target ES2022, moduleResolution bundler
├── tsconfig.json             # references -> packages/*/tsconfig.json
├── .eslintrc.cjs
├── .prettierrc
├── .gitignore
├── .nvmrc
├── packages/
│   ├── shared/
│   ├── bridge/
│   └── extension/
└── scripts/
    └── dev.mjs               # concurrently runner if we prefer JS over pnpm -r
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

`tsconfig.base.json` (relevant bits):

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "composite": true
  }
}
```

### 3. `packages/shared` — pure types

- Package name: `@browser-exp/shared`.
- Export: `Request`, `Response`, `Event` envelope types (00-overview §4.2); `ErrorCode` union (§4.3); tool-name constants; default timeouts.
- Build: plain `tsc -b`, emits to `dist/` with `.d.ts`. No bundler — consumers use workspace protocol and tree-shake.
- `package.json`:

```jsonc
{
  "name": "@browser-exp/shared",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsc -b",
    "dev": "tsc -b --watch",
    "clean": "rm -rf dist"
  }
}
```

Both bridge and extension depend on it via `"@browser-exp/shared": "workspace:*"`.

Note: `@browser-exp/shared` is built with `tsc` (emits `.js`); its TypeScript sources use `.js` import extensions (`import x from './foo.js'`) so they work both under `moduleResolution: bundler` in bridge/extension and as plain ESM from Node if needed.

### 4. `packages/bridge` — tsup bundle with shebang

- Package name: `@browser-exp/bridge`.
- Entry: `src/index.ts`. First line of the bundled output must be `#!/usr/bin/env node`.
- Build with **tsup** (wraps esbuild): single-file ESM bundle to `dist/index.js`. Rationale over plain `tsc`:
  - One file to reference in MCP config — users don't need working `node_modules` at runtime paths.
  - Handles the shebang natively via `tsup`'s `banner` option.
  - ~100ms incremental rebuilds in watch.
- `tsup.config.ts`:

```ts
import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  dts: false, // bridge isn't imported; no .d.ts needed
});
```

- `package.json` scripts:

```jsonc
{
  "name": "@browser-exp/bridge",
  "type": "module",
  "bin": { "browser-exp-bridge": "./dist/index.js" },
  "scripts": {
    "build": "tsup",
    "dev": "tsx watch src/index.ts",
    "typecheck": "tsc -b --noEmit"
  },
  "dependencies": {
    "@browser-exp/shared": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.x",
    "ws": "^8.x"
  },
  "devDependencies": { "tsup": "^8.x", "tsx": "^4.x", "@types/ws": "^8.x" }
}
```

Post-build chmod is handled by tsup's banner + executable flag; if not, add `"postbuild": "chmod +x dist/index.js"`.

Note: Prefer putting `#!/usr/bin/env node` as the first line of `src/index.ts` rather than using tsup's `banner: { js: ... }`. Source-shebang triggers tsup's auto-chmod; banner-shebang does not. If using banner, add a postbuild `chmod +x dist/index.js` step explicitly.

### 5. `packages/extension` — Vite + @crxjs/vite-plugin

- Package name: `@browser-exp/extension` (private: true, never published).
- Bundler: **Vite 5** with **@crxjs/vite-plugin v2** (stable; pin to `^2.4.0`). Rationale:
  - Reads `manifest.json` as the entry graph — background service worker, content scripts, options page, popup all bundled from one manifest.
  - HMR for content scripts and options/popup; service-worker changes trigger extension reload.
  - Emits a valid MV3 `dist/`.
- `src/manifest.ts` exports the manifest object; `vite.config.ts` passes it to `crx({ manifest })`.
- `vite.config.ts` sketch:

```ts
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./src/manifest.js";
export default defineConfig({
  plugins: [crx({ manifest })],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
});
```

- Scripts:

```jsonc
{
  "scripts": {
    "build": "vite build",
    "dev": "vite build --watch --mode development",
    "typecheck": "tsc -b --noEmit"
  },
  "devDependencies": {
    "vite": "^5.x",
    "@crxjs/vite-plugin": "^2.4.0",
    "@types/chrome": "^0.0.270"
  }
}
```

Note: `vite build --watch` (rather than `vite dev`) is the correct mode for MV3 — the dev server doesn't help since Chrome loads files from disk. crxjs handles auto-reload on file changes via a helper injected into the service worker.

Note: The `@crxjs/vite-plugin` project is currently in a "seeking maintainers" phase — track upstream stability.

### 6. Root `package.json` scripts

```jsonc
{
  "private": true,
  "scripts": {
    "dev": "concurrently -n shared,bridge,ext -c cyan,green,magenta \"pnpm -F @browser-exp/shared dev\" \"pnpm -F @browser-exp/bridge dev\" \"pnpm -F @browser-exp/extension dev\"",
    "build": "pnpm -r --sequential build",
    "typecheck": "pnpm -r typecheck",
    "lint": "eslint . --ext .ts,.tsx,.mts,.cts",
    "format": "prettier --write .",
    "test": "pnpm -r test",
    "test:integration": "pnpm --filter @browser-exp/bridge test:integration",
    "test:smoke": "pnpm --filter @browser-exp/extension test:smoke",
    "clean": "pnpm -r clean && rm -rf node_modules"
  },
  "devDependencies": {
    "concurrently": "^9.x",
    "eslint": "^9.x",
    "@typescript-eslint/parser": "^8.x",
    "@typescript-eslint/eslint-plugin": "^8.x",
    "prettier": "^3.x",
    "typescript": "^5.4.0"
  }
}
```

`pnpm -r --sequential build` matters: `bridge` and `extension` both depend on `shared`'s `dist/`, so shared must build first. pnpm's topo order handles this when `sequential` is set.

Note: `test:integration` and `test:smoke` are referenced by 08-testing. `test:integration` runs the bridge's end-to-end MCP/WebSocket suite; `test:smoke` runs the Playwright smoke suite that loads the built extension into a real Chromium. Decide the exact package ownership per 08's structure — a root-level Playwright runner is an acceptable alternative to the `--filter` variant.

### 7. The dev loop (what actually happens when you run `pnpm dev`)

Three watchers in one terminal via `concurrently`:

1. **shared** — `tsc -b --watch`. Writes `packages/shared/dist/*.{js,d.ts}` on every save.
2. **bridge** — `tsx watch src/index.ts`. No build step; tsx transpiles on the fly. Restarts on save. Binds WebSocket `127.0.0.1:8765`, speaks MCP over stdio.
3. **extension** — `vite build --watch`. Rewrites `packages/extension/dist/` on every save. crxjs's reloader reloads the extension in Chrome.

Because `bridge` uses `tsx watch` (not built artifacts) in dev, it picks up changes to `@browser-exp/shared/src/*` only once that package emits to `dist/` — which `tsc -b --watch` does. No cross-linking gymnastics needed.

Alternative one-liners for contributors who want split terminals:

```bash
# terminal 1
pnpm -F @browser-exp/shared dev
# terminal 2
pnpm -F @browser-exp/bridge dev
# terminal 3
pnpm -F @browser-exp/extension dev
```

### 8. Loading the extension in Chrome

One-time, per contributor machine:

1. Run `pnpm build` (or `pnpm dev`) at least once so `packages/extension/dist/manifest.json` exists.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked**.
5. **Load unpacked: select `packages/extension/dist/` — NOT `packages/extension/`. A common first-time mistake.**
6. Chrome shows the extension with an id like `abcdefghijklmnopabcdefghijklmnop`. Note it — 03-extension references it for the bridge's `Origin` check.
7. Click the extension's **Details → Extension options** (or the toolbar icon → options).
8. Paste the contents of `~/.browser-exp/token` into the token field. Save.

After code changes during `pnpm dev`, crxjs triggers auto-reload. If the service worker gets wedged (rare), click the **Reload** arrow on `chrome://extensions`.

### 9. Wiring Claude Code to the bridge

Two supported paths:

**A. `claude mcp add` (preferred).** From the repo root after `pnpm build`:

```bash
claude mcp add browser-exp --scope user -- node "$PWD/packages/bridge/dist/index.js"
```

This writes to the user-scoped config (`~/.claude.json`). Verify with `claude mcp list`.

Note: `claude mcp add browser-exp --scope user -- node <abs-path>` puts the server in `~/.claude.json` (user-wide); default `--scope local` puts it in the current project only. Use `user` for the recommended setup.

**B. Manual edit of `~/.claude.json`** (or `claude_desktop_config.json` on the desktop app). Under `mcpServers`:

```jsonc
{
  "mcpServers": {
    "browser-exp": {
      "command": "node",
      "args": ["/Users/you/code/browser-exp/packages/bridge/dist/index.js"],
      "env": {}
    }
  }
}
```

Use absolute paths — Claude Code does not expand `~` or `$PWD` here. Restart Claude Code after editing.

During active development you may prefer pointing the MCP entry at `tsx`:

```jsonc
{
  "command": "pnpm",
  "args": ["-s", "-F", "@browser-exp/bridge", "exec", "tsx", "src/index.ts"],
  "cwd": "/abs/path/to/browser-exp"
}
```

Document both but default the README to the `dist/` variant because it's stable across `pnpm install` churn.

### 10. Token bootstrap

First time the bridge starts (dev or prod):

1. Checks `~/.browser-exp/token`. If missing: generates 32 random bytes, hex-encodes, writes with mode `0600`, also `mkdir -p ~/.browser-exp` (mode `0700`). Note: `fs.mkdir(path, { recursive: true, mode: 0o700 })` does not reliably honor `mode` on intermediate directories on all platforms; prefer `fs.mkdir` then `fs.chmod` as a follow-up for the final directory.
2. Logs to stderr (so Claude Code's MCP stdio isn't corrupted): `browser-exp: generated new token at ~/.browser-exp/token — paste its contents into the extension's options page.`
3. On subsequent runs, reads the file.

The extension stores its copy in `chrome.storage.local` after the user pastes it. Mismatch on the WebSocket handshake → bridge closes the socket; the user re-copies the token.

Contributor workflow on a fresh clone:

```bash
pnpm install
pnpm dev          # bridge starts, creates ~/.browser-exp/token
cat ~/.browser-exp/token   # copy to clipboard
# paste into chrome://extensions → browser-exp options
```

### 11. Lint & format

- **Prettier** at repo root, defaults plus `"singleQuote": false, "printWidth": 100`.
- **ESLint 9 flat config** (`eslint.config.mjs`) at root, extending `@typescript-eslint/recommended-type-checked`. Minimal custom rules:
  - `@typescript-eslint/no-floating-promises: error` (bridge has lots of async WebSocket handling).
  - `@typescript-eslint/consistent-type-imports: error`.
  - `no-console` off for bridge (stderr logging is intentional), warn for extension.
- No pre-commit hook in v1 — CI (future) will gate. Contributors run `pnpm lint` manually.

### 12. Git hygiene

`.gitignore` at root:

```
node_modules/
**/dist/
**/.turbo/
**/*.tsbuildinfo
.DS_Store
.env
.env.local
.vscode/
.idea/
# Never commit the user's token or local logs
.browser-exp/
```

The last entry is defense in depth — the actual token lives at `~/.browser-exp/`, outside the repo, but if a contributor ever symlinks it in, it stays untracked.

### 13. Release

Out of scope for v1 beyond `pnpm build` producing runnable artifacts. For reference, the three foreseeable tracks — to be addressed in a future packaging plan:

- **Bridge:** publish `@browser-exp/bridge` to npm as a `bin`, so users run `npx @browser-exp/bridge` in MCP config.
- **Extension:** Chrome Web Store submission. Requires signed zip of `packages/extension/dist/`, a listing, screenshots.
- **Versioning:** single root version, bumped together via Changesets.

Flagged, not designed.

## Risks & mitigations

1. **`@crxjs/vite-plugin` v2 is stable but in a "seeking maintainers" phase and occasionally lags Chrome upgrades.** — Pin to `^2.4.0` in `packages/extension/package.json` and note the known-good Chrome version in the README. Track upstream stability. Fallback plan: swap to plain `vite build` with a hand-written rollup config for the manifest entries (more ceremony, zero magic).
2. **Workspace type resolution lag.** Contributor saves `packages/shared/src/x.ts`, bridge editor shows stale types until shared's `tsc -b --watch` emits. — `pnpm dev` starts shared's watcher first; document the 1–2s lag; enable `"composite": true` + TS project references so editors (VS Code) resolve across packages without waiting for emit.
3. **Contributor loads the wrong folder into Chrome.** Picking `packages/extension/` instead of `packages/extension/dist/` produces confusing "manifest.json not found" errors. — README screenshot + the exact path in the load-unpacked step. Add a `postbuild` console note: `extension built — load-unpacked: packages/extension/dist/`.
4. **Absolute paths in MCP config rot when the repo moves.** Contributor relocates the checkout; Claude Code silently fails to spawn the bridge. — Prefer `claude mcp add` (which at least re-runs on setup) over hand-edited JSON; document the "command not found / ENOENT" symptom and the fix in the README troubleshooting section.
5. **tsx watch swallows unhandled rejections in the bridge during dev**, hiding real bugs until prod. — Bridge's `src/index.ts` installs `process.on("unhandledRejection", …)` and `process.on("uncaughtException", …)` handlers that log to stderr with a stack. Not dev-setup's to implement, but dev-setup's to require from 01.

## Open questions

- **License.** No license file chosen. Apache-2.0 vs. MIT vs. private-only. Defer until before first external contributor or npm publish.
- **CI.** Not in v1. Likely GitHub Actions with `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test` on PR. Where does Chrome integration-testing run — headful only locally, or headless on CI with Playwright? Defer to 08-testing.
- **Changesets vs. manual version bumps.** Not urgent; revisit when we publish.
- **Windows support.** Shebang + `~/.browser-exp/` assume POSIX. Most Claude Code contributors are on macOS/Linux; Windows via WSL works unmodified. Native Windows — defer.
- **Editor config.** Ship a `.vscode/extensions.json` recommending ESLint + Prettier + crxjs? Low cost; do it in first PR.

## Acceptance checklist

- [ ] `pnpm-workspace.yaml` lists `packages/*`; `pnpm install` from a fresh clone succeeds with no warnings about missing peers.
- [ ] `pnpm build` from a clean checkout produces all three of: `packages/shared/dist/index.js`, `packages/bridge/dist/index.js` (first line is `#!/usr/bin/env node`, file mode is executable), `packages/extension/dist/manifest.json`.
- [ ] `node packages/bridge/dist/index.js` starts, logs "listening on 127.0.0.1:8765" to stderr, and responds to an MCP `initialize` request on stdio.
- [ ] On a machine with no `~/.browser-exp/` directory, first bridge run creates the dir (mode 0700) and a token file (mode 0600, 64 hex chars).
- [ ] `pnpm dev` starts all three watchers in one terminal; editing `packages/shared/src/index.ts` causes the bridge (running via `tsx watch`) to hot-restart within 2 s.
- [ ] Chrome `chrome://extensions` → Load unpacked → select `packages/extension/dist/` loads the extension without errors; the toolbar icon appears; the options page opens and accepts a token.
- [ ] `claude mcp add browser-exp -- node /abs/path/to/packages/bridge/dist/index.js` registers the server and `claude mcp list` shows it; a fresh Claude Code session can call `browser.*` tools end-to-end.
- [ ] `pnpm typecheck` passes across all packages with zero errors.
- [ ] `pnpm lint` passes or reports only known, documented warnings.
- [ ] `.gitignore` prevents `node_modules/`, any `dist/`, and `.browser-exp/` from being tracked; `git status` on a built repo is clean.
- [ ] README's "Getting started" section walks a brand-new contributor from `git clone` to a working `browser.read` call in Claude Code in under 10 minutes.
