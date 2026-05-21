# Playbooks — Implementation Plan

> A complete, self-contained execution plan. Designed so any competent engineer
> (or a fresh agent with no prior conversation context) can execute it from
> top to bottom and produce the same result.

---

## 0. Agent execution instructions (read first, do not skip)

You are executing this plan. Treat these as hard rules — do not deviate without
explicitly stopping to ask.

1. **Read this entire document before starting.** Skim every phase so you
   understand dependencies between substeps.
2. **Order is mandatory.** Execute substeps strictly in numeric order
   (0.1 → 0.2 → … → 10.x). Later substeps depend on earlier ones.
3. **Branch.** All work lands on `feat/playbooks` (already created off `main`).
4. **One commit per numbered substep.** Each substep specifies an exact commit
   message in `feat(scope): summary` form. Use it verbatim. No combining
   substeps into one commit.
5. **No Claude attribution on commits.** Do not include `Co-Authored-By:
   Claude …` lines, "Generated with Claude Code" footers, or any other
   Claude attribution. Commit body contains only the message specified.
6. **Single PR at the end (do not merge).** Substep 10.3 pushes the branch and
   opens a single PR. Do not merge it; the user will review and merge.
7. **Stop on real blockers, don't improvise.** If a substep depends on a tool
   or API that doesn't exist, stop and report rather than guessing.
8. **Verify before commit.** Each phase ends with a `pnpm typecheck` +
   `pnpm test` sanity check. If either fails, fix before committing the next
   substep.
9. **Use the dedicated tools** (Read, Edit, Write, Bash) — not `cat`/`sed`/
   `echo`. Follow the rest of the standard tool-usage rules in CLAUDE.md.

---

## 1. Why this plan exists

Today's `procedures` artifact is **an LLM-baked recipe**: an agent uses the
`browserops-teach` skill to author a YAML file whose steps are concrete
`browser_*` tool calls, then a `procedures_execute` runner replays the steps
and checks per-step `expected_effect` predicates against the observed
`page_effect`. That works, but two structural facts limit its reach:

1. **The runtime has no real fallback engine.** `on_fail` is in the schema but
   never invoked by `execute.ts`; the replay halts on the first divergence.
2. **There is no semantic locator system.** Steps refer to refs (integers
   from a per-tab a11y cache) baked at author time. A trusted procedure rots
   the moment the page's a11y tree shifts — there's no `getByRole`/`getByText`
   equivalent that re-resolves on every step.

Playbooks fix both without disturbing procedures. The artifact stays a YAML
file, but:

- **Locators are descriptors** (`{role, name, has_text, nth, near, in_frame}`)
  re-resolved against the live a11y tree each step. No more `REF_STALE` in
  procedure-driven flows; no need for a `browser_quick_read → bind → click`
  pattern in the YAML.
- **Steps auto-wait** for actionability (attached, visible, stable, enabled)
  before dispatch — Playwright-style.
- **`expect:` is a retrying predicate**, polled until match or timeout.
- **Each step declares a fallback strategy.** Ladder: `strict` (default) →
  `retry` (same locator) → `relocate` (fuzzy re-derivation) → `llm` (halt with
  a structured envelope, agent resumes via `playbooks_resume`).
- **Top-level `verify:`** is a goal-grounded predicate evaluated after the
  last step — independent of step-level expects.
- **`forbidden:`** is a runtime check: locators or actions matching the block
  are refused before dispatch, including those proposed by an LLM remediation.

Procedures stay exactly as they are. A playbook can call a procedure
(`do: procedure_call, name: ...`) and a procedure can call a playbook
(`action: playbook_call, with: { name: ..., inputs: {...} }`). Two-way
composition lets each system play to its strengths: procedures for cheap
LLM-baked leaves, playbooks for durable orchestration.

The `browserops-teach` skill, the `procedures_*` tool surface, the procedures
storage path, and the `procedures` feature flag are untouched.

---

## 2. Architectural overview

