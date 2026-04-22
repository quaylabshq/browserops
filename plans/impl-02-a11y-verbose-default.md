# Plan 02 — A11y tree walker `verbose=false` default

**Source:** `session-retrospective.md` §2b / §5 priority #3.

## 1. Summary

Make `browser.read(mode:"a11y_tree")` default to a compressed tree that drops role-less / name-less `generic` nodes and retains only (a) named nodes, (b) core-interactive-role nodes (`button, link, textbox, combobox, checkbox, radio, menuitem, tab`), and (c) structural ancestors needed to parent them. A new opt-in `verbose: true` param restores today's full output. Expected win: 60–80% fewer tokens per a11y read.

Core constraints:

- **(i)** Ref identity for nodes that survive the filter must be byte-for-byte unchanged vs. today's walk, so downstream `click(ref)` / `type(ref)` / `describe_ref` / `wait_for(ref)` calls issued on the returned response continue to work.
- **(ii)** Role-less `cursor:pointer` / `onclick` divs surfaced by the earlier walker extension (see retrospective §2b follow-up) must still emit in non-verbose mode — they flow through `roleFor()` as synthetic `"button"` and that's the whole point of that earlier fix.

## 2. Files touched

Exact locations from current HEAD:

- `packages/extension/src/background/handlers/read.ts`
  - Lines 21–66 (`ReadMode`, `ReadParams`, `parseParams`): extend schema to accept `verbose?: boolean`.
  - Lines 176–429 (`injectedA11yWalk`): the walker itself. New filter pass + `verbose` plumbing.
  - Lines 569–612 (`registerReadHandler` / `browser.read`): thread `verbose` through `execInTab` args and into the result.
- `packages/shared/src/tools.ts`
  - Lines ~414–478 (`read: ToolDef`): add `verbose: { type: "boolean", default: false }` to `inputSchema.properties`; document the semantic in the tool description. No `required` change.
- `packages/bridge/src/mcp-server.ts`
  - Around line 415 and wherever the read tool validator is registered (`this.validators` table, ~line 176). Pass-through only — the bridge does not transform the params, but any hand-rolled validator / help text that mentions "four modes" should mention `verbose` too.
- `packages/shared/src/tools.test.ts`
  - Lines ~50–60 (existing `browser.read` assertions such as `action_weight === 0.5`): extend with a test that `verbose` is a valid optional bool and that the default is `false`.
- `plans/05-element-refs.md`
  - §4.2 and §4.4: add a short "Compression modes" subsection describing `verbose=false` behavior so the design doc stays in sync.
- `session-retrospective.md` §2b — flip the "still open" tag once shipped.

`packages/extension/src/background/ref-cache.ts` is read but **not modified** — ref identity is unchanged (see §6).

## 3. Current behavior

### Walk (read.ts lines 386–422)

`walk(el, depth)` is a recursive DFS that:

1. Aborts the subtree if `canDescend(el)` is false.
2. Computes `role = roleFor(el)` — which can return a real ARIA role, `"generic"` (for tabindex-bearing nodes with no other semantics, line 266), a synthetic `"button"` (for `cursor:pointer` / `onclick` divs — the §2b fix, lines 228–235 and 269), or `null`.
3. Computes `keep = shouldKeep(el, role) && canEmit(el)`. `shouldKeep` returns true for interactive+structural roles and for tags in the interactive/structural tag sets; it returns **false** for role `"generic"`. This means today the `"generic"` role assignment at line 266 is already pruned by `shouldKeep` unless the element has a matching tag — tabindex-only nodes rarely survive today.
4. If `keep`, assigns `refCounter += 1` and emits the entry. Crucially: **`refCounter` is incremented in DFS order only for kept-and-emitted elements**. `role === "generic"` paths never consume a ref today.
5. Recurses into children regardless of `keep`; shadow roots pierced at line 413.

### Tree rendering (lines 403–405)

Indented text form keyed off `depth`, with `[ref] role "name"`. Entries with empty `name` render as `[ref] role` (no quoted name). Today's noise profile — 30–80% `[N] generic` lines — comes from the **interactive/structural-tag path** in `shouldKeep` (e.g. `<header>`, `<form>`, `<main>`, `<h1>` that all produce non-`generic` roles) plus landmark roles; it is not `role === "generic"` per se. The §2b role-less-click-handler path emits as `[N] button` not `[N] generic`.

### Refs

