# Memory System v2 — Implementation Plan

> A complete, self-contained execution plan. Designed so any competent engineer
> (or a fresh agent with no prior conversation context) can execute it from top
> to bottom and produce the same result: replace the current browserops memory
> subsystem with a two-store, auto-captured, structured, hybrid-delivery memory
> system.

---

## 0. Agent execution instructions (read first, do not skip)

You are executing this plan. Treat these as hard rules — do not deviate without
explicitly stopping to ask.

1. **Read this entire document before starting.** Skim every phase so you
   understand the dependencies between substeps. The ordering is load-bearing:
   the new schema is added *additively* first and the legacy types are removed
   *last*, so the workspace keeps compiling at every commit boundary.
2. **Order is mandatory.** Execute substeps strictly in numeric order
   (1.1 → 1.2 → … → 8.4). Later substeps depend on earlier ones.
3. **Branch.** Before any work: `git checkout -b feat/memory-v2` (or check it out
   if it already exists). All work lands on this branch.
4. **One commit per numbered substep.** Each substep specifies an exact commit
   message — use it verbatim. Do not combine substeps into one commit.
5. **No Claude attribution on commits.** Do **not** include
   `Co-Authored-By: Claude …` lines, "Generated with Claude Code" / "🤖" footers,
   or any other attribution. The commit body contains only the specified message.
6. **Tick the checkbox as you go.** Each substep ends with `- [ ] Done`. Flip it
   to `- [x] Done` *in the same commit* as the substep's work. This file is your
   durable progress tracker.
