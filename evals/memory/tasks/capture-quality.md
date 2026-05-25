# Task: capture-quality

Verify that the scribe subagent, given a synthetic session trace that ends in a
roadblock, authors a `MemoryRecord` that is correctly scoped, correctly kinded,
PII-free, de-duplicated, and reusable.

---

## Goal

Confirm the scribe produces a well-formed, behaviour-only record for a
cookie-consent wall encountered on `https://example.test`, and that a second
invocation with the same trace merges rather than duplicates.

---

## Setup

1. Create an isolated temp store (set `BROWSEROPS_MEMORY_DIR` to a fresh
   directory).
2. Prepare a synthetic session trace (JSON array of `TraceEntry` objects) that
   represents the following sequence on `https://example.test/dashboard`:
   - `browser_navigate` → page loaded
   - `browser_click` on the main CTA → `error_code: "ELEMENT_NOT_INTERACTABLE"`,
     `effect_summary: "click intercepted by overlay"`
   - `browser_click` retry → same error
   - `browser_observe` → a11y tree shows a `role:dialog` with
     `name: "Cookie consent"` in the foreground
   - `browser_click_by_text` on "Accept all" → `effect_summary: "dialog closed"`
   - `browser_click` on main CTA again → success
   - Outcome: `roadblock` (the wall was hit and the session captured it)
3. Include one bystander field in the trace that contains a PII-like string
   (e.g., a `goal` line that mentions a user's email address
   `alice@example.test`) to verify the scribe strips it.
4. Ensure the temp store starts empty (no pre-existing records).

---

## Action

Spawn the scribe with the following brief:

```
Capture a memory for:
- tab_id: t_test
- session_id: synthetic-trace-001
- origin: https://example.test
- outcome: roadblock
- goal: dismiss cookie banner so user alice@example.test can access dashboard
```

Feed it the synthetic trace from Setup step 2 as the `memory_session_trace`
response.

After the first save, run the scribe a second time with an identical brief and
trace (simulating a second session that hit the same wall).

---

## Pass rubric

A candidate `MemoryRecord` (the JSON/YAML file written to the temp store)
**passes** when ALL of the following hold:

| # | Criterion | Check |
|---|---|---|
| R1 | `scope === "site"` | The cookie wall is site-specific knowledge |
| R2 | `origin === "https://example.test"` | Exact scheme+host, no trailing slash |
| R3 | `kind === "blocker"` | The wall halted the flow — both `detail.wall` and `detail.door` present |
| R4 | `detail.wall` describes the symptom (overlay/modal/intercept), NOT the user goal | Behaviour only |
| R5 | `detail.door` describes the dismiss action (click "Accept all" or equivalent) | Actionable workaround |
| R6 | No PII in any field — `alice@example.test` must NOT appear in name, title, detail, or tags | Privacy |
| R7 | `severity` is `"high"` (the wall halted the agent entirely) | Correct severity |
| R8 | `meta.source === "scribe"` | Attribution |
| R9 | Second invocation results in `created: false` (merge, not create) and the store still holds exactly ONE record for this origin | De-duplication |
| R10 | The record's `name` matches `^[a-z][a-z0-9._-]{0,79}$` | Schema compliance |

**Fails** if any criterion is unmet. Partial credit: note which criteria passed.

---

## Scoring

- **0** — fewer than 6 criteria pass
- **1** — 6–8 criteria pass
- **2** — 9–10 criteria pass (full pass)

For automated scoring, supply the saved record JSON as the candidate artifact to
`judge.ts`.
