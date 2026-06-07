# Changelog

All notable changes to browserops are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Before 1.0, the `0.MINOR.PATCH` line follows: `MINOR` for breaking changes, `PATCH` for fixes and additive features.

## [Unreleased]

### Added

- Public OSS launch: root `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, GitHub issue + PR templates, `CODEOWNERS`.
- Telemetry consent surface: `BROWSEROPS_TELEMETRY=0` env to disable, `BROWSEROPS_ALIAS_EMAIL=1` env required to alias the install-id to the user's email (default: never aliased).
- Dedicated `## Telemetry` README section documenting the exact field allowlist and disable channels.

### Changed

- `@browserops/shared` is now a publishable package (was workspace-private). This unblocks `@browserops/bridge` install from the npm registry — the prior `private:true` left a dangling devDep reference in published tarballs.
- `eslint.config.mjs` switched to `projectService: true` (typescript-eslint v8) so per-file tsconfig is auto-discovered. `tsup.config.ts` / `vitest.config.ts` are explicitly ignored.
- `packages/bridge/README.md` and `packages/cli/README.md` corrected: the bridge ships `browserops-daemon` + `browserops-shim` binaries (not the non-existent `browserops-bridge`). The procedure store ships empty (the "six bundled examples" claim was wrong).
- Root README "Available tools" section refreshed to cover all current tools (was missing ~13 tools added since v0.0.5). The "synthetic DOM events" limitation note was removed — CDP-trusted input has been the default since v0.0.7.

### Fixed

- `mapStepDoToToolName` in `packages/bridge/src/procedures/execute.ts` had a duplicate `case "procedure_call"` branch (dead code). Replaced with an exhaustive `default` arm.
- 3 unhandled promise rejections in extension UI handlers (`onboard/index.ts:126`, `popup/index.ts:150`, `background/index.ts:355`).
- Unused imports and dead-code sweep across CLI, bridge, and extension packages (`pnpm lint` now exits 0).

### Security

- Repository PII scrub before public flip: removed personal email fixtures from `packages/bridge/src/telemetry/redact.test.ts`, removed absolute filesystem path from `packages/extension/src/popup/DESIGN.md`.
- Added `SECURITY.md` with private disclosure path (GitHub Security Advisories + `security@quaylabs.io`) and 90-day coordinated disclosure window.
- Tightened `.gitignore` to block common secret-shaped files (`.env.*`, `*.pem`, `*.key`, `.envrc`, `secrets.json`, `*.tfstate`).

## [0.0.9] – 2026-06-09

### Added

- **Unified procedures runtime.** Single feature flag (`procedures`), single tool family (`procedures_*`), single executor. Replaces the prior dual playbooks + procedures split. Composite procedures call leaf procedures via `do: procedure_call` with in-process dispatch (no extra extension round-trip).
- **Drift-health recorder + auto-demote.** The execute loop records per-step health (runs, relocate-rate, target-changed, last-tier, avg-match-count) into `meta.health`. `procedures_save({bump_success:true})` refuses the trusted flip when health degrades; the save still proceeds but the response carries `demoted: true` and `demote_reason`.
- **`browser_propose_locator` MCP tool.** Walks a candidate ladder of tier-1 stable fields (`aria_label`, `data_testid`, `href`, `attr`) and returns the smallest, highest-tier descriptor that uniquely resolves to a target ref. Used by the `browserops-teach` skill during procedure authoring.
- **Locator uniqueness scorer + candidate generator** (`packages/extension/src/lib/locator-propose.ts`).
- **Tier-1 stable attribute resolution.** `browser_locate` now resolves on `aria_label`, `data_testid`, `href`, and `attr` matchers in addition to the original `role/name/has_text` set.
- **`browser_observe` with auto-mode.** Picks the cheapest representation per page (augmented a11y, action-grade screenshot, box-drawing summary, or diff against a prior `observation_token`).
- **Observation-token-based diff observe.** Re-observation queries against a saved snapshot return only what changed.

### Changed

- CLAUDE.md / AGENTS.md rewritten for the unified procedures runtime. The skill docs (`skills/browserops.md`, `skills/browserops-teach.md`) collapse the prior playbooks section into a single procedures discipline.

### Fixed

- Procedure execute loop seeds the ref-cache and captures the navigate URL so subsequent `text_visible` / `verify` predicates have live page text to match against.
- `procedure_call` steps thread `tab_id: "{{tab_id}}"` through `with.inputs` (top-level `tab_id` is ignored on the recursive call).

## [0.0.8] – 2026-05

### Added

