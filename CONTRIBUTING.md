# Contributing to browserops

Thanks for considering a contribution. browserops is an MCP server that drives a real Chrome profile, so a few areas need extra care — the wire protocol, the safety gate, and the procedure runtime. This doc walks through how to get a local dev loop going, what to test, and how to land a clean PR.

If you're filing an issue (bug, feature request, broken procedure), use the [issue templates](.github/ISSUE_TEMPLATE/) instead of this file.

## Code of Conduct

Participation is governed by the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md). By participating you agree to abide by it.

## Repo shape

```
packages/
  shared/      types, error codes, tool catalogue, procedure schema (pure TS)
  bridge/      Node MCP server + WebSocket primary + procedure runtime
  extension/   Chrome MV3 extension (Vite + crxjs)
  cli/         `browserops` command — first-run wizard + daemon supervisor
docs/          architecture, design RFCs
skills/        Claude skill markdown shipped via `browserops sync skills`
```

Inter-package rule: `bridge` and `extension` communicate **only** via the WebSocket protocol declared in `packages/shared/src/protocol.ts`. Don't add direct cross-package imports.

## Prerequisites

- Node >= 20.10 (`.nvmrc` pins 20)
- pnpm >= 9 (`packageManager: pnpm@9.12.0`)
- Chrome >= 120 with developer mode available
- macOS or Linux (Windows isn't supported by the daemon yet)

## Dev loop

```bash
# Once
pnpm install
pnpm build           # full workspace build

# Live dev — runs all four packages in parallel
pnpm dev
```

`pnpm dev` watches `shared`, `bridge`, `extension`, and `cli` simultaneously. The extension rebuilds to `packages/extension/dist/`; load that path as an unpacked extension in `chrome://extensions` (Developer mode → Load unpacked). Reload the extension after any edit — Vite/HMR doesn't apply to MV3 service workers.

A fast iteration loop is:

1. Edit a handler in `packages/extension/src/background/handlers/`.
2. Wait for the Vite rebuild log.
3. Click the reload icon on the extension card in `chrome://extensions`.
4. Drive it from your MCP client.

For bridge-only work:

```bash
pnpm -F @browserops/bridge dev
```

For procedure-runtime debugging, the bridge logs every step's `effect` envelope to `~/.browserops/log.jsonl` (jsonl, one line per event). `tail -f ~/.browserops/log.jsonl | jq .` is the fastest way to see what the runtime is doing.

## Tests

```bash
pnpm test                              # unit tests across all packages
pnpm -F @browserops/bridge test        # bridge only
pnpm -F @browserops/shared test        # shared only
pnpm -F @browserops/bridge test:integration   # end-to-end integration
pnpm typecheck                         # tsc -b --noEmit, all packages
pnpm lint                              # eslint, must be 0 errors
```

A PR must pass `typecheck`, `lint`, and `test` before merge. The CI pipeline runs the same scripts on every PR.

When you add a new MCP tool or change an existing one:

- Add/update the entry in `packages/shared/src/tools.ts`.
- Add/update the handler in `packages/extension/src/background/handlers/`.
- Add/update the wire schema in `packages/shared/src/protocol.ts` if the request/response shape changes.
- Add a unit test in `packages/bridge/src/` (dispatch path) and/or `packages/extension/src/` (handler logic).

When you change the procedure schema in `packages/shared/src/procedures.ts`:

- Bump the schema version constant if the change is breaking.
- Update `packages/bridge/src/procedures/validator.ts`.
- Update both skill docs (`skills/browserops.md` and `skills/browserops-teach.md`) — these are loaded by agents at runtime; out-of-sync skills cause silent procedure failures.

## Authoring a procedure (for testing)

Procedures live under `~/browserops/procedures/`. The recommended path is to use the `browserops-teach` Claude skill, which drives the deterministic-first authoring loop. To author by hand:

1. Read the live page via `browser_read` to find target elements.
2. For each target, call `browser_propose_locator({tab_id, ref})` to get a tier-1 stable locator.
3. Write the YAML by hand or in a `procedures_save` call with `dryRun: true`.
4. Run `procedures_execute({name, tab_id, strict: true})` against a clean state.
5. If green, `procedures_save({name, bump_success: true})` flips status to `trusted`.

See the `browserops-teach` skill for the full discipline.

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/) with these types:

- `feat(scope):` — user-visible new functionality
- `fix(scope):` — bug fix
- `docs(scope):` — documentation only
- `refactor(scope):` — internal rework, no behaviour change
- `test(scope):` — tests only
- `chore(scope):` — tooling, deps, repo hygiene

Common scopes: `bridge`, `extension`, `cli`, `shared`, `procedures`, `skills`, `telemetry`, `docs`. Look at recent commits with `git log --oneline` for examples.

PR title should match the merge-commit format. Squash-merge is the default.

## PR checklist

Before opening a PR:

- [ ] `pnpm typecheck && pnpm lint && pnpm test` all green.
- [ ] If you changed `packages/shared/src/tools.ts` or `protocol.ts`, the matching consumers compile.
- [ ] If you changed the procedure schema, both skill docs are updated.
- [ ] CHANGELOG entry added under `## [Unreleased]`.
- [ ] No new secrets, real-user data, or personal paths in tests/fixtures (use `user@example.com`, `/tmp/...`).

## Reporting security issues

Don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree your contributions are licensed under the MIT License (see [LICENSE](LICENSE)).
