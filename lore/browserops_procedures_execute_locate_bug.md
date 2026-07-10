---
name: browserops_procedures_execute_locate_bug
description: "FIXED as of 2026-07-07: procedures_execute post-navigate locate
  and browser_locate data_testid matching both work now. Historical notes on the
  July 2 symptoms kept below."
type: reference
source: mcp-tool
created: 2026-07-02T09:03:01.118Z
updated: 2026-07-07T15:12:53.564Z
---

# procedures_execute locate bugs — FIXED (verified 2026-07-07)

Both July-2 findings no longer reproduce (verified while authoring `x.post_tweet`, 3 clean strict runs):

1. **Post-navigate locate null-ref**: locate-based click steps after `do: navigate` + `do: wait` now resolve first_try in strict mode. The executor auto-prime populates the ref-cache correctly.
2. **`browser_locate` ignores data_testid**: `{data_testid: "tweetButtonInline"}` now resolves. data_testid locators are usable in procedure steps again.

Still true:

- `do: wait` accepts only `text` / `url_pattern` / `ref` — not a locator.
- Text waits can match residual DOM instantly across SPA navigations (elapsed 0-3ms) — don't rely on them to gate a fresh mount; pair with in-step polling or expect predicates.
- `expect.url_matches` / all string predicates: plain strings are case-insensitive SUBSTRING matches, `/.../ ` is regex. A YAML value like `x\.com/home` (escaped dot, not slash-wrapped) is a literal-backslash substring and never matches — write `x.com/home` or `/x\.com\/home/`.
- Substitution (`{{input.*}}`) applies only to step `locator:` and `with:` — NOT to `expect:` or top-level `verify:`. Dynamic success text can't be asserted; use static markers (toasts) or effect predicates.
- js steps return no effect envelope — only `text_visible`/`text_invisible` (live-read) work in their expect.

## Historical (July 2 symptoms, for context)

Strict runs of `x.send_dm` halted at step 2 with `dispatch failed (INVALID_PARAMS): ref must be a positive integer` on every locate step following navigate+wait, and `browser_locate {data_testid: ...}` returned LOCATOR_NOT_FOUND. `x.send_dm` remains a draft; it can likely be strict-verified now that the runtime is fixed.