- **Procedure runtime feature (formerly "playbooks").** Five MCP tools (`procedures_search/get/save/delete/execute`) gated behind the `procedures` feature flag. Storage at `~/browserops/procedures/`, search index at `index.json`.
- **`procedures_resume` patch protocol.** Three patch kinds: `resume_with`, `insert_steps`, `give_up`. Lets the agent recover from a `needs_assist` halt without restarting the procedure.
- **Strict mode for `procedures_execute`.** Refuses every LLM-fallback path even if a step declares one. Mandatory for CI runs and the post-authoring verification flip.
- **Forbidden-locator + forbidden-action guard.** Top-level `forbidden:{locators, actions}` enforced on every dispatch, including LLM-proposed resume patches.
- **Retrying `expect:` predicate evaluator.** Each step polls a positive success criterion until match or timeout.
- **Per-step fallback ladder.** Explicit strategies: `strict | retry | relocate | relocate_then_llm | llm`.
- **`browser_locate` MCP tool.** Live a11y-tree resolution of `Locator` descriptors.
- **Variable substitution with bind paths.** Procedure inputs propagate through `{{step.field}}` references; references to fields not on the tool's output are rejected with `PROC_SCHEMA_INVALID` at save time.
- **In-process dispatch for composite procedures.** `do: procedure_call` recurses without an extension round-trip.

## [0.0.7] – 2026-04

### Added

- **CDP-trusted input as the default.** Every http(s) tab gets persistent `chrome.debugger` attached automatically. `browser_click`, `browser_type`, `browser_press`, `browser_hover` dispatch through CDP `Input.*` — trusted compositor events that traverse iframes, shadow DOM, and `isTrusted`-gated handlers. Per-tab opt-out via `browser_set_cdp(tab_id, false)`.
- **Observation architecture.** `browser_observe` returns a single envelope with `page_effect`, `effect`, `network`, `new_dialogs`, `visual_hash_delta`, `focus_moved_to`, etc. Replaces ad-hoc "did anything happen?" checks across handlers.
- **Action-grade screenshot mode.** 768px longest edge, ~800 tokens. Default for `browser_observe` auto-mode on canvas-dominant or visually-rich pages.

## [0.0.6] – 2026-03

### Added

- Initial `procedures_*` scaffolding (later unified in 0.0.9).
- `BROWSEROPS_DISABLED_TOOLS` env var.
- `browser_quick_read` with `best_match`, `near`, `within_region`, visual-state filters.

### Fixed

- `browser_type` defaults to paste mode (Input.insertText); auto-keystroke for canvas-backed editors (Google Sheets).
- US-layout punctuation codes added to `NAMED_KEYS`.

## [0.0.5] – 2026-02

### Added

- **Effect envelope on every input handler.** Click / type / press / hover return the same `effect` shape so the agent can verify what changed without re-reading the page.
- **Expected-effect predicate matcher.** Polling loop for `ExpectedEffect` declared on a tool call.
- **Network-request tracker.** Counts in-flight requests during an action window to provide `network: {requests_in_flight, endpoints}` in the effect envelope.

## [0.0.4] – 2026-02

### Added

- `browser_click_at` (coordinate clicks for canvas / cross-iframe targets).
- `browser_click_by_text` with fuzzy fallback.
- `browser_find_and_replace`.
- `browser_wait_for_idle` (network + DOM quiescence).

## [0.0.3] – 2026-01

### Added

- `browserops doctor` diagnostic command.
- `browserops upgrade` + `browserops sync skills` (atomic on-disk skill refresh with timestamped `.bak` of local edits).
- Per-project rules slots (`browserops install-rules`): Cursor, Windsurf, Copilot, Codex CLI, Continue.

## [0.0.2] – 2025-12

### Added

- First-run wizard (`browserops init`): mints token, starts daemon, copies extension to `~/.browserops/extension/`, detects MCP clients, registers them.
- Per-launcher routing: `browserops --claude`, `--cursor`, `--codex` pre-load the task into the launcher's prompt.

## [0.0.1] – 2025-12

### Added

- Initial scaffolding. pnpm monorepo with `shared`, `bridge`, `extension`, `cli`.
- Bridge: MCP stdio server, WebSocket primary on `127.0.0.1:57321` with token auth, rate limiter, risky-action gate, JSONL logger.
- Extension: MV3 service worker, handler dispatch, tab registry, content scripts.
- Shared: protocol envelopes, error codes, JSON-Schema tool catalogue.

[Unreleased]: https://github.com/quaylabshq/browserops/compare/v0.0.9...HEAD
[0.0.9]: https://github.com/quaylabshq/browserops/releases/tag/v0.0.9
[0.0.8]: https://github.com/quaylabshq/browserops/releases/tag/v0.0.8
[0.0.7]: https://github.com/quaylabshq/browserops/releases/tag/v0.0.7
[0.0.6]: https://github.com/quaylabshq/browserops/releases/tag/v0.0.6
[0.0.5]: https://github.com/quaylabshq/browserops/releases/tag/v0.0.5
[0.0.4]: https://github.com/quaylabshq/browserops/releases/tag/v0.0.4
[0.0.3]: https://github.com/quaylabshq/browserops/releases/tag/v0.0.3
[0.0.2]: https://github.com/quaylabshq/browserops/releases/tag/v0.0.2
[0.0.1]: https://github.com/quaylabshq/browserops/releases/tag/v0.0.1
