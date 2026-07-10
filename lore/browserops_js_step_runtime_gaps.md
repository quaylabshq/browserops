---
name: browserops_js_step_runtime_gaps
description: "Two procedure-runtime gaps found 2026-07-10 (PR #24): (1) do:js
  return values are NOT captured by buildObservation, so they can't be
  bound/templated into later steps — no data-passing between js steps; (2) js
  steps expose no observation envelope, so expect/verify predicates
  (url_matches, dom_added_min, etc.) can't validate a js step and a thrown error
  inside js does not fail the step. Design procedures around both."
type: reference
source: mcp-tool
created: 2026-07-09T20:07:06.073Z
updated: 2026-07-09T20:07:06.073Z
---

# Procedure runtime — do:js gaps (verified 2026-07-10, PR #24 build)

Found while authoring the trusted procedure `x.tweets_to_sheet` (bulk-write a
rows grid into a fresh Google Sheet via synthetic paste — see
[[browserops_sheets_write_pr24_retest]]).

## Gap 1 — js return values are not bindable

`buildObservation` (packages/bridge/src/procedures/execute.ts) only extracts
`page_effect`, `effect.*`, `url`/`final_url`, `title`. A `do: js` step returns
`{thrown, value}`; the `value` is NOT copied into the observation, so
`bind:` on a js step stores nothing useful and `{{bind.field}}` can't reach a
js result. **Consequence:** you cannot scrape data in one js step and template
it into a later step. Data that varies at runtime must enter as a procedure
INPUT (templated via `{{input}}` — arrays get JSON.stringify'd by
substituteVars, so `const rows = {{rows}};` yields a valid JS literal).

## Gap 2 — js steps are unverifiable by the runtime

A js step's observation is effectively empty, so `expect:`/`verify:` predicates
that read the effect envelope or url can't validate it:

- `expect: { url_matches }` on a js step FAILS ("url \"\" does not match ...")
  even when the page is clearly on that url — the js result carries no url.
  (The top-level `verify:` DOES work, because captureObservation fetches live
  url+text via browser_read for a standalone verify.)
- A JS `throw` returns `{thrown:true, error}` as a SUCCESSFUL tool result, so
  the step still `matched:true`. An internal assertion cannot halt the run.

**Consequence:** a js-write step can silently "complete" without doing
anything. Gate correctness with (a) a top-level `verify:` on something the
runtime can read live (here: `url_matches: /spreadsheets/d/`), AND (b) an
EXTERNAL readback each run (formula-bar sampling for Sheets). Do not trust
`completed:true` for a js step alone.

## Pattern that works (used by x.tweets_to_sheet, trusted)

navigate → wait(text marker) → `do: js` (paste `{{rows}}` input) with NO
per-step expect; top-level `verify: url_matches`; author verifies cells
externally during the strict streak. 3/3 clean strict runs, all first_try,
distinct fresh sheet each run, varied start states.

## Wanted runtime fixes

- Copy `browser_execute_js` `value` into the observation (bindable + lets an
  `expect: { value_contains / equals }` validate js steps).
- Treat `{thrown:true}` from a js step as a step failure in strict mode.
