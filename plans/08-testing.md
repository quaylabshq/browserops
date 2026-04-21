# 08 — Testing Strategy

## Scope

This plan defines the end-to-end testing strategy for browserops: unit tests for the isolated pieces of logic in each package, integration tests that exercise the bridge against a mock WebSocket extension client (no browser), and live-Chrome smoke tests that load the real MV3 extension into a real Chromium and drive fixture pages. It also covers CI wiring, flakiness controls, coverage targets, and a short manual-test checklist for things genuinely resistant to automation. It deliberately does **not** redefine the protocol, tools, or component internals — it only describes how we prove them correct.

---

## Inputs from other plans

- **00-overview.md §4 (Shared contracts).** Envelope shape, error codes, and tool prefix are the contract tests must assert against. Shared TypeScript types imported into every test file for live typechecking.
- **01-mcp-server.md.** The tool registration surface — the integration suite enumerates every registered tool and exercises it.
- **02-bridge-protocol.md.** WebSocket framing, handshake token, origin check. Mock extension must mimic the real handshake.
- **03-extension.md.** Build output path and extension id. The smoke runner needs the built extension directory to pass to Chromium.
- **04-tools.md.** Canonical tool list and per-tool param/result schemas. The integration suite is structurally a walk over this file.
- **05-element-refs.md.** Ref lifecycle rules. Both integration and smoke tests must assert `REF_STALE` behavior.
- **06-autonomy-safety.md.** Rate-limit formula, risky-action heuristic, kill-switch semantics. Unit tests own these.
- **07-dev-setup.md.** `pnpm` scripts (`test`, `test:integration`, `test:smoke`) and Playwright's Chromium version are pinned by that plan; this plan consumes them.

---

## Outputs to other plans

- A shared test fixture site (`tests/fixtures/`) that any later plan (e.g. a future tool plan) can reuse.
- A `MockExtensionClient` helper (exported from `packages/bridge/src/testing/`) that any bridge-side test can spin up.
- CI status gates: `unit` and `integration` are required for merge; `smoke` advisory until stabilized (see §CI).
- A release-gate **Manual checklist** that `07-dev-setup.md`'s release script reads and surfaces.

---

## Design

### Test levels

#### 1. Unit — Vitest

Runner: **Vitest**, colocated tests (`*.test.ts` next to source). Each package has an independent vitest config extending a root `vitest.base.ts`. No browser, no WebSocket, no filesystem writes outside `tmpdir()`. (Note: Vitest 1.x+ supports `vitest.workspace.ts` for multi-project monorepos — an alternative to the parallel configs approach. Either works.)

Mandatory targets (these must have direct unit tests; other code covered transitively is fine):

| Package | Target | What it asserts |
|---|---|---|
| `shared` | protocol envelope codec | `Request`/`Response`/`Event` round-trip; rejects missing fields, extra fields flagged but allowed, enforces `id` as UUIDv4. |
| `shared` | error-code enum | Every code in 00-overview §4.3 is present; no extras. |
| `bridge` | rate limiter math | Token-bucket with 16/min, 0.5 for read/screenshot, 1 for click/type/navigate; refill monotonic under fake timers; per-tab isolation. |
| `bridge` | risky-action heuristic | URL pattern matcher (bank/paypal/etc.), `execute_js` always risky, `<input type=password>` detection via passed-in element descriptor. Table-driven. |
| `bridge` | a11y-tree flattening | Given a fixture tree JSON, produces stable refs 1..N (0 is reserved per overview §4.1 / plan 05), preserves parent/child, strips hidden nodes. Snapshot-tested. |
| `bridge` | `sanitize_html.py` port | The existing Python helper is ported/wrapped; golden-file tests compare HTML-in → sanitized-out across ~20 fixtures covering script tags, event handlers, data URIs, svg, style. |
| `extension` | message router | Given a canned `Request`, dispatches to the right handler; unknown method → `INTERNAL`. (Pure function; no chrome.* needed.) |
| `extension` | ref store | Snapshot-N invalidates snapshot-(N-1); `REF_STALE` vs `REF_NOT_FOUND` differentiation. |

**Fake timers.** Rate limiter tests use `vi.useFakeTimers()`. No `setTimeout`-real tests anywhere in the unit suite.

**No chrome.* stubs in unit.** Anything that touches `chrome.*` is extracted behind an interface and a fake passed in; if it can't be, the test belongs in smoke.

#### 2. Integration — bridge + mock extension (no browser)

Runner: **Vitest** but separate config (`vitest.integration.config.ts`) with longer hook timeouts (15s). Runs via `pnpm test:integration`.