`RefEntry[]` is returned alongside the tree and stored in `RefCache` keyed by `tab_id`. The ref integer is 1-based, DFS-order, capped at `MAX_REFS = 500`. `click`, `type`, `hover`, `wait_for(ref)`, `describe_ref` all look up by integer. A new `read` overwrites the cache (ref-cache.ts L66) and drops any prior snapshot, so refs **do not need to be stable across reads** — they only need to be stable within a single read's returned tree and its subsequent action calls.

## 4. Proposed implementation

### (a) Schema: add `verbose` flag

In `packages/shared/src/tools.ts` `read.inputSchema.properties`, add:

```
verbose: { type: "boolean", default: false, description: "When true, return the legacy full tree including role='generic' and name-less nodes. Default false collapses noise." }
```

Do **not** add to `required`. Default false. Update the `read.description` one-liner to mention compression.

In `packages/extension/src/background/handlers/read.ts` `parseParams`, read `raw["verbose"]`, default `false`, narrow to `boolean`, store on `ReadParams`.

### (b) Filter design — during-walk, not post-walk

Two options considered:

- **Post-walk filter.** Walk today's tree, produce entries, then strip uninteresting ones and renumber. Problem: renumbering breaks ref alignment with nodes that were previously numbered N; an agent that issues `read` → `click(ref=12)` now gets a different element. If we preserve the original ref integers and just delete rows, the rendered tree has gaps (`[3]`, `[7]`, `[15]` …) which is ugly and still costs the agent tokens to reason about. Rejected.
- **During-walk filter (recommended).** Change `shouldKeep` (or a new `shouldEmitNonVerbose` layer in front of it) so the DFS never counts a non-surviving node. Because `refCounter` only advances for emitted nodes, this yields compact sequential refs `[1..K]` with K = post-filter count. Still deterministic DFS order, still ≤ MAX_REFS. This is the recommended approach.

### (c) Filter rules (non-verbose)

A node is **emitted** iff all today's emit gates pass (`canEmit`, `shouldKeep(el, role)`, role non-null) **and** at least one of:

1. `nameOf(el).trim().length > 0` — has an accessible name.
2. `role` ∈ `{"button", "link", "textbox", "combobox", "checkbox", "radio", "menuitem", "tab"}` (the "core interactive set" the user specified).
3. Any descendant (checked post-hoc; see below) satisfies (1) or (2) — structural-keep of parent scaffolding so Claude can still say "Send button in the Compose form".

Rule (2) already covers the §2b `cursor:pointer`/`onclick` path because those nodes are assigned synthetic `role="button"` before `shouldKeep` runs. Verify by reading `roleFor()` line 269 — retained.

