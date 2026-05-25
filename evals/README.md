# browserops evals

Behavioral evals for the browserops memory system. These are higher-level than
the 746 unit tests: each eval asserts a **named, end-to-end capability** of the
memory system and produces a scorecard you can run to answer "does memory
actually work?"

The headline behavior under test: **the agent stops hitting the same wall twice.**

---

## Evals vs. unit tests

| | Unit tests (`pnpm test`) | Evals (`pnpm eval:memory`) |
|---|---|---|
| Scope | Individual functions and modules | Named system capabilities, composed end-to-end |
| Runtime | Jest, mocked I/O | Real memory modules, isolated temp store |
| Speed | < 5 s | 1–10 s |
| PII risk | None | None — temp store, never touches `~/browserops/memory/` |
| Browser / LLM | No | No (Tier 1) / Yes (Tier 2) |

---

## Two tiers

### Tier 1 — deterministic harness evals (`evals/memory/cases/*.eval.ts`)

Run against the real memory modules (`packages/bridge/src/memory/` and
`@browserops/shared`) inside an isolated temp store. Fast, reproducible,
CI-friendly. Each case calls `defineEval`, uses `check`/`checkEqual` for
assertions, and is automatically discovered by the runner.

### Tier 2 — agentic task specs (`evals/memory/tasks/*.md`)

Quality questions a deterministic harness cannot answer: does the scribe author
a well-formed, PII-free record? does retrieval surface the right thing for
natural-language queries? does a real agent avoid the wall on the second visit?

Each spec is a markdown file with **Goal, Setup, Action, Pass rubric,** and
**Scoring** sections. Run by hand with a real agent/browser, or scored
automatically with `judge.ts` when `ANTHROPIC_API_KEY` is set.

---

## Capability matrix (Tier 1)

| Cap | Case file | What it asserts |
|---|---|---|
| **A schema** | `schema.eval.ts` | Each `kind` validates; invalid cross-field combinations rejected; redaction guard rejects email/digit-string/secret in `detail` |
| **B store** | `store.eval.ts` | Save lands in `global/` vs `sites/<slug>/`; `index.json` updated; save→get roundtrip; delete removes file + index; temp-store isolation honored |
| **C migrate** | `migrate.eval.ts` | Legacy `.md` → `scope:global,kind:lesson`; originals moved to `_legacy/`; idempotent; no-op on empty dir |
| **D search** | `search.eval.ts` | Confidence-first ranking; scope/origin/kind filters; severity ordering; recency decay lowers score; `doorUnreliable` flips at threshold |
| **E delivery** | `delivery.eval.ts` | Prime-once → suppress (same session+origin); primer ≤5, confidence-ranked, titles only (no door inlined); reNudge returns door; per-session isolation |
| **F signals** | `signals.eval.ts` | `detectRoadblock` fires on error/`WRITE_NOT_REFLECTED`/no-op-after-action/timeout/repeated-retry/`USER_DECLINED`; does NOT fire on benign reads |
| **G trace** | `trace.eval.ts` | Ring eviction at capacity; per-session isolation; `recent()` ordering; cross-session read |
| **H integration** | `integration.eval.ts` | **wall-twice**: no blocker → roadblock recurs; after capture + warm, primer surfaces door for next session. **self-heal**: repeated `bumpDoorFailure` decays confidence and drops record from primer. **dedup**: N captures of same wall converge to ONE record |

---

## Tier-2 task specs

| Task | File | Verifies |
|---|---|---|
| capture-quality | `tasks/capture-quality.md` | Scribe writes a PII-free, correctly-scoped/kinded, de-duplicated record from a synthetic roadblock trace |
| retrieval-relevance | `tasks/retrieval-relevance.md` | Natural-language queries via `memory_search` surface the intended record at top-1 / top-3 across a seeded store of 8 records |
| wall-twice-live | `tasks/wall-twice-live.md` | Full-stack manual checklist: session 1 hits a real cookie/modal wall and captures a blocker; session 2 receives the primer and bypasses the wall |
| privacy | `tasks/privacy.md` | No PII (email, phone, long digit string, token URL) lands in any saved record during a task on a PII-bearing page |

---

## How to run

### All Tier-1 evals (scorecard)

```bash
pnpm eval:memory
```

Runs `pnpm -F @browserops/shared build` first (needed for the shared package
export), then executes all `cases/*.eval.ts` files.

### Filter by capability or case ID

```bash
pnpm eval:memory -- --filter delivery      # all delivery cases
pnpm eval:memory -- --filter E1            # one case by ID
```

### Machine-readable output

```bash
pnpm eval:memory -- --json
# outputs {"passed": N, "failed": 0, "cases": [...]}
```

Exit code is non-zero if any eval fails.

### Tier-2 task specs + judge

Run a task manually following the steps in the spec, then score the candidate
artifact with the judge:

```bash
# Without ANTHROPIC_API_KEY — prints the rubric as a manual checklist:
cd evals/memory
npx tsx judge.ts tasks/privacy.md /dev/null

# With ANTHROPIC_API_KEY — LLM scores the candidate against the rubric:
cd evals/memory
ANTHROPIC_API_KEY=sk-ant-... npx tsx judge.ts tasks/capture-quality.md /path/to/saved-record.json
```

The judge is side-effect-free (no writes). It exits 0 with or without a key.

---

## How to add a Tier-1 case

1. Drop a file `evals/memory/cases/<name>.eval.ts`.
2. Import from `../harness.js` and from the real modules (relative `.js` paths
   into `packages/bridge/src/memory/`).
3. Call `defineEval({ id, capability, title, run })` — the runner auto-discovers
   it.

Minimal example:

```ts
import { defineEval, check } from "../harness.js";
import { validateMemory } from "@browserops/shared";

defineEval({
  id: "X1",
  capability: "schema",
  title: "a lesson record with a long title is rejected",
  run() {
    const errors = validateMemory({
      schema_version: 1,
      name: "global.long-title",
      scope: "global",
      kind: "lesson",
      title: "x".repeat(121),
      detail: { note: "n" },
    });
    check(errors.some((e) => e.field === "title"), "should reject title > 120 chars");
  },
});
```

## How to add a Tier-2 task

1. Create `evals/memory/tasks/<name>.md`.
2. Include these sections (exact H2 headings):
   - `## Goal` — one paragraph
   - `## Setup` — numbered list
   - `## Action` — what the agent does
   - `## Pass rubric` — markdown table with columns `#`, `Criterion`, `Check`
   - `## Scoring` — 0 / 1 / 2 scale
3. The judge's `extractSection` parser looks for `## Pass rubric` verbatim — use
   that exact heading to ensure the judge can extract it.