**Shape.** Each test:
1. Spins up the real bridge process in-memory (import, not spawn — avoids stdio wrangling).
2. Starts a `MockExtensionClient` — a small class that opens a WebSocket to the bridge and responds to every `request` with a scripted reply. Mock client sends `{type:'hello', token: TEST_TOKEN, extension_version: '0.0.0-test', protocol_version: 1}` (all four fields per overview §4.2) then awaits `hello_ack` before processing requests.
3. Sends an MCP `tools/call` directly to the bridge's MCP entry point (also in-memory; we don't go through stdio).
4. Asserts (a) the mock received the expected WS `Request` frame, (b) the MCP caller got the expected result/error.

**Matrix.** One describe-block per tool in `04-tools.md` — scope is the 18 v1 tools only; the 2 deferred v2 cookie tools (`get_cookies`, `set_cookie`) are explicitly not tested. Each has at minimum:
- Happy path: canned success response → MCP result shape validated against the tool's output schema.
- Error passthrough: canned `TAB_NOT_FOUND` response → surfaces as MCP error with same code.
- Timeout: mock never replies; bridge returns `TIMEOUT` after configured `timeout_ms` (use fake timers here too).
- Disconnect mid-flight: mock closes socket after receiving the request; bridge returns `EXTENSION_DISCONNECTED`.
- Rate limit: fire 17 × 1-cost actions in the same minute on the same tab; 17th → `RATE_LIMITED`.
- Risky path (where applicable) per plan 06 R3: `execute_js`, `browser.type` on a password field, clicking a button whose accessible name matches `/send|submit|buy|pay|delete|transfer|confirm|remove/i` on a sensitive-domain URL, OR `browser.type` with `submit:true` on a sensitive-domain URL → `RISKY_ACTION_DENIED` when confirmation is declined; success when accepted (simulated via a test hook).

Type safety: the mock client imports `Request`/`Response` from `packages/shared`, so drift between envelope definition and test scripts fails typecheck, not runtime.

**No CI-side browser needed.** The integration tier is what gives us fast, deterministic PR signal.

#### 3. Live-Chrome smoke — Playwright

Runner: **Playwright Test** (`@playwright/test`) in a separate project (`tests/smoke/`). Runs via `pnpm test:smoke`.

**Launch.** Playwright's `chromium.launchPersistentContext` with:

```
--disable-extensions-except=<build-dir>
--load-extension=<build-dir>
--no-first-run
--no-default-browser-check
```

A dedicated, throwaway user-data-dir per run (under `tmpdir()`), so we never touch the user's profile.

**Extension id.** After `launchPersistentContext`, await the background service worker via `const [sw] = await Promise.race([context.serviceWorkers(), context.waitForEvent('serviceworker')])`. Parse the extension id from `sw.url()` (format: `chrome-extension://<id>/background.js`). This is the documented Playwright API for MV3 extension tests. As a fallback, the id can be pinned deterministically via a packed-manifest key (decided in `03-extension.md`).

**Bridge.** Started once per test file (worker-scoped fixture), listens on an ephemeral port. The extension's options page is auto-populated with the shared token and port via a Playwright script (a `test.beforeAll` navigates to the options page and fills the fields).

**Fixture server.** A Node `http` server binds `127.0.0.1:0` (random port) and serves `tests/fixtures/` static files. Started as a worker fixture.