Rule (1) covers landmark/heading elements that carry a visible name. Name-less `generic` (the retrospective's main offender) is dropped.

Rule (3) — structural-keep — requires knowing whether a descendant will emit. Two sub-options:

- **Two-pass.** Walk once to collect the set of elements that pass (1)∨(2); walk again emitting elements from that set plus their ancestors up to `document.body`. Simple, O(2N), but doubles the DOM traversal cost.
- **One-pass with deferred emission (recommended).** Recurse first, collecting child-emitted entries into a local array per frame. On return, if the node itself passes (1)∨(2), emit it (assigning a ref now) followed by its child entries. If it doesn't but any child emitted, emit it as a structural keeper (still assigning a ref so descendants have an anchor in the rendered tree). If neither self nor any child emitted, drop the entire subtree. Ref numbering then reflects **pre-order of survivors only** — identical to the invariant today, modulo the filter.

Recommended: one-pass deferred emission. The ref-assignment step moves from "at walk-time" to "at emit-time on return from recursion", but both are in DFS pre-order so the resulting ref ordering is indistinguishable from what a hypothetical post-hoc filter would produce. The walker returns both `entries[]` and `tree` string — both built from the same accumulator so they stay aligned.

A subtlety: the §2b click-candidate check prefers the *outermost* cursor:pointer node (lines 228–235 dedupe by comparing parent cursor). That check runs inside `roleFor()` and is unaffected by the new filter — it fires during the recursion into each element, before we decide whether to emit. Keep as-is.

### (d) Wiring

In `injectedA11yWalk`, the walker is invoked as a zero-arg function today (line 592). Change the signature to `injectedA11yWalk(verbose: boolean)` and pass via `chrome.scripting.executeScript({ args: [params.verbose] })` — note this requires switching from `execInTab(chromeTabId, injectedA11yWalk, "ISOLATED")` to the lower-level `chrome.scripting.executeScript` call that already exists for `injectedDescribe` (line 655), or extending `execInTab` to accept args. The describe path at line 655 shows the pattern; factor a small `execInTabWithArgs` helper to avoid duplication.

Inside the walker, branch: if `verbose === true`, run today's `shouldKeep`/emit logic unchanged (legacy path). If `verbose === false`, run the new filter. Gate the branch at the outermost `walk` entry — do not sprinkle conditionals through `shouldKeep`.

### (e) Defaults + output contract

`verbose` defaults to `false` in the schema and in `parseParams`. The response shape is unchanged; `entries[]` is simply shorter in non-verbose mode. `RefSnapshot` in the cache is populated from `entries` so ref lookups work identically.

Optional nicety: include `verbose: boolean` in the `ReadResult` content header (e.g. first line of the rendered tree: `# a11y_tree (compact) — 42 refs`) so the agent can see which mode it got without re-checking its params. Low priority; keep for a follow-up.

### (f) Tests

1. `packages/shared/src/tools.test.ts`: assert `TOOL_DEF_MAP["browser.read"].inputSchema.properties.verbose.default === false`; assert the schema allows `{ tab_id, mode, verbose: true }` and `{ tab_id, mode }`.
2. Unit test for the walker is tricky because `injectedA11yWalk` is a closure meant to ship into a tab context. Two options:
   - Extract the pure filter logic into a module-level helper that can be unit-tested with a JSDOM fixture. Preferred if scope allows.
   - Land a small end-to-end test under `packages/extension/` using `happy-dom` or a static HTML fixture piped through a test runner. Heavier.
   - For this slice: add a regression test at the JSDOM level covering four fixtures — (i) generic-only div tree → empty output, (ii) button inside nested generics → button survives, parents kept as structural, (iii) cursor:pointer div → emitted as `button` in non-verbose, (iv) `verbose:true` matches legacy output exactly on a mixed fixture.
3. Snapshot-tests check: grep for any hardcoded expected a11y tree output in tests or fixtures.
   ```
   grep -rn "\[1\] generic\|a11y_tree" packages/ --include="*.ts"
   ```
   If any snapshot file hardcodes today's verbose output, either re-record with `verbose:true` (to preserve that test's intent) or update the expectation.

## 5. Sequencing

Each step is independently landable (`pnpm -r typecheck && pnpm test` green). No inter-step file locks.

1. **Schema-only** — add `verbose: { type: "boolean", default: false }` to `packages/shared/src/tools.ts`'s `read` ToolDef, extend `tools.test.ts` with the schema assertion. No behavior change; walker still ignores the flag. Verifies that the shared schema + bridge validation accept the new param without breaking existing clients.
2. **Param parsing** — wire `verbose` through `parseParams` in `read.ts`, thread to `injectedA11yWalk(verbose)` as an argument, but let the walker ignore it (literally discard). Adds the `execInTabWithArgs` helper. Still a no-op on behavior. Confirms the MAIN/ISOLATED arg path works end-to-end before we change semantics.
3. **Walker filter (verbose:true branch = today, verbose:false = new compact)** — implement deferred-emission DFS. Keep the old logic reachable verbatim for `verbose:true`. This is the behavior change. Add the JSDOM-level regression tests described in §4(f).
4. **Flip default** — set `default: false` in the schema (already done in step 1) and in `parseParams` (already done in step 2). If steps 1/2 already set the default, step 4 is a no-op verification commit plus a retrospective update. Combine with step 3 if you prefer.
5. **Docs** — update `plans/05-element-refs.md` §4.2 with the compression rules; update `session-retrospective.md` §2b to mark shipped.

Commit messages (no Claude attribution, imperative, present-tense):
- Step 1: `a11y: add verbose opt-in flag to browser.read schema`
- Step 2: `a11y: thread verbose param into walker (no-op)`
- Step 3: `a11y: compact walker drops name-less generic nodes in non-verbose mode`
- Step 4 (if separate): `a11y: default browser.read verbose=false`
- Step 5: `docs: reflect a11y compact default in plan 05 + retrospective`

## 6. Risks / tradeoffs

### Ref stability for surviving nodes

