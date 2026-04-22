# Implementation plans — index

Post-retrospective implementation plans derived from `session-retrospective.md` §5 (remaining priority ranking). Kept in the `impl-NN-*.md` namespace to stay separate from the `00-08` design-doc series.

Each plan is self-contained and sequenceable. All plans share these conventions:

- Commit after each numbered step.
- `pnpm -r typecheck && pnpm test` must pass before each commit.
- No Claude attribution in commit messages.
- grep / targeted Read ranges only — no whole-file reads.
- Do not implement until explicitly asked.

## Priority order (from retrospective §5)

| # | Plan | Retrospective priority | Theme |
|---|---|---|---|
| 01 | [Screenshot default downscale + JPEG](impl-01-screenshot-defaults.md) | §5 #2 | Per-call token win (~5×) |
| 02 | [A11y tree verbose=false default](impl-02-a11y-verbose-default.md) | §5 #3 | 60–80% fewer tokens per a11y read |
| 03 | [browser_read pagination + selector](impl-03-browser-read-pagination.md) | §5 #4 | Kill disk round-trips |
| 04 | [browser.find_and_replace](impl-04-find-and-replace.md) | §5 #6 | Substring edits in contenteditable |
| 05 | [browser.query_selector](impl-05-query-selector.md) | §5 #8 | CSS-keyed describe_ref |

Work through them in this order unless you have a specific reason to reprioritize. Each plan notes its critical files and a list of open questions to decide before/during Step 1.

## Status

- impl-01 (screenshot defaults): **shipped** — 5 commits.
- impl-02, 03, 04, 05: drafted, not implemented.