**Flow matrix (v1).** Each flow is one Playwright test. Assertion pattern: every test asserts **both** the bridge tool result **and** the resulting DOM state (read via a second `browser.read` call, or via Playwright's own page API for ground truth).

| # | Flow | Assertion |
|---|---|---|
| S1 | `new_tab` + `navigate(fixture/simple-form)` + `read` | Tool returns a11y tree with expected form fields; Playwright sees same URL. |
| S2 | `click` a button resolved by ref | Result ok; fixture page's button handler set `window.__clicked = true`. |
| S3 | `type` into a text input | Result ok; input's `.value` matches via Playwright `page.inputValue`. |
| S4 | `screenshot` | PNG bytes returned, non-empty, >5KB. |
| S5 | `read` on iframe page (same-origin) | Tree includes iframe children with distinct refs. |
| S6 | `read` on iframe page (cross-origin) | Tree includes iframe node with `cross_origin: true` marker; no children. |
| S7 | `read` on shadow-DOM page | Shadow children present, refs stable. |
| S8 | `wait_for(selector)` on JS-delayed page | Returns after element appears within timeout. |
| S9 | `type` on `<input type=password>` | Risky path triggers popup; simulated-accept completes; simulated-deny → `RISKY_ACTION_DENIED`. |
| S10 | `close_tab` | Result ok; Playwright sees tab gone. |

**Kill-switch** is verified in manual checklist (see below) — Playwright can't click the extension's toolbar icon reliably across Chromium versions.

### Fixtures

`tests/fixtures/` — plain static files, no build step:

- `simple-form.html` — one `<form>` with text/email/checkbox/submit.
- `iframe-same.html` — embeds `iframe-child.html` from same origin.
- `iframe-cross.html` — embeds a page served by a second http server on a different port (counts as cross-origin to Chromium).
- `shadow.html` — element with attached shadow root containing a button.
- `delayed.html` — injects `<div id="ready">` after 500ms.
- `long-scroll.html` — 300 vh of content for scroll testing.
- `password.html` — one `<input type="password">`.
- `iframe-child.html`, shared child.

Each fixture is dumb HTML with no external dependencies. The server has no dynamic routes.

### Mocking strategy

- **Mock WS client.** Roughly 100 LOC: `ws` library, takes a map of `method → (params) => result|error`, handles the handshake frame, supports scripted delays and scripted closes. Lives at `packages/bridge/src/testing/mock-extension-client.ts` and is importable by tests.
- **Fake timers** for anything timing-based.
- **No chrome.* mocks.** Either the code is behind a seam (unit-tested with a fake seam) or it runs in real Chromium (smoke). We explicitly do not invest in a chrome.* mock library — it's a tarpit.

### CI — GitHub Actions

Workflow: `.github/workflows/ci.yml`.

```
jobs:
  unit:          ubuntu-latest, pnpm test
  integration:   ubuntu-latest, pnpm test:integration
  smoke:         macos-latest, pnpm test:smoke   (continue-on-error: true initially)
  lint+types:    ubuntu-latest, pnpm lint && pnpm typecheck
```

- **unit** and **integration** are required checks for merge to `main`.
- **smoke** runs on `macos-latest` because our primary dev target is macOS Chrome and Playwright's Linux headless Chromium behaves differently under `--load-extension` (headful-only on Linux, adds flake). It uses Playwright's bundled Chromium pinned via `@playwright/test` version.
- **smoke** starts as `continue-on-error: true`; once green for 20 consecutive main-branch runs, we flip it to required. Tracked as a concrete follow-up issue.
- Cache: pnpm store + Playwright browsers (`~/Library/Caches/ms-playwright`).
- Before the smoke job runs tests, execute `npx playwright install --with-deps chromium` (gated on cache miss). Without this step, a cold cache causes the first CI run to fail finding the browser.
- Artifact upload on smoke failure: trace zips, screenshots, bridge log (`~/.browserops/log.jsonl`), extension service-worker console.

### Flakiness strategy

- **Retries.** Playwright `retries: 2` for smoke only. Unit and integration: zero retries — a retry there is a bug.
- **Logging on failure.** Playwright trace (`trace: 'on-first-retry'`), video (`video: 'retain-on-failure'`), screenshot on failure. Bridge log attached as test artifact via a Playwright fixture that copies `~/.browserops/log.jsonl` into the test output dir on failure.
- **Timeouts.** Per-test 60s smoke, 15s integration, 5s unit. No `page.waitForTimeout` — only event-based waits.
- **Determinism.** Random user-data-dir per run; fixture server on port 0; extension token regenerated per run.
- **Quarantine mechanism.** A `smoke-quarantine/` directory; tests moved there when flaky, with a linked issue and a 2-week SLA before either fixing or deleting.

### Coverage expectations

Measured with Vitest's `--coverage` (v8 provider).

| Package | Lines | Branches | Notes |
|---|---|---|---|
| `shared` | 90% | 80% | Tiny, easy to cover. |
| `bridge` | 80% | 70% | Includes the heuristics above. |
| `extension` | 40% | n/a | MV3 SW is genuinely hard to unit-test; coverage here is symbolic. Smoke is the real gate. |

Coverage enforced in CI via Vitest's built-in thresholds: `vitest.config.ts` specifies `test.coverage.provider = 'v8'` and `test.coverage.thresholds = { lines, branches, functions, statements }` per-package. CI runs `pnpm test --coverage` and Vitest fails the process when thresholds regress — no custom script needed. Uploaded to Actions summary; not gated on an external service.

### Manual test checklist

Lives at `docs/release-checklist.md` (created by the release plan later; this plan defines the content). A human runs this on macOS + Chrome stable before tagging a release:

1. **SW eviction survival.** Load extension; trigger an action; wait 10 minutes idle; trigger another action. Verify no reconnect error and no lost token.
2. **Kill switch.** While a `navigate` is in flight, click the extension toolbar icon. Verify the in-flight call returns `EXTENSION_DISCONNECTED` in the bridge log within 1 s. Verify reconnection works after toggling back on.
3. **Risky-action popup.** Trigger `execute_js`. Confirm popup renders, both "Allow once" and "Deny" work, and 30-second no-response defaults to deny.
4. **Cross-profile isolation.** Launch Chrome with a second profile; verify the extension does not appear there (user installed it on profile A only).
5. **Token rotation.** Delete `~/.browserops/token`; restart bridge; paste new token into extension options. Verify old token no longer authenticates.
6. **Gmail sanity.** Open Gmail, run `read`, confirm sanitized content returns within 5s and does not include `<script>` fragments.

Each item: pass/fail + a line of notes. Release blocks on any fail without an attached waiver.

---

## Risks & mitigations

1. **Playwright + MV3 `--load-extension` flake.** Chromium's extension loading is race-prone during startup; the SW may not be ready when the first test runs. **Mitigation:** a `beforeAll` fixture that awaits the background service worker via Playwright's documented API (`context.serviceWorkers()` / `context.waitForEvent('serviceworker')`) with a 15 s deadline. Tests never start before the SW is available. Also pin Chromium version via Playwright (no `channel: 'chrome'`) so OS-level Chrome updates can't destabilize CI.
2. **Cross-origin iframe testing is fragile.** Same-process vs OOPIF behavior depends on Chromium flags and the pages involved. **Mitigation:** run the cross-origin fixture across two independent `127.0.0.1` ports (different ports = different origins to the browser); assert a coarse contract — `cross_origin: true` marker present, no children — rather than testing deep iframe internals. Deep iframe tool semantics stay in 05-element-refs.md.
3. **SW eviction testability.** Chrome MV3 evicts idle service workers after ~30 s, but this is not exposed to Playwright and can't be forced reliably. **Mitigation:** unit-test the reconnect logic directly (timer-driven) in the extension's message router tests; leave real eviction to the manual checklist. Document in the extension plan that reconnect logic must be pure and testable without chrome.*.
4. **Mock-extension divergence.** The mock client could drift from what the real extension does and hide bugs. **Mitigation:** both the mock and the real extension import `Request`/`Response` from `shared`; the envelope codec unit tests gate both. Additionally, the integration suite's happy paths are re-run as a subset of smoke (same assertions, real extension) — divergence surfaces immediately.
5. **Headed browser in CI cost/time.** Extension loading requires headful on Linux; macos runners are 10× the minutes cost of ubuntu. **Mitigation:** keep smoke matrix small (≤15 flows), parallelize across Playwright workers, skip smoke on docs-only PRs via a path filter.

---

## Open questions

- Do we need a Windows smoke job? Probably not for v1 (non-goal), but we should confirm with `07-dev-setup.md` before locking CI.
- Is Playwright's bundled Chromium new enough to cover all `chrome.debugger` domains we use, or do we need to pin Chrome stable via `channel`? Defer to first-pass smoke run.
- Should the manual checklist be machine-assisted (a small TUI that records pass/fail)? Probably yes eventually; out of scope for v1.
- Coverage for `sanitize_html.py` port: do we test the Python original too, or only the port? Lean toward port-only if we're confident in behavioral parity, else add a golden diff.

---

## Acceptance checklist

- [ ] `pnpm test` runs Vitest across all three packages and exits 0.
- [ ] Each target in the §Unit table has at least one dedicated test file.
- [ ] `pnpm test:integration` spins up the bridge in-memory, connects `MockExtensionClient`, and passes for every tool in 04-tools.md across the matrix (happy, error, timeout, disconnect, rate-limit, risky).
- [ ] `MockExtensionClient` is exported from `packages/bridge/src/testing/` and imports types from `packages/shared`.
- [ ] `tests/fixtures/` contains all 8 fixture pages listed above; served by a Node http server that binds port 0.
- [ ] `pnpm test:smoke` runs Playwright with the real built extension and passes all 10 smoke flows on macos-latest.
- [ ] CI workflow `.github/workflows/ci.yml` has `unit`, `integration`, `smoke`, and `lint+types` jobs; smoke is `continue-on-error: true` with a tracked issue to flip it.
- [ ] Failure artifacts (trace, video, screenshot, bridge log) upload on any smoke failure.
- [ ] Coverage thresholds enforced in CI: shared ≥90% / bridge ≥80% / extension ≥40% lines.
- [ ] `docs/release-checklist.md` exists with the six manual items and pass/fail slots.
- [ ] No test in any tier uses `setTimeout`-based waits; all waits are event- or fake-timer-based.
- [ ] A README snippet in each package documents `pnpm test`, `pnpm test:integration`, `pnpm test:smoke`, and where to find failure artifacts.