```
USER REQUEST
   │
   ▼
AGENT
   │   (chooses one of:)
   │     • call browser_* directly      (existing path)
   │     • call procedures_*             (existing path, untouched)
   │     • call playbooks_execute        (new — this plan)
   │
   ▼
MCP BRIDGE
   │
   ▼
playbooks/execute.ts ── orchestrates one playbook run ──┐
   │                                                    │
   │   per step:                                        │
   │     1. resolve locator (if any) against live a11y  │
   │     2. auto-wait for actionability                 │
   │     3. dispatch the action via wsBridge            │
   │     4. poll expect predicate                       │
   │     5. on miss → fallback ladder                   │
   │                                                    │
   ▼                                                    │
EXTENSION                                               │
   handlers/locate.ts ← new: descriptor → ref + ready   │
   handlers/input.ts  ← extended: accepts locator       │
                                                        │
on `strategy: llm` halt:                                ▼
   playbooks/state.ts holds the suspended run ─→ envelope returned to agent
                                                        │
   playbooks_resume(execution_id, patch) ──────────────┘
```

Five new modules in the bridge (`paths`, `store`, `validator`, `index-builder`,
`search`, `execute`, `handlers`, `state`, `fallback`, `forbidden`), one new
module in the extension (`handlers/locate.ts`), one new shared module
(`packages/shared/src/playbooks.ts`) plus a small locator-types module
(`packages/shared/src/locator.ts`). Everything else is wire-up.

---

## 3. Schema reference (authoritative)

```yaml
schema_version: 1
name: gmail.send_email           # lowercase, dotted prefix becomes domain
description: "Compose and send..." # ≤200 chars
kind: leaf                       # leaf | composite
goal: "Send an email."           # human-readable overall goal (≤200 chars)
domain: gmail                    # optional; derived from dotted prefix
triggers: ["send email"]         # ≤10 phrases for search
tags: ["email", "compose"]       # ≤10 short lowercase tokens
side_effects: [send_message]     # send_message | payment | post_public |
                                 # modify_account | delete

inputs:
  to:      { type: string, required: true, destructive: true }
  subject: { type: string, required: true }
  body:    { type: string, required: true }

forbidden:                       # runtime safety bar — refused before dispatch
  locators:
    - { name: /^delete/i }
    - { name: /^discard/i }
  actions: ["browser_execute_js"] # actions outright banned in this playbook

verify:                          # top-level goal predicate (post-last-step)
  text_visible: "Message sent"
  network_endpoint_seen: "/sendmessage"

uses: []                         # required for kind: composite

steps:
  - id: open_compose
    goal: "Open the compose pane."
    do: click                    # click | type | press | hover | navigate |
                                 # scroll | wait | observe | procedure_call |
                                 # playbook_call | js
    locator:                     # required for click/type/hover/press
      role: button
      name: /^compose/i
      nth: 0
    auto_wait:
      timeout_ms: 4000           # cap on actionability poll
      poll_interval_ms: 200
    expect:
      new_dialog: true
      timeout_ms: 5000
    fallback:
      strategy: relocate_then_llm  # strict | retry | relocate |
                                   # relocate_then_llm | llm
      budget:
        tool_calls: 3
        tokens: 2000
      retry:
        attempts: 2
        backoff_ms: 500
      relocate:
        widen_role: true
        widen_name: true
        consider_text: true

  - id: send
    goal: "Send the email."
    do: click
    locator: { role: button, name: /^send/i, has_text_not: /schedule/i }
    expect:  { network_endpoint: "/sendmessage" }
    fallback: { strategy: llm, budget: { tool_calls: 5, tokens: 2000 } }

meta:                            # bridge-managed
  version: 1
  created: "2026-05-21T..."
  last_verified: "2026-05-21T..."
  status: draft                  # draft | trusted
```

### Locator descriptor (`packages/shared/src/locator.ts`)

```ts
type Locator = {
  role?: AriaRole;                // "button" | "textbox" | ...
  name?: string | RegExp;         // accessible name (case-insensitive substr or regex)
  has_text?: string | RegExp;     // descendant text constraint
  has_text_not?: string | RegExp; // negative descendant text constraint
  in_frame?: string;              // CSS selector of an iframe (optional)
  near?: { ref?: number; locator?: Locator; radius_px?: number };
  nth?: number;                   // 0-based when multiple match
  scope?: "viewport" | "document";
};
```