7. **Single PR at the end** (substep 8.4). No intermediate PRs.
8. **Verify at phase boundaries.** Every phase ends with a `Verify` substep:
   `pnpm -w tsc --noEmit` (or the repo's typecheck script), `pnpm -w lint`, and
   the package test command. If verify fails, fix before committing.
9. **Stop on real blockers, don't improvise.** If a referenced file has clearly
   moved or an API doesn't exist, stop and report rather than guessing. File
   paths and line ranges below are accurate as of plan authoring but confirm
   before editing.
10. **Use the dedicated tools** (Read, Edit, Write, Bash) — not `cat`/`sed`/`echo`.
11. **No `--no-verify`.** Fix pre-commit hook failures and re-commit.
12. **Do not strip scope.** Every substep matters; the user will strip later if
    needed.

---

## 1. Goals & the four locked decisions

The current memory subsystem (`~/browserops/memory/*.md`, frontmatter types
`user|feedback|project|reference`, coverage-token search, opt-in feature) is
**replaced wholesale**. Four product decisions drive the design:

| # | Decision | Consequence |
|---|---|---|
| 1 | **Two stores: global + per-site. Feature ON by default.** | One record schema with a `scope` discriminator; storage splits into `global/` + `sites/<origin>/`; `features.ts` default → `true`. |
| 2 | **Auto-capture on task-done OR roadblock, via a parallel agent.** | Bridge *detects* + *provides trace*; a client-spawned **memory-scribe** subagent *authors* the record. The bridge has no LLM. |
| 3 | **Structured output, procedure-like.** | Records are schema-validated YAML (like `ProcedureDef`), not markdown. Reuses the procedures `Locator` descriptor for `selector` memories. |
| 4 | **Hybrid delivery.** | Two channels (global → `initialize` instructions; per-site → response injection) + two progressive axes (across-call session suppression + within-message terse-index→pull-detail). |

Headline behavior bought: **the agent stops hitting the same wall twice.**

---

## 2. Architecture (reference)

```
   DURABLE LAYER     ~/browserops/memory/
   (disk, YAML,        global/   <name>.yaml          ← cross-site
    cross-agent)       sites/<origin-slug>/ <name>.yaml ← per-site
                       index.json   (origin → [names], confidence)
                          ▲ save/merge        │ load
   BRIDGE (no LLM)   ┌────────────────────────┴───────────────────────┐
                     │ MemoryStore · ConfidenceModel                   │
                     │ SiteContextManager (session,origin)→state ←ephem │
                     │ TraceBuffer (per-session ring)            ←ephem │
                     │ CaptureSignals (roadblock detector)             │
                     └─────────────────────────────────────────────────┘
     global digest │            │ site primer / re-nudge │ capture_hint + trace
   (once @ init)    ▼            ▼ (per response)         ▼
   MCP CLIENT       main agent ── on task-done/roadblock ──▶ spawns
                    memory-scribe subagent (haiku, background, parallel)
                      reads TraceBuffer + page state, dedups, saves
```

**Core principle:** separate *what you know* (durable, disk) from *whether you've
said it this session* (ephemeral, bridge RAM). A blocker is a global fact; "I
primed Notion for session s_7" is per-session UX. Conflating them means session
#2 never gets primed.

---

## 3. Data model (target shape)

In `packages/shared/src/memory.ts`, reusing `Locator` from
`packages/shared/src/procedures.ts`:

```ts
export type MemoryScope = "global" | "site";
export type MemoryKind = "blocker" | "affordance" | "gotcha" | "selector" | "lesson";
export type MemorySeverity = "low" | "med" | "high";

export interface MemoryStats {           // bridge/scribe-managed; never hand-authored
  hits: number; last_hit?: string;
  resolved: number; last_resolved?: string;
  door_failures: number;                 // delivered door later failed (self-heal signal)
  captures: number;                       // scribe touches (dedup pressure)
}

export interface MemoryRecord {
  schema_version: 1;
  name: string;                           // ^[a-z][a-z0-9._-]{0,79}$
  scope: MemoryScope;
  kind: MemoryKind;
  title: string;                          // ≤120 chars; the line shown in a primer index
  origin?: string;                        // REQUIRED iff scope==="site"; scheme://host[:port]
  origin_wildcard?: boolean;              // match subdomains (default false)
  path_glob?: string;                     // optional narrowing, e.g. "/compose*"
  severity?: MemorySeverity;              // default "med"
  tags?: string[];                        // ≤10
  detail: {
    wall?: string;                        // blocker: symptom
    door?: string;                        // blocker: workaround
    note?: string;                        // affordance/gotcha/lesson: the fact
    locator?: Locator;                    // selector: reuse procedures descriptor
  };
  links?: { procedures?: string[]; memories?: string[] };
  stats?: MemoryStats;
  meta?: { version: number; created: string; updated: string;
           source: "scribe" | "mcp-tool" | "cli"; corroborated?: boolean };
}
```

`validateMemory(record)` enforces: name pattern; `scope==="site" ⇒ origin`;
kind/detail coherence (`blocker`⇒`wall`+`door`, `selector`⇒`detail.locator`,
`affordance|gotcha|lesson`⇒`detail.note`); field caps.

---

## 4. Open decisions — RESOLVED (locked for execution)

1. **Trust model:** confidence-only + `meta.corroborated` once ≥2 captures agree.
   No procedures-style verify-gated `trusted`.
2. **Scribe:** dedicated `browserops-scribe` skill (symmetric with `browserops-teach`).
3. **Subdomain matching:** exact host by default; opt-in `origin_wildcard` per record.
4. **Capture aggressiveness:** roadblocks always; task-completion only for
   non-trivial flows (skip single-navigation reads).

---

# EXECUTION

Each substep is one commit. `Verify` substeps run typecheck + lint + tests and
must pass before committing.

## Phase 1 — Shared data model (additive)

- **1.1** In `packages/shared/src/memory.ts`, **add** `MemoryScope`, `MemoryKind`,
  `MemorySeverity`, `MemoryStats`, `MemoryRecord` and `validateMemory()`. Import
  `Locator` from `./procedures`. Do **not** remove legacy types yet (kept until 4.4).
  Commit: `feat(memory): add structured MemoryRecord schema + validateMemory`
  - [x] Done
- **1.2** In `packages/shared/src/tools.ts`, **add** JSON-schema builders for the
  v2 record and for the two new tool inputs (`memory_session_trace`,
  `memory_list_for_origin`). Additive — leave existing schemas in place.
  Commit: `feat(memory): add JSON schemas for v2 memory tool inputs`
  - [x] Done
- **1.3** Add unit tests for `validateMemory` (scope/origin rule, kind/detail
  coherence, name pattern, caps).
  Commit: `test(memory): cover validateMemory rules`
  - [x] Done
- **1.4 Verify** typecheck + lint + shared tests. (No code; fixes only.)
  Commit: `chore(memory): phase 1 verify`
  - [x] Done

## Phase 2 — Store rewrite (two stores + index + guards + migration)

- **2.1** Rewrite `packages/bridge/src/memory/store.ts`: YAML (de)serialization,
  `global/` + `sites/<origin-slug>/` layout (slug = host, `.`/`:`→`-`), build +
  persist `index.json` (`origins`, `global`, `confidence`), reuse the existing
  `writeChain` lock + atomic temp-rename. Keep `BROWSEROPS_MEMORY_DIR` override.
  Commit: `feat(memory): YAML two-store layout with origin index`
  - [x] Done
- **2.2** Add dedup guard + `merge_into?: string` to `saveMemory`: on create, if a
  same-scope/same-origin record exceeds the similarity threshold and `merge_into`
  is absent, return `{ possible_duplicate: { name, score } }` instead of writing.
  Commit: `feat(memory): dedup guard and merge_into on save`
  - [x] Done
- **2.3** Add a redaction guard: reject records whose `detail.*` contains
  email-shaped / long-digit / obvious-PII strings, with a clear error.
  Commit: `feat(memory): redaction guard rejecting PII in records`
  - [x] Done
- **2.4** One-time migration shim: legacy `~/browserops/memory/*.md` →
  `scope:global, kind:lesson` (`title` from description, `detail.note` from body),
  moving originals to `…/memory/_legacy/`. No-op when the store is empty.
  Commit: `feat(memory): one-time legacy markdown migration`
  - [x] Done
- **2.5** Rewrite `packages/bridge/src/memory/search.ts`: add `scope`/`origin`/
  `kind` filters; rank by confidence first, then token coverage.
  Commit: `feat(memory): scope/origin filters and confidence ranking in search`
  - [x] Done
- **2.6** Tests: store roundtrip, index build/persist, dedup, redaction, migration,
  filtered search.
  Commit: `test(memory): store roundtrip, index, dedup, migration`
  - [x] Done
- **2.7 Verify** typecheck + lint + bridge tests.
  Commit: `chore(memory): phase 2 verify`
  - [x] Done

## Phase 3 — Confidence & decay model

- **3.1** New `packages/bridge/src/memory/confidence.ts`: `MemoryStats` rollup,
  `confidence(record)` = f(severity, recency(last_hit), resolved/hits,
  −door_failures) → [0,1], decay rule, self-heal threshold constants (modeled on
  `packages/bridge/src/procedures/health.ts`).
  Commit: `feat(memory): confidence + decay model`
  - [x] Done
- **3.2** Wire confidence into the store's `index.json` (cache per record) and into
  search ranking (3.1 → used by 2.5's ranker).
  Commit: `feat(memory): persist confidence in index and rank by it`
  - [x] Done
- **3.3** Tests: confidence math, decay over time, door-failure demotion to
  "fix no longer reliable".
  Commit: `test(memory): confidence, decay, door-failure demotion`
  - [x] Done
- **3.4 Verify.**
  Commit: `chore(memory): phase 3 verify`
  - [x] Done

## Phase 4 — Tool surface + default-on + legacy removal

- **4.1** In `packages/shared/src/tools.ts`, replace the four memory tool defs with
  v2 shapes (`memory_save` takes a `MemoryRecord` + optional `merge_into`;
  `memory_search` gains `scope`/`origin`/`kind`; results carry `confidence`) and
  add `memory_session_trace` + `memory_list_for_origin`. Remove the now-dead
  legacy schemas added in 1.2's neighbours.
  Commit: `feat(memory): v2 tool definitions (save/search/get/delete + trace + list)`
  - [x] Done
- **4.2** Update the bridge memory handlers + their dispatch in
  `packages/bridge/src/mcp-server.ts` (memory cases ~lines 451–494) to the new
  shapes: save→record+merge_into, search→filters, add `memory_list_for_origin`.
  (`memory_session_trace` is implemented in 5.3.)
  Commit: `feat(memory): wire bridge handlers to v2 tool shapes`
  - [x] Done
- **4.3** In `packages/shared/src/features.ts`, set `FEATURE_METADATA["memory"]
  .default = true`. Keep it a feature (disable-able via `BROWSEROPS_FEATURES` /
  `~/.browserops/config.json`).
  Commit: `feat(memory): enable memory feature by default`
  - [x] Done
- **4.4** Remove the legacy frontmatter types / `memoryTypeEnum` from
  `packages/shared/src/memory.ts` and any now-dead legacy parse paths in
  `store.ts`. Confirm nothing references them (`tsc` is the proof).
  Commit: `refactor(memory): drop legacy frontmatter types`
  - [x] Done
- **4.5** Tests: tools/list exposure with feature default-on, tools/call dispatch,
  `FEATURE_DISABLED` only when explicitly disabled.
  Commit: `test(memory): tool dispatch and default-on gating`
  - [x] Done
- **4.6 Verify** full workspace typecheck + lint + tests (legacy now gone).
  Commit: `chore(memory): phase 4 verify`
  - [x] Done

## Phase 5 — Session trace + roadblock signals

- **5.1** New `packages/bridge/src/memory/trace.ts`: bounded per-session
  `TraceBuffer` ring (≈50 entries/session: `{method, origin, error_code?,
  effect_summary, ts}`), keyed by `session_id`, readable cross-session.
  Commit: `feat(memory): per-session action trace ring buffer`
  - [x] Done
- **5.2** Record each tool call into the buffer in the `mcp-server.ts` reply path
  (`reply()` ~lines 948–972), deriving origin from the resolved tab URL.
  Commit: `feat(memory): record tool calls into trace buffer`
  - [x] Done
- **5.3** Implement the `memory_session_trace` handler ({`tab_id?`|`session_id?`,
  `limit?`} → recent entries; tab_id resolves to its session).
  Commit: `feat(memory): memory_session_trace handler`
  - [x] Done
- **5.4** New `packages/bridge/src/memory/capture-signals.ts`: detect roadblock
  clusters over recent trace (error codes, `WRITE_NOT_REFLECTED`, no-op effect
  after an action, `browser_wait_for` timeout, repeated retries, `USER_DECLINED`).
  Commit: `feat(memory): roadblock capture-signal detector`
  - [x] Done
- **5.5** Attach `capture_hint = {reason, origin, trace_ref}` to responses in
  `dispatch` when a roadblock cluster fires.
  Commit: `feat(memory): surface capture_hint on tool responses`
  - [x] Done
- **5.6** Tests: ring eviction, cross-session read, signal detection thresholds.
  Commit: `test(memory): trace buffer and capture signals`
  - [x] Done
- **5.7 Verify.**
  Commit: `chore(memory): phase 5 verify`
  - [x] Done

## Phase 6 — Hybrid delivery

- **6.1** New `packages/bridge/src/memory/delivery.ts`: `SiteContextManager`
  ((session_id, origin) → `UNPRIMED|PRIMED|RE-NUDGED`) + primer formatter (terse
  `title`-only index, confidence-ranked, ≤5 lines).
  Commit: `feat(memory): SiteContextManager and primer formatter`
  - [x] Done
- **6.2** Warm `SiteContextManager` on the `page_navigated` event in
  `packages/bridge/src/daemon-runtime.ts` (preload origin records from index).
  Commit: `feat(memory): warm site context on navigation`
  - [x] Done
- **6.3** In `mcp-server.ts` `dispatch`, after the extension result returns and
  before `reply`, consult `SiteContextManager`: append a `site_context` content
  entry on first resolve of an `UNPRIMED` origin (→ `PRIMED`); suppress thereafter;
  re-nudge the matching blocker's `door` when `capture_hint` fired (→ `RE-NUDGED`);
  deliver path-subset on new `path_glob` match.
  Commit: `feat(memory): inject per-site primer into tool responses`
  - [x] Done
- **6.4** Extend `buildServerInstructions` in
  `packages/bridge/src/server-instructions.ts` with an optional `globalDigest`;
  compute the top-N global records (by confidence, ≤10 title lines) at daemon
  startup and pass it at Server construction (`mcp-server.ts` ~line 242).
  Commit: `feat(memory): global memory digest in server instructions`
  - [x] Done
- **6.5** Self-heal: when `capture_hint` fires on an origin with a recently
  delivered blocker, bump that record's `stats.door_failures` via the store.
  Commit: `feat(memory): self-heal door-failure tracking`
  - [x] Done
- **6.6** Tests: prime-once/suppress/re-nudge state machine, global digest content,
  path-subset, door-failure bump.
  Commit: `test(memory): delivery state machine and global digest`
  - [x] Done
- **6.7 Verify.**
  Commit: `chore(memory): phase 6 verify`
  - [x] Done

## Phase 7 — Capture orchestration (skills)

- **7.1** New `skills/browserops-scribe.md`: the memory-scribe subagent guide —
  trigger contract (roadblock vs task-done), minimal background brief, hard rules
  (search-before-save + `merge_into`, privacy/behavior-only, one record per
  capture, scope choice), cross-session trace fetch via main agent's session_id.
  Commit: `feat(skill): add browserops-scribe capture guide`
  - [x] Done
- **7.2** Add the capture orchestration rule + scribe spawn (background, haiku) to
  `skills/browserops.md` (on roadblock always; on task-done for non-trivial flows).
  Commit: `feat(skill): add memory capture orchestration rule`
  - [x] Done
- **7.3** Register `browserops-scribe` in the skill sync manifest (locate where
  `browserops`/`browserops-teach` are listed for `browserops sync skills`).
  Commit: `feat(skill): register browserops-scribe for sync`
  - [x] Done

## Phase 8 — Docs + final

- **8.1** Update the agent-instructions doc (`AGENTS.md`; `CLAUDE.md` is its
  symlink): de-opt-in memory, document the two stores, auto-capture, hybrid
  delivery, and the new tools.
  Commit: `docs: document memory v2 (two stores, auto-capture, hybrid delivery)`
  - [x] Done
- **8.2** Update `README.md`: memory section + default-on feature note + setup.
  Commit: `docs: update README for default-on memory`
  - [x] Done
- **8.3** Flip every `- [ ] Done` to `- [x] Done`; run full `tsc --noEmit` + lint +
  the complete test suite across packages.
  Commit: `docs: complete memory v2 plan`
  - [x] Done
- **8.4** Open one PR for `feat/memory-v2` (no intermediate PRs). PR body
  summarizes the two stores, auto-capture loop, and hybrid delivery; no Claude
  attribution. *(Action step, not a commit.)*
  - [x] Done

---

## 9. Risks & mitigations

| Risk | Mitigation | Substep |
|---|---|---|
| Auto-capture duplicate explosion | search-before-save + server dedup guard + `merge_into` | 2.2, 7.1 |
| PII leakage into shared memory | redaction guard + behavior-only scribe brief | 2.3, 7.1 |
| Primer noise / context bloat | confidence ranking + decay + ≤5-line index + pull-on-demand | 3.x, 6.1 |
| Stale doors (UI changed) | `door_failures` self-heal loop; recalled memory is a hint, verify it | 6.5 |
| Bridge can't spawn agents | bridge only detects + provides trace + saves; client spawns scribe | 5.x, 7.x |
| Static instructions | global digest is once-per-session (slow-changing knowledge) | 6.4 |
| Scribe in a different session | TraceBuffer readable cross-session; main agent passes session_id | 5.1, 7.1 |
