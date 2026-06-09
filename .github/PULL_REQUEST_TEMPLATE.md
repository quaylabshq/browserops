<!-- Thanks for the contribution! A few things make review smooth: -->

## Summary

<!-- 1–3 bullets on what changes and why. The "why" is what matters most for review. -->

-
-

## Tool / protocol surface

<!-- Tick all that apply. If any box is ticked, the change is wire-protocol-impacting and needs CODEOWNER review. -->

- [ ] Added or modified a tool in `packages/shared/src/tools.ts`
- [ ] Changed the WebSocket protocol envelopes in `packages/shared/src/protocol.ts`
- [ ] Changed the procedure schema in `packages/shared/src/procedures.ts`
- [ ] Changed an error code or close code in `packages/shared/src/errors.ts`
- [ ] None of the above

## Tests

<!-- Tick at least one. -->

- [ ] Unit tests added/updated.
- [ ] Manually exercised end-to-end via Claude Code / Cursor / Codex driving Chrome.
- [ ] Not applicable (docs / chore / pure refactor with existing coverage).

```bash
# Paste the test command(s) you ran:
```

## Docs

- [ ] README updated (if user-facing).
- [ ] `CHANGELOG.md` entry added under `## [Unreleased]`.
- [ ] `skills/browserops.md` and/or `skills/browserops-teach.md` updated (if tool surface, procedure schema, or orchestration behaviour changed).
- [ ] N/A.

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test` are green locally.
- [ ] No new secrets, real user data, or absolute personal paths in tests / fixtures / docs.
- [ ] Commit messages follow Conventional Commits (`feat(scope): …`, `fix(scope): …`, etc.).
- [ ] If this is a behavioural change in the procedure runtime, the per-step `expect:` / top-level `verify:` semantics still hold for the sample procedures in `examples/procedures/`.

<!-- For security-impacting changes, please see SECURITY.md and reach out privately first. -->