Regexes are persisted as `"/source/flags"` strings in YAML and re-parsed at
load time. Plain strings without slashes are treated as case-insensitive
substring matches.

### Step actions

| `do:` | Meaning |
|---|---|
| `click` | locator required; auto-wait + dispatch click via existing primitive |
| `type` | locator required; auto-wait + dispatch type with `clear_mode` |
| `press` | locator optional; chord keys array |
| `hover` | locator required; auto-wait + dispatch hover |
| `navigate` | url required; uses `browser_navigate` |
| `scroll` | direction + ref/locator/coords |
| `wait` | wait_for or wait_for_idle conditions |
| `observe` | snapshots state, binds `observation_token` |
| `procedure_call` | name + inputs; in-process call to `procedures_execute` |
| `playbook_call` | name + inputs; in-process call to nested `playbooks_execute` |
| `js` | requires step-level approval; `browser_execute_js` |

### `expect:` predicates

All optional; absent block = no assertion. Polled until match or `timeout_ms`.

```ts
{
  url_matches?: string;             // regex
  text_visible?: string | RegExp;   // substring or regex
  text_invisible?: string | RegExp;
  new_dialog?: boolean | string | RegExp; // any new dialog, or by name
  network_endpoint?: string | RegExp;     // any endpoint matched
  network_endpoint_seen?: string | RegExp; // (top-level verify form — same)
  value_contains?: { locator?: Locator; ref?: number; substring: string };
  visual_delta_at_least?: number;   // 0..1
  focus_moved_to?: { locator?: Locator };
  dom_added_min?: number;
  dom_removed_min?: number;
  console_errors_max?: number;
  timeout_ms?: number;              // poll cap, default 3000
  poll_interval_ms?: number;        // default 200
}
```

### Resume envelope (returned when `playbooks_execute` halts on `strategy: llm`)

```jsonc
{
  "completed": false,
  "status": "needs_assist",
  "execution_id": "ex_abc123",
  "envelope": {
    "playbook_name": "gmail.send_email",
    "step_id": "open_compose",
    "step_index": 0,
    "step_goal": "Open the compose pane.",
    "playbook_progress": "0/8 steps completed",
    "last_attempt": {
      "action": "click",
      "locator_descriptor": { "role": "button", "name": "/^compose/i" },
      "resolution_attempts": ["a11y match found none", "relocate widened-role no match"],
      "page_effect": { /* last observed effect, may be undefined */ }
    },
    "observation_token": "ob_...",       // points to a cached observe snapshot
    "viewport_summary": "<short text>",   // cheap a11y digest
    "available_actions": ["resume_with", "insert_steps", "give_up"],
    "constraints": {
      "side_effects_allowed": ["send_message"],
      "forbidden_locators": [{ "name": "/^delete/i" }],
      "forbidden_actions": [],
      "max_tool_calls": 5,
      "max_tokens": 2000
    },
    "remaining_steps_preview": [
      { "id": "fill_to",    "goal": "Put the recipient..." }
    ]
  },
  "step_results": [ /* up to step_index */ ],
  "expires_at": "2026-05-21T12:34:56Z"
}
```

### Resume patch (input to `playbooks_resume`)

```jsonc
{ "execution_id": "ex_abc123",
  "patch": {
    "kind": "resume_with",        // resume_with | insert_steps | give_up
    "with": {
      "locator": { "role": "button", "name": "New message" }
    }
  }
}
```

```jsonc
{ "patch": { "kind": "insert_steps", "steps": [
    { "id": "_llm_1", "do": "click", "locator": { "role": "link", "name": "Compose" } }
  ] } }
```

```jsonc
{ "patch": { "kind": "give_up", "reason": "Cookie banner unfixable from this surface." } }
```

---

## 4. Phase-by-phase substep list

Each substep is one commit. Commit messages are listed verbatim — use them.

### Phase 0 — Feature flag, error codes, paths

