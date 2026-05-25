# Memory System Evals — Implementation Plan

> A self-contained plan for an `evals/memory/` suite that verifies the memory v2
> system as named, end-to-end behaviors (with a runnable scorecard), plus
> agentic task specs for the LLM-in-the-loop checks unit tests can't cover.
> Executable top to bottom by a fresh agent.

---

## 0. Agent execution instructions (read first)

1. **Read the whole document before starting.** Phases build on each other.
2. **Branch:** continue on `feat/memory-v2` (these evals verify the system that
   branch introduces; they extend PR #11). All work lands there.
3. **One commit per numbered substep**, exact message given inline. No combining.
4. **No Claude attribution** on commits (no `Co-Authored-By`, no footer/🤖).
5. **Tick `- [ ] Done` → `- [x] Done` in the same commit** as the substep.
6. **Use Read/Edit/Write/Bash**, not `cat`/`sed`/`echo`. No `--no-verify`.
7. **Verify substeps gate the phase**: the eval suite must run and the scorecard
   must be all-green; the repo's `pnpm typecheck` must stay clean and lint ≤ the
   pre-existing baseline (19 errors).
8. **Stop on real blockers, don't improvise** missing APIs — confirm exports in
   `packages/bridge/src/memory/*.ts` before importing them.

---

## 1. Goals — evals vs. the 746 unit tests

Unit tests check functions in isolation. **Evals check the memory system as a
product**: named capabilities, composed end-to-end, with a scorecard you run to
answer "does memory actually work?" The headline behavior under test:
**the agent stops hitting the same wall twice.**

Two tiers:

- **Tier 1 — deterministic harness evals** (no LLM, no browser). Drive the *real*
  memory modules (`store`, `search`, `confidence`, `delivery`, `capture-signals`,
  `trace`, `migrate`, `validateMemory`) through scenario-level assertions in an
  isolated temp store. Fast, reproducible, CI-friendly. This is the backbone.
- **Tier 2 — agentic task specs** (markdown + rubric). The quality questions a
  deterministic harness can't answer — does the scribe author a *good*, PII-free,
  correctly-scoped record? does retrieval surface the right thing? does a real
  agent avoid the wall on the second visit? Run with a real agent / live browser;
  an optional LLM-judge runner scores them when an API key is present, else a
  manual checklist.

---

## 2. Runner architecture (validated against the codebase)

- `evals/memory/` is a **private workspace package** `@browserops/eval-memory`
  (add `evals/*` to `pnpm-workspace.yaml`). Devdeps: `tsx` (already in the
  workspace), `@browserops/shared` (`workspace:*`), `@types/node`.
- It imports the **real** memory logic two ways:
  - `@browserops/shared` for `MemoryRecord` / `validateMemory` (package export →
    needs `shared` built first; the run script builds it).
  - Bridge memory modules by **relative source path** with `.js` specifiers
    (`../../packages/bridge/src/memory/store.js`). `tsx` (esbuild) resolves
    `.js`→`.ts` and the modules are leaf-ish (node builtins + `yaml` +
    `@browserops/shared` + each other) so nothing heavy is pulled in.
- **Isolation:** `memoryRoot()` reads `BROWSEROPS_MEMORY_DIR` per call, so the
  harness points it at a fresh temp dir per scenario and cleans up after. The
  user's real `~/browserops/memory/` is never touched.
- **No `test`/`build`/`typecheck` scripts** on the package, so `pnpm -r test`,
  `pnpm build`, `pnpm -r typecheck` skip it (no interference). It exposes only an
  `eval` script. Root adds `eval:memory` (builds `shared`, then runs the suite).
- Run: `pnpm eval:memory` (all), `pnpm eval:memory -- --filter delivery`,
  `pnpm eval:memory -- --json` (machine-readable scorecard). Exit code is
  non-zero if any eval fails.

### Harness API (`evals/memory/harness.ts`)

```ts
interface EvalCase { id: string; capability: Capability; title: string; run: (ctx: EvalCtx) => Promise<void>; }
interface EvalCtx { dir: string; /* isolated BROWSEROPS_MEMORY_DIR */ }
function defineEval(c: EvalCase): void;                 // register
function check(cond: unknown, msg: string): asserts cond; // throw on false
function checkEqual<T>(actual: T, expected: T, msg: string): void;
async function withTempStore<T>(fn: (dir) => Promise<T>): Promise<T>; // fresh dir + env + cleanup
async function runAll(opts): Promise<number>;            // run, print scorecard, return exit code
```

Scorecard: a capability-grouped table (`✓/✗ id — title (ms)`), a totals line, and
under `--json` a `{ passed, failed, cases: [...] }` object.

---

## 3. Capability matrix

### Tier 1 — deterministic (`evals/memory/cases/*.eval.ts`)

| Cap | File | What it asserts |
|---|---|---|
| **A schema** | `schema.eval.ts` | each `kind` validates; site-without-origin, blocker-without-door, selector-without-locator rejected; redaction guard rejects email/long-digit/secret in `detail` |
| **B store** | `store.eval.ts` | save lands in `global/` vs `sites/<slug>/`; `index.json` updated; save→get roundtrip; delete removes file + index entry; temp-store isolation honored |
| **C migrate** | `migrate.eval.ts` | legacy `.md` → `scope:global,kind:lesson`; originals moved to `_legacy/`; idempotent; no-op on empty |
| **D search+confidence** | `search.eval.ts` | confidence-first ranking; `scope/origin/kind` filters; severity ordering; recency decay lowers score over time; `doorUnreliable` flips at threshold |
| **E delivery** | `delivery.eval.ts` | prime-once → suppress (same session+origin); primer ≤5, confidence-ranked, titles only (no door inlined); re-nudge returns door when PRIMED; per-session isolation; global digest ≤10 ranked lines |
| **F signals** | `signals.eval.ts` | `detectRoadblock` fires on error/`WRITE_NOT_REFLECTED`/no-op-after-action/timeout/repeated-retry/`USER_DECLINED`; does NOT fire on benign reads |
| **G trace** | `trace.eval.ts` | ring eviction at capacity; per-session isolation; `recent()` ordering; cross-session read |
| **H integration** | `integration.eval.ts` | **wall-twice**: no blocker → simulated roadblock recurs; after capture + warm, the primer/re-nudge surfaces the door for the next (session,origin). **self-heal**: repeated `bumpDoorFailure` decays confidence and drops the record from the primer. **dedup**: N captures of the same wall converge to ONE record via `merge_into`, not N |

### Tier 2 — agentic task specs (`evals/memory/tasks/*.md`)

| Task | Verifies | How |
|---|---|---|
| `capture-quality.md` | scribe writes a good, PII-free, correctly-scoped/kinded record from a trace | real agent + rubric (or LLM judge) |
| `retrieval-relevance.md` | natural queries surface the right record | seed store + judge top-1/top-3 |
| `wall-twice-live.md` | on a real site with a known modal/cookie wall, session 2 is primed and doesn't get stuck | manual checklist, full stack |
| `privacy.md` | no PII lands in any saved record during a task on a PII-bearing page | drive task + inspect store |

A `judge.ts` stub reads a task's rubric + a candidate artifact and, if
`ANTHROPIC_API_KEY` is set, asks a model to score it against the rubric; otherwise
prints the manual checklist. Keep it optional and side-effect-free.

---

# EXECUTION

## Phase 1 — Scaffold + harness + proof

- **1.1** Add `evals/*` to `pnpm-workspace.yaml`; create
  `evals/memory/package.json` (`@browserops/eval-memory`, private, devdeps `tsx`,
  `@browserops/shared` workspace:\*, `@types/node`; script `eval: "tsx run.ts"`)
  and `evals/memory/tsconfig.json` (standalone, not in the build graph). Add root
  script `eval:memory` (`pnpm -F @browserops/shared build && pnpm -F
  @browserops/eval-memory eval`). Run `pnpm install`.
  Commit: `chore(evals): scaffold eval-memory workspace package`
  - [x] Done
- **1.2** Write `evals/memory/harness.ts` (registry, `check`/`checkEqual`,
  `withTempStore`, `runAll` + scorecard, `--filter`/`--json`) and
  `evals/memory/run.ts` (imports all case files, calls `runAll`, sets exit code).
  Add ONE proof case (`schema.eval.ts` A1: a valid blocker validates) and confirm
  `pnpm eval:memory` runs green end-to-end.
  Commit: `feat(evals): memory eval harness + scorecard runner`
  - [ ] Done

## Phase 2 — Deterministic capability evals

- **2.1** `schema.eval.ts` — capability A (validation + redaction). Commit:
  `feat(evals): schema + redaction evals (A)`
  - [ ] Done
- **2.2** `store.eval.ts` + `migrate.eval.ts` — capabilities B, C. Commit:
  `feat(evals): store roundtrip, index, migration evals (B,C)`
  - [ ] Done
- **2.3** `search.eval.ts` — capability D (ranking, filters, confidence/decay).
  Commit: `feat(evals): search + confidence/decay evals (D)`
  - [ ] Done
- **2.4** `delivery.eval.ts` — capability E (prime/suppress/re-nudge, digest).
  Commit: `feat(evals): hybrid delivery state-machine evals (E)`
  - [ ] Done
- **2.5** `signals.eval.ts` + `trace.eval.ts` — capabilities F, G. Commit:
  `feat(evals): capture-signal + trace-buffer evals (F,G)`
  - [ ] Done
- **2.6** `integration.eval.ts` — capability H (wall-twice, self-heal, dedup).
  Commit: `feat(evals): wall-twice, self-heal, dedup integration evals (H)`
  - [ ] Done
- **2.7 Verify** `pnpm eval:memory` is all-green; `pnpm typecheck` clean; lint ≤19.
  Commit: `chore(evals): phase 2 verify`
  - [ ] Done

## Phase 3 — Agentic task specs + judge + README

- **3.1** `evals/memory/tasks/*.md` (capture-quality, retrieval-relevance,
  wall-twice-live, privacy) — each with setup, action, and a pass rubric. Commit:
  `docs(evals): agentic memory task specs`
  - [ ] Done
- **3.2** `evals/memory/judge.ts` — rubric scorer (LLM if `ANTHROPIC_API_KEY`,
  else manual checklist). Commit: `feat(evals): optional LLM-judge for task specs`
  - [ ] Done
- **3.3** `evals/README.md` — what evals are, how to run, the capability matrix,
  how to add a case/task. Commit: `docs(evals): evals README`
  - [ ] Done

## Phase 4 — Wire-up + final

- **4.1** Mention `pnpm eval:memory` in `README.md` (verifying memory) and
  `AGENTS.md` ("Where to look" → evals row). Commit:
  `docs: reference memory evals in README and AGENTS`
  - [ ] Done
- **4.2** Flip remaining checkboxes; final `pnpm eval:memory` + `pnpm typecheck` +
  `pnpm test`; push branch (updates PR #11). Commit: `docs: complete memory evals plan`
  - [ ] Done

---

## 4. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Cross-package source import flakiness | `tsx` resolves `.js`→`.ts`; modules are leaf-ish; `shared` built before run |
| Eval writes to the user's real store | per-scenario temp `BROWSEROPS_MEMORY_DIR`, cleaned up |
| Eval pkg pollutes `pnpm test/build/typecheck` | only an `eval` script — `-r` commands skip it |
| `memoryRoot()` caching env | confirmed read per-call; harness sets env before each scenario |
| Agentic evals non-reproducible | kept in Tier 2 with rubrics; deterministic backbone in Tier 1 |