Because today's walker assigns refs only to `keep && canEmit` elements (line 389), and the new filter is a **strict subset** of today's keep set, **every node that survives the new filter would also have been kept today** — but at a different ref integer if earlier siblings are now dropped. That is fine *within a single read*: `browser.read` returns the new ref integers, and the same response populates `RefCache` (read.ts L604). The agent's next `click(ref=N)` uses whatever the latest read returned. The cross-read stability story is unchanged: today's cache is already overwritten on every read (§2e is a separate open problem), and this plan does **not** regress that baseline.

Recommendation: during-walk filter (option (b) in §4). Post-walk filtering is rejected precisely because renumbering would create a window where in-flight ref refs (e.g. an agent that reads, starts reasoning, then clicks) see a ref that no longer maps. With during-walk, the response's `entries[]` and the cache's `RefSnapshot` are built together, atomically, under the new numbering — there is no split-brain window.

### Downstream tools

- **`click_by_text`** (`input.ts` L1331): does not consume the tree at all — runs its own DOM query via `injectedClickByText`. Not affected.
- **`click(ref)` / `type(ref)` / `hover(ref)`**: all go through `resolveSelector(refCache, tab_id, ref)` (`input.ts` L116), which hits the snapshot written by the same `read` call. Not affected — the cache reflects the new numbering.
- **`describe_ref`** (`read.ts` L634): same story — uses the latest snapshot. Not affected.
- **`wait_for` ref-mode** (`input.ts` ~L903, L956, L991): also snapshot-relative. Not affected as long as the caller's most recent `read` populated the cache.

**Risk:** an agent that read with verbose=true historically, stored a ref, then issued a new default read (verbose=false) expecting the same ref. Today's cache is already per-read-snapshot, so this was never guaranteed; no regression. Callers that want the legacy shape pass `verbose: true` explicitly.

### The §2b click-candidate divs

Must survive non-verbose. They flow through `isClickCandidate` → `roleFor()` returns `"button"` → `shouldKeep` returns true (button is in `INTERACTIVE_ROLES`) → the new filter's rule (2) keeps them. Verified by reading lines 228–271. **Regression guard:** add a unit test with a `<div style="cursor:pointer" onclick="...">Buy now</div>` fixture and assert it emits under `verbose:false`. This is the single highest-value test in the suite — it's what earned the §2b patch.

### Snapshot / fixture tests

Before landing, grep for hardcoded tree strings:

```
grep -rn "\[[0-9]\+\] generic\|a11y_tree.*expect\|tree.*toBe\|toMatchSnapshot" packages/
```

Any that pin the old verbose output must either (a) pass `verbose:true` in the test's request, or (b) be re-baselined to the new compact output. Do not silently update snapshots — re-baselining should be its own commit so the diff is inspectable.

### Token-win measurement

The retrospective cites 60–80%. That's an estimate from the Flipkart/Gmail transcripts. Worth capturing one before/after measurement (e.g. on gmail.com/inbox) in the step-3 commit description so the claim is grounded.

### Describe_ref never-emitted elements

`describe_ref` only accepts refs that were emitted — since the filter drops *fewer-useful* nodes, the set of describable refs shrinks. This is fine (an agent that cares about a specific hidden generic should pass `verbose:true`) but worth a sentence in the tool docs.

## 7. Open questions

1. **Structural-keep depth limit?** A deeply nested button inside 15 generic wrappers will keep all 15 ancestors as structural under rule (3). Worth considering a cap (e.g. emit only ancestors that had a non-empty `name` or a landmark role). Conservative default: no cap for v1; landmark-only structural keeping is a plausible v2 tuning if the compact output is still noisy.
2. **Default for truncation marker.** When `MAX_REFS` is hit (line 425), the "[... N more refs elided]" message currently counts only *kept* nodes. Non-verbose mode will elide fewer. No change proposed; just flagging.
3. **Should `verbose:true` be deprecated?** If the compact form is right, we could mark verbose as "debug only". Recommend keeping as first-class opt-in — there will be real cases (automation research, snapshot-testing a site) where full fidelity matters.
4. **Expose `verbose` on `ReadResult`?** Not strictly needed; useful for agent introspection. Punt to a follow-up.

### Critical Files for Implementation

- `packages/extension/src/background/handlers/read.ts`
- `packages/shared/src/tools.ts`
- `packages/shared/src/tools.test.ts`
- `packages/extension/src/background/ref-cache.ts`
- `plans/05-element-refs.md`