- **0.1** `feat(shared): add playbooks feature flag (default off)`
  Add `"playbooks"` to `FEATURES` in `packages/shared/src/features.ts`, with
  `experimental` stability and `default: false`. Add `FEATURE_METADATA`
  entry. Update `parseFeaturesEnv` / `resolveFeatures` tests if any names
  are hard-coded (they aren't).
- **0.2** `feat(shared): add playbook error codes`
  Add `PLAYBOOK_NOT_FOUND`, `PLAYBOOK_ALREADY_EXISTS`, `PLAYBOOK_SCHEMA_INVALID`,
  `PLAYBOOK_IN_USE`, `PLAYBOOK_RESUME_EXPIRED`, `PLAYBOOK_RESUME_INVALID`,
  `PLAYBOOK_BUDGET_EXCEEDED`, `PLAYBOOK_FORBIDDEN`, `LOCATOR_NOT_FOUND`,
  `LOCATOR_AMBIGUOUS`, `ELEMENT_NOT_ACTIONABLE` to `ERROR_CODES` in
  `packages/shared/src/errors.ts`.
- **0.3** `feat(bridge): playbooksRoot path helper`
  Add `packages/bridge/src/playbooks/paths.ts` mirroring
  `procedures/paths.ts` but rooted at `~/browserops/playbooks/`, honouring
  `BROWSEROPS_PLAYBOOKS_DIR`. Export `playbooksRoot`, `sharedDir`,
  `indexPath`, `playbookYamlPath`, `compositeOwnerDir`, `subsDir`, `dirName`.
- **0.4** `chore: phase 0 typecheck + test pass`
  Run `pnpm typecheck && pnpm test`. Fix anything broken. No code change in
  this commit if everything passes (skip the commit if no fixes needed).

### Phase 1 — Shared schema + locator types

- **1.1** `feat(shared): locator descriptor types + matcher utilities`
  New `packages/shared/src/locator.ts`: `Locator` type, serialised regex
  helpers (`parseSerialisedRegex`, `serialiseRegex`), `locatorToCanonical`
  (stable string form for traces). Pure types — no DOM access.
- **1.2** `test(shared): locator parse/serialise round-trip`
  `packages/shared/src/locator.test.ts` with `vitest`-style tests for the
  regex round-trip, canonical form, and edge cases (empty locator, no name,
  nth=0).
- **1.3** `feat(shared): playbook schema types`
  `packages/shared/src/playbooks.ts`: TS types for `PlaybookDef`, `StepDef`,
  `ExpectDef`, `FallbackDef`, `ForbiddenDef`, `VerifyDef`, `PlaybookMetaDef`.
  Mirror procedures' style (interfaces, with JSDoc).
- **1.4** `feat(shared): playbook JSON-Schema`
  Add `PLAYBOOK_SCHEMA` to the same file. Use the same `JSONSchemaObject`
  type from `tools.ts`. Inline sub-schemas for step/expect/fallback/locator/
  forbidden/verify. Enforce `if kind==composite then required: ["uses"]`.
- **1.5** `test(shared): playbook schema round-trip + validation`
  `packages/shared/src/playbooks.test.ts`: parse a sample playbook YAML,
  validate against the schema, assert pass; flip required fields to assert
  fail.
- **1.6** `feat(shared): export playbooks + locator from index`
  Add `export * from "./locator.js";` and `export * from "./playbooks.js";`
  to `packages/shared/src/index.ts`.
- **1.7** `chore: phase 1 typecheck + test pass`

### Phase 2 — Bridge persistence (store / validator / search / index)

- **2.1** `feat(bridge): playbooks store (atomic read/write/delete)`
  `packages/bridge/src/playbooks/store.ts` mirroring procedures/store.ts:
  `readPlaybookYaml`, `writePlaybookYamlAtomic`, `deletePlaybookDir`,
  `CodedError` re-export.
- **2.2** `test(bridge): playbooks store atomic write`
- **2.3** `feat(bridge): playbook YAML validator`
  `packages/bridge/src/playbooks/validator.ts`: compile `PLAYBOOK_SCHEMA`
  with Ajv, expose `validatePlaybook(parsed)` returning
  `{valid, errors?}`. Reuse the Ajv interop bits from `mcp-server.ts`.
- **2.4** `test(bridge): validator catches schema violations`
- **2.5** `feat(bridge): playbook index builder`
  `packages/bridge/src/playbooks/index-builder.ts`: walk
  `~/browserops/playbooks/{shared,composite}/.../playbook.yaml`, build
  `index.json` manifest with the same entry shape as procedures plus a
  `side_effects` field. Implement `ensureIndex`, `buildIndex`, `writeIndex`.
- **2.6** `test(bridge): index builder round-trip`
- **2.7** `feat(bridge): playbook search (token + trigger ranking)`
  `packages/bridge/src/playbooks/search.ts`: copy the procedures ranker —
  shared tokenizer, same scoring, same scope filter. Adapt the entry shape.
- **2.8** `test(bridge): playbook search scoring + filters`
- **2.9** `chore: phase 2 typecheck + test pass`

### Phase 3 — Extension locator resolver

- **3.1** `feat(extension): locator resolver helper`
  `packages/extension/src/background/handlers/locate.ts`: pure function
  `resolveLocator(tree, descriptor): { matches: Array<{ref, role, name, bounds, actionable}> }`.
  Operates on the in-memory a11y tree produced by
  `read.ts`. Implements role match, name match (substring/regex),
  `has_text`/`has_text_not`, `nth`, `near` (Euclidean), `in_frame`.
- **3.2** `test(extension): locator resolver against fixture tree`
  Fixture a11y tree as JSON, run resolver, assert matches.
- **3.3** `feat(extension): actionability checker`
  Add `isActionable(ref): {ready, reasons[]}` checking attached, visible,
  not occluded, not disabled. Stub: re-use the existing `augment` data
  already attached to refs (`visible`, `in_viewport`, `occluded_by`,
  `disabled_visual`).
- **3.4** `feat(extension): browser_locate handler`
  Register `browser_locate` in `packages/extension/src/background/router.ts`:
  input `{tab_id, locator, timeout_ms?, scope?}`, output
  `{matches: Array<{ref, role, name, bounds, actionable, reasons}>}`. Polls
  every `poll_interval_ms` (default 200) until at least one match is
  actionable or timeout fires. Returns `LOCATOR_NOT_FOUND` /
  `LOCATOR_AMBIGUOUS` / `ELEMENT_NOT_ACTIONABLE` as appropriate.
- **3.5** `feat(shared): browser_locate tool definition`
  Add `browser_locate` to `TOOL_DEFS` in `packages/shared/src/tools.ts` with
  schema and `feature: "playbooks"` gate.
- **3.6** `test(extension): browser_locate happy path`
  Smoke test via `packages/extension/src/background/router.test.ts` (or
  add a focused test for the handler if router tests don't exist yet).
- **3.7** `chore: phase 3 typecheck + test pass`

### Phase 4 — Auto-wait + locator-aware existing tools (optional this PR)

> **Scope decision.** The minimum for v1 is to have `browser_locate` available
> and let `execute.ts` orchestrate (locate → click-by-ref). Extending
> `browser_click` / `browser_type` / `browser_press` / `browser_hover` to
> accept `locator:` inline is a future cleanup that's strictly additive. To
> keep this PR focused, **Phase 4 is deferred** — `execute.ts` performs the
> locate-then-act dance itself. A single commit notes this:

- **4.1** `docs: defer inline-locator tool surface to follow-up`
  Add a short note in `docs/future-plans/playbooks-plan.md` under "Open
  follow-ups" capturing that the inline `locator:` field on
  click/type/hover/press is deferred to a follow-up PR.
- **4.2** `chore: phase 4 typecheck pass`

### Phase 5 — Bridge execute strict mode

- **5.1** `feat(bridge): playbook execution state (in-memory)`
  `packages/bridge/src/playbooks/state.ts`: per-process `Map<execution_id,
  ExecutionState>`. State holds the parsed playbook, current step index,
  step results, accumulated budget, expiry timestamp (5 min). API:
  `createState`, `getState`, `dropState`, `prunePrunable`. Eviction is
  lazy on `getState`.
- **5.2** `test(bridge): execution state lifecycle`
- **5.3** `feat(bridge): variable substitution (shared with procedures)`
  Extract substitution helper to `packages/bridge/src/playbooks/substitute.ts`
  (don't share with procedures yet — different placeholder shapes possible
  in the future, keep them decoupled).
- **5.4** `test(bridge): substitute resolves input + bind references`
- **5.5** `feat(bridge): retrying expect predicate evaluator`
  `packages/bridge/src/playbooks/expectation.ts`: `evaluateExpect(expect,
  observed): {matched, reason?}` using the same predicate set the procedures
  expected_effect evaluator already supports, **plus** the new predicates
  (`url_matches`, `text_visible`, `new_dialog`, `network_endpoint`,
  `value_contains`, `focus_moved_to`).
  `pollExpect(expect, getObservation): Promise<{matched, observed, reason?}>`
  polls every `poll_interval_ms` until match or `timeout_ms`. Returns the
  last observation either way.
- **5.6** `test(bridge): expectation polling timeout + match`
- **5.7** `feat(bridge): forbidden-locator + forbidden-action guard`
  `packages/bridge/src/playbooks/forbidden.ts`: `checkForbidden(playbook,
  action, locator) -> {allowed: boolean, reason?}`. Used before every
  dispatch. Centralised so LLM-proposed steps go through it too.
- **5.8** `test(bridge): forbidden guard refuses matching locators`
- **5.9** `feat(bridge): playbook execute (strict + verify)`
  `packages/bridge/src/playbooks/execute.ts`. Skeleton:
    1. Parse YAML, validate, normalise.
    2. Substitute inputs.
    3. For each step:
       - Run `forbidden` guard.
       - If locator present: call `browser_locate` (via `wsBridge`) with
         `auto_wait.timeout_ms`. On `LOCATOR_NOT_FOUND` / `LOCATOR_AMBIGUOUS`
         / `ELEMENT_NOT_ACTIONABLE`, treat as step failure.
       - Substitute resolved `ref` into the action's `with` params.
       - Call extension via existing dispatch (`browser_click` etc.).
       - On error, treat as step failure.
       - If `expect:` present, poll via `pollExpect`. On timeout, step
         failure.
    4. After the last step, evaluate top-level `verify:` similarly.
    5. Return `{completed: true, steps_executed, step_results, verify_passed}`.
  **No fallback ladder in this substep.** A failure halts and returns
  `{completed: false, divergence: {...}}`.
- **5.10** `test(bridge): execute strict happy path`
  Uses a stub `wsBridge` that returns canned responses.
- **5.11** `test(bridge): execute strict halts on locator miss`
- **5.12** `test(bridge): execute strict halts on expect miss`
- **5.13** `test(bridge): top-level verify enforced`
- **5.14** `chore: phase 5 typecheck + test pass`

### Phase 6 — Retry + relocate strategies

- **6.1** `feat(bridge): retry strategy with backoff`
  In `packages/bridge/src/playbooks/fallback.ts`: `applyRetry(step, attempt,
  err): Promise<{action: "retry" | "next"}>`. Sleep `backoff_ms`, attempt
  count from step state.
- **6.2** `test(bridge): retry exhausts attempts then bubbles`
- **6.3** `feat(bridge): relocate strategy (widen role/name/text)`
  `applyRelocate(step, observed): Promise<{action: "retry_with", locator}
  | {action: "next"}>`. Widening rules:
    - `widen_role: true` → drop the role filter entirely.
    - `widen_name: true` → if name was a regex, switch to substring of the
      regex's literal head; if a substring, allow longer fuzzy matches
      (Levenshtein ≤2 against any candidate accessible name).
    - `consider_text: true` → fall back to a `has_text` lookup using the
      step's `goal:` words as the substring.
- **6.4** `test(bridge): relocate widens then matches`
- **6.5** `feat(bridge): wire strategies into execute loop`
  Update `execute.ts`: on step failure, look at `fallback.strategy`:
    - `strict` → return divergence.
    - `retry` → call `applyRetry`.
    - `relocate` → call `applyRelocate`.
    - `relocate_then_llm` → `applyRelocate`, then on failure escalate to
      llm path (Phase 7 handles).
    - `llm` → handed to Phase 7.
  Budget enforcement: each strategy attempt consumes from
  `fallback.budget.tool_calls`. Per-playbook budget tracked on state.
- **6.6** `test(bridge): execute applies relocate before halting`
- **6.7** `chore: phase 6 typecheck + test pass`

### Phase 7 — LLM fallback + resume

- **7.1** `feat(bridge): resume-envelope builder`
  `packages/bridge/src/playbooks/envelope.ts`: `buildEnvelope(state, step,
  lastAttempt, observed): Envelope`. Includes the constraints block, the
  remaining-steps preview, the observation token (carry forward the
  observation cache id from the last `browser_observe` call). Cheap; no
  screenshot.
- **7.2** `test(bridge): envelope contains constraints + preview`
- **7.3** `feat(bridge): halt + persist state for llm fallback`
  Update `execute.ts`: when `strategy: llm` (or escalation), `createState`
  with the envelope, return `{completed: false, status: "needs_assist",
  execution_id, envelope, expires_at}`.
- **7.4** `feat(bridge): playbooks_resume handler`
  In `handlers.ts`: `handleResume({execution_id, patch})`. Three patch
  kinds:
    - `resume_with`: merge `patch.with` into the failing step's `with` /
      `locator` and re-execute the step.
    - `insert_steps`: validate each step against the step sub-schema, apply
      `forbidden` guard, run them through the same execute loop, then
      continue with the next playbook step.
    - `give_up`: return `{completed: false, status: "gave_up", reason}`.
  Returns either another `needs_assist` envelope, a final completion, or a
  give_up result. State is dropped on terminal outcomes.
- **7.5** `test(bridge): resume with resume_with patch`
- **7.6** `test(bridge): resume with insert_steps patch`
- **7.7** `test(bridge): resume rejects forbidden patches`
- **7.8** `test(bridge): resume expires after TTL`
- **7.9** `chore: phase 7 typecheck + test pass`

### Phase 8 — MCP tool catalogue + dispatch wiring

- **8.1** `feat(shared): playbooks_* tool definitions`
  Add `playbooks_search`, `playbooks_get`, `playbooks_save`,
  `playbooks_delete`, `playbooks_execute`, `playbooks_resume` to
  `TOOL_DEFS` with `feature: "playbooks"`. Schemas mirror procedures'
  where shapes overlap.
- **8.2** `feat(bridge): playbooks handlers (search/get/save/delete)`
  `packages/bridge/src/playbooks/handlers.ts` mirroring
  `procedures/handlers.ts`. Reuse the YAML round-trip approach.
  `handleSave` enforces draft-by-default; `bump_success: true` flips to
  trusted only after a clean run (the runner exposes
  `lastExecutionWasClean(name)` via the state module — set on completed
  strict-mode runs with no LLM fallback).
- **8.3** `test(bridge): handlers crud`
- **8.4** `feat(bridge): wire playbook handlers into mcp-server dispatch`
  In `mcp-server.ts`, add a branch after the `procedures_` block:
  `if (name.startsWith("playbooks_"))` → dispatch through `buildPlaybook
  Handlers(wsBridge)`. Identical telemetry / breaker treatment as
  procedures.
- **8.5** `test(bridge): mcp-server routes playbooks_* in-process`
- **8.6** `feat(bridge): server-instructions playbooks section`
  Extend `server-instructions.ts` with a `playbooksSection` that:
    - shows a one-line opt-in hint when `playbooks` is off,
    - shows usage + composition rules when on.
  Mention that procedures can call playbooks and vice versa.
- **8.7** `test(bridge): server-instructions playbooks branch`
- **8.8** `feat(bridge): playbook_call / procedure_call step actions`
  In `execute.ts`, implement `do: procedure_call` by calling
  `procedureHandlers["procedures_execute"]` in-process, and `do:
  playbook_call` by recursing into `handleExecute`. Inputs forwarded;
  outputs bound to the step's `bind:` if set.
- **8.9** `test(bridge): nested execution (playbook calls procedure)`
- **8.10** `test(bridge): nested execution (procedure calls playbook via existing primitive bridge)`
  This is a manual smoke since `procedures_execute` already dispatches by
  tool name — adding `playbooks_execute` to the catalogue gives it
  immediately. Just verify schema round-trip + a single nested call.
- **8.11** `chore: phase 8 typecheck + test pass`

### Phase 9 — Documentation

- **9.1** `docs(claude): add Playbooks section to CLAUDE.md`
  After the Procedures section, add a short Playbooks section explaining
  the layer, the feature flag, the composition rules.
- **9.2** `docs(skill): cross-reference playbooks in skills/browserops.md`
  One paragraph + cookbook entries for `playbooks_search`,
  `playbooks_execute`, `playbooks_resume`. Don't write a full new skill in
  this PR — that's a follow-up.
- **9.3** `docs(plan): mark playbooks-plan substeps as complete`
  Optional — flip `- [ ] Done` to `- [x] Done` in this file as you go;
  this final commit just locks the last few.

### Phase 10 — Integration tests + final verify

- **10.1** `test(bridge): end-to-end playbook through mocked wsBridge`
  Author a tiny playbook YAML, run `playbooks_save` then
  `playbooks_execute` against an in-test wsBridge stub that scripts the
  expected responses. Assert `{completed: true}`.
- **10.2** `test(bridge): end-to-end llm fallback then resume_with`
  Force a step to fail via the stub, assert `needs_assist`, call
  `playbooks_resume` with a `resume_with` patch, assert completion.
- **10.3** `chore(branch): push feat/playbooks + open PR`
  Run `pnpm typecheck && pnpm test && pnpm lint`. Push branch. Open PR with
  a summary of phases, do not merge.

---

## 5. Open follow-ups (not in this PR)

- Inline `locator:` field on existing `browser_click`/`browser_type`/
  `browser_press`/`browser_hover` (Phase 4 deferred).
- `browserops-playbook` authoring skill (mirrors browserops-teach for
  playbooks specifically; v1 ships without it, authoring is manual).
- Procedure → playbook converter command.
- Playbook recorder (Playwright codegen analog: snapshot real session into
  a draft playbook with semantic locators).
- Trace viewer for playbook runs (today: `BROWSEROPS_TRACE=1` writes JSONL,
  but no viewer).

---

## 6. Non-goals (this PR explicitly does not)

- Replace procedures. Procedures keep their schema, store, tools, and skill.
- Change the tool surface for non-playbook callers. All new tools are gated
  behind the `playbooks` feature flag — off by default.
- Add destructive-action LLM validation gates. The `forbidden:` block is a
  hard refuse; there is no v1 "ask the LLM for a second opinion before
  this destructive step" gate. That's an explicit v2 ask from the user,
  deferred.
- Auto-promote drafts to trusted. `bump_success: true` is still required
  on save, and the runtime refuses the bump if the last execution used LLM
  fallback.

---

## 7. Risk register

| Risk | Mitigation |
|---|---|
| Two systems (procedures + playbooks) inflate maintenance | Playbooks reuse the procedures patterns (paths, store, validator, index, search) — the surface is duplicated but the discipline is identical. Composition is two-way. |
| LLM fallback non-determinism leaks into CI runs | `playbooks_execute({strict: true})` refuses LLM fallback entirely. Default is strict for batch invocations. |
| LLM-proposed action sneaks past forbidden block | The `forbidden` guard runs *every* dispatch including those originating from a resume patch. Test 7.7 enforces this. |
| Resume tokens lost across bridge restart | TTL is 5 minutes; state is in-memory only. Restart drops everything — fail loud with `PLAYBOOK_RESUME_EXPIRED`. |
| Auto-wait timeouts hide real failures | Default 4000ms is short. Each step caps its own timeout. Phase 6 retries are bounded. |
| Locator widening matches the wrong element | Relocate is only invoked under `relocate` / `relocate_then_llm` strategies, which the author opted into. Test 6.4 covers the happy path; misuse falls into LLM fallback. |
| Schema drift between procedures and playbooks confuses authors | Schemas are intentionally similar but in separate files. The CLAUDE.md and skill docs name the differences explicitly. |
