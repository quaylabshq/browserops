# Plan 05 — `browser.query_selector` (read-only CSS-keyed describe)

**Source:** `session-retrospective.md` §1f / §5 priority #8.

## 1. Summary

Ship `browser.query_selector`, a read-only MCP tool that returns the same shape as `browser.describe_ref` but keyed by a CSS selector instead of by an a11y-walker-assigned ref. Closes the gap where the walker skipped an element (generic div, unusual role, `display:contents`, below the 500-ref cap) but the caller still needs to inspect it. Pure read: no ref assignment, no walker mutation, no click/type surface.

Shape: `browser.query_selector({ tab_id, selector, all?: false }) -> match | match[] | null`, where each `match` mirrors the `describe_ref` result object field-for-field: `{ tag, role, name, visible, disabled, focused, checked, value, attrs, aria, rect }` (omitting the `ref` field, since there is no ref).

## 2. Files touched

Exact paths with line ranges.

- `packages/extension/src/background/handlers/read.ts`
  - Lines 500–567: existing `injectedDescribe(selector)` — already factored as "selector → state object". This is the reuse seam. Add a sibling `injectedQueryAll(selector, maxResults)` that runs `querySelectorAll`, slices to cap, maps through the same per-element state code (either extract a shared inner function within the injected closure, or keep the single-selector version for `all:false` and a parallel batch version for `all:true`).
  - Lines 634–680: existing `router.register("browser.describe_ref", …)`. Add a new sibling `router.register("browser.query_selector", …)` right after it, in the same `registerReadHandler` function.

- `packages/shared/src/tools.ts`
  - Lines 815–866: existing `describeRef` ToolDef — the new `querySelector` ToolDef lives directly below it and copies the per-match output schema verbatim (drop the `ref` property; top-level result is a single object with optional `match` / `matches` / `total` / `truncated` properties — no top-level `oneOf`).
  - Lines 986–1010: `TOOL_DEFS` catalogue array. Add `querySelector` (will bump tool count from 23 → 24).

- `packages/shared/src/tools.test.ts`
  - Line 7: update `expect(TOOL_DEFS).toHaveLength(23)` → `24`.
  - Add assertions in the existing `describe` block for the new tool: `action_weight: 0`, `risky: "never"`, error codes include `INVALID_PARAMS` / `TAB_NOT_FOUND`.

- `packages/bridge/src/mcp-server.ts`
  - No code change needed. Tool registration is automatic via `for (const def of TOOL_DEFS)` (line 184) and `TOOL_DEFS.map(...)` (line 194). Adding the ToolDef in shared/tools.ts and an extension handler is sufficient.

- `plans/04-tools.md` — append a new subsection for `browser.query_selector` to keep the catalogue authoritative.

## 3. Current behavior — how describe_ref resolves and computes the shape

`browser.describe_ref` flow (read.ts 634–680):

1. Parse `{ tab_id, ref }`.
2. Resolve `tab_id` → `chromeTabId` via `opts.tabIdMap`.
3. Look up the last RefSnapshot for the tab via `opts.refCache.get(tab_id)`. `REF_STALE` if absent.
4. Look up the specific `ref` in `snap.entries`. `REF_NOT_FOUND` if absent.
5. Call `chrome.scripting.executeScript` in MAIN world with `injectedDescribe(entry.selector)` — where `entry.selector` is the selector that the a11y walker originally generated (see `selectorFor` in read.ts 321–360: id-based, `[data-testid=...]`, or `tag:nth-of-type(n) > ...` path).
6. `injectedDescribe` (read.ts 500–567) is the element → state function. It is already factored cleanly: takes a CSS selector string, does `document.querySelector(selector)`, and returns `{ found, role, name, tag, visible, disabled, focused, checked, value, attrs, aria, rect }`. Relevant details:
   - `role`: raw `role` attribute only (empty string fallback). (Note: `describe_ref` wraps this with `res.role ?? entry.role` at line 668 to fall back on the walker's computed role. For `query_selector` there is no `entry`, so we surface whatever the attribute is — document this asymmetry, or consider porting the walker's `roleFor()` fallback; see open questions.)
   - `name`: `aria-label` else trimmed `textContent`, sliced to 200 chars.
   - `visible`: rect non-zero AND not visibility:hidden / display:none / opacity:0.
   - `disabled`: `el.disabled` OR `aria-disabled="true"`.
   - `focused`: `document.activeElement === el`.
   - `checked`: `el.checked` OR `aria-checked="true"`.
   - `value`: `(el as HTMLInputElement).value` sliced to 1024.
   - `attrs`: filtered allowlist `[id, class, name, type, href, placeholder, data-testid]`.
   - `aria`: every `aria-*` attribute.
   - `rect`: `{ x, y, width, height }` from `getBoundingClientRect`.
7. If `found === false`, `describe_ref` raises `REF_STALE`. For `query_selector` the "not found" case should instead return `null` (for `all:false`) or `[]` (for `all:true`) — not found is not an error when the caller is probing.

Reuse seam: `injectedDescribe` is already "given an element (addressed by a CSS selector), return the state object". We keep it as-is for `all:false`. For `all:true` we add `injectedQueryAll(selector, maxResults)` that runs the same body on each element from `querySelectorAll(selector)`, capped at `maxResults` with a `total` field indicating how many matched pre-cap.

## 4. Proposed implementation

### Step a. Refactor `injectedDescribe` body into a reusable element-state encoder

Inside read.ts (~line 500–567), extract the element → state object logic into a nested helper so both the single-match and all-match injected functions can call it without duplicating the 60-line state computation.

Because `chrome.scripting.executeScript` injects a single top-level function into the page (no closures), the helper must be redeclared inside each injected function. Cleanest shape:

```ts
function injectedQuery(selector: string, all: boolean, maxResults: number): QueryResult {
  const describeOne = (el: HTMLElement) => { /* body currently in injectedDescribe 514–566 */ };
  if (!all) {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (el === null) return { found: false, matches: [] };
    try {
      return { found: true, matches: [describeOne(el)], total: 1 };
    } catch (e) { /* handled by executeScript */ }
  }
  let list: NodeListOf<Element>;
  try {
    list = document.querySelectorAll(selector);
  } catch (e) {
    return { found: false, matches: [], invalidSelector: String(e?.message ?? e) };
  }
  const total = list.length;
  const out: StateObj[] = [];
  for (let i = 0; i < Math.min(total, maxResults); i++) {
    out.push(describeOne(list[i] as HTMLElement));
  }
  return { found: total > 0, matches: out, total };
}
```

Option: keep `injectedDescribe` wrapping `injectedQuery(sel, false, 1)` and only use `injectedQuery` for the new tool — leaves existing describe_ref semantics bit-for-bit identical, which is safest for a no-behavior-change refactor commit.

Also add try/catch around `document.querySelector` itself for `all:false`: an invalid selector throws a `SyntaxError`, which should surface as `INVALID_PARAMS` rather than a generic `INTERNAL`. Return `{ invalidSelector: "…" }` from the injected function, check it in the host handler, and throw coded `INVALID_PARAMS`.

**Commit A**: pure refactor — extract `describeOne` inside `injectedDescribe`, no behavior change to `describe_ref`. Typecheck + test.

### Step b. Add extension-side `browser.query_selector` handler

In `registerReadHandler` (read.ts ~634), add a new `router.register("browser.query_selector", …)` handler directly after `describe_ref`:

```ts
router.register("browser.query_selector", async (rawParams) => {
  const tab_id = rawParams["tab_id"];
  const selector = rawParams["selector"];
  const all = rawParams["all"] === true;
  const max = 50; // constant cap, see §6
  if (typeof tab_id !== "string") throw codedError("INVALID_PARAMS", "tab_id must be a string");
  if (typeof selector !== "string" || selector.length === 0 || selector.length > 2048) {
    throw codedError("INVALID_PARAMS", "selector must be a non-empty string up to 2048 chars");
  }
  const chromeTabId = opts.tabIdMap.get(tab_id);
  if (chromeTabId === undefined) throw codedError("TAB_NOT_FOUND", `unknown tab_id: ${tab_id}`);

  const results = await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    world: "MAIN",
    func: injectedQuery,
    args: [selector, all, max],
  });
  const res = results[0]?.result as QueryResult | undefined;
  if (res === undefined) throw codedError("INTERNAL", "executeScript returned no result");
  if (res.invalidSelector !== undefined) {
    throw codedError("INVALID_PARAMS", `invalid CSS selector: ${res.invalidSelector}`);
  }

  if (all) {
    return {
      matches: res.matches,
      total: res.total ?? res.matches.length,
      truncated: (res.total ?? res.matches.length) > res.matches.length,
    };
  }
  return { match: res.matches[0] ?? null };
});
```

Note the deliberate choice to use MAIN world for parity with `describe_ref` — consistent `value` read on React inputs.

**Commit B**: add the handler. Typecheck.

### Step c. MCP schema registration

Add `querySelector: ToolDef` to `packages/shared/src/tools.ts` directly below `describeRef` (line ~866). Append it to the `TOOL_DEFS` array (line ~1008).

Input schema:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id", "selector"],
  "properties": {
    "tab_id": tabIdSchema,
    "selector": { "type": "string", "minLength": 1, "maxLength": 2048 },
    "all": { "type": "boolean", "default": false }
  }
}
```

Output schema: factor a shared `elementStateSchema` object (the property bag currently inlined in `describeRef.outputSchema` lines 832–860 minus `ref`). Use it as:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "match": { "oneOf": [elementStateSchema, { "type": "null" }] },
    "matches": { "type": "array", "items": elementStateSchema, "maxItems": 50 },
    "total": { "type": "integer", "minimum": 0 },
    "truncated": { "type": "boolean" }
  }
}
```

Because MCP strips top-level `oneOf` on input (see `stripTopLevelUnions` in mcp-server.ts ~line 199), avoid top-level unions between `{match}` and `{matches, total}` shapes. Keep the output a single object with optional `match` / `matches` / `total` / `truncated` properties; the handler chooses which fields to populate.

Metadata:
- `action_weight: 0` (observation-only, cheaper than `read`).
- `risky: "never"`.
- `errorCodes: [...BASE_CODES, ...TAB_CODES]` — no REF_CODES (not ref-based). `INVALID_PARAMS` is already in BASE_CODES.

**Commit C**: shared ToolDef registration. Typecheck + tests (update count 23→24).

### Step d. Tests

- `packages/shared/src/tools.test.ts`:
  - Bump `toHaveLength(23)` → `24`.
  - Add a block asserting: `TOOL_DEF_MAP["browser.query_selector"]` exists; `action_weight` 0; `risky` "never"; input schema requires `tab_id` + `selector`; output schema `additionalProperties: false`.
- Schema roundtrip: assert `selector` has `maxLength: 2048` and `minLength: 1`, and `all` has `default: false`.
- Integration test (per plan 08 §2) — if the integration harness exists yet, add a mock-extension scripted reply and assert MCP result shape. If not wired, skip.
- Manual smoke: query against `#id`, `.class`, `button[type=submit]`, invalid selector `>>>`, `all: true` with 100+ matches (cap assertion), shadow-DOM selector (known negative).

**Commit D**: tests. Run `pnpm test` across the workspace.

## 5. Sequencing — one commit per step

1. **Commit A**: Refactor `injectedDescribe` to extract `describeOne` inner helper. No behavior change to `describe_ref`. Run: `pnpm -r typecheck && pnpm test`.
2. **Commit B**: Add `injectedQuery` + `router.register("browser.query_selector")` in `extension/src/background/handlers/read.ts`. Run typecheck. No runtime test yet (shared ToolDef not present, so MCP server won't surface it — the extension handler is registered but unreachable).
3. **Commit C**: Add `querySelector` ToolDef in `shared/src/tools.ts`; append to `TOOL_DEFS`. Update `tools.test.ts` length assertion from 23 → 24. Run `pnpm -r typecheck && pnpm test`. At this point the tool is wired end to end.
4. **Commit D**: Extend `tools.test.ts` with the new tool's schema assertions. Add any integration-level scripted mock reply if the integration harness is present. Run full `pnpm test`. If integration suite isn't ready, skip and rely on manual smoke.
5. **Commit E** (optional): Append a subsection to `plans/04-tools.md` documenting the new tool's schema for the canonical catalogue.

No Claude attribution in commit messages.

## 6. Risks / tradeoffs

- **Selector injection**: `querySelector(selector)` runs in the page context the agent already fully controls (same permission level as `execute_js`). Not a security concern; no safety prompt needed. Flag in the handler doc comment so future readers don't add one reflexively.
- **Large `all: true` results**: cap at `MAX_MATCHES = 50`. Return `{ matches, total, truncated }`. If `truncated: true`, the caller can narrow the selector. Rationale: each match is ~500 bytes of JSON; 50 × 500 = 25 KB is already a stretch for a single tool result. `value` and `textContent` slicing (already 200/1024 in `injectedDescribe`) caps any one field, so the 50-element ceiling is the only additional bound needed.
- **Selector syntax errors**: wrap `document.querySelector` / `querySelectorAll` in try/catch inside the injected function; surface a `{ invalidSelector: "<SyntaxError.message>" }` sentinel; the host handler translates to `INVALID_PARAMS` rather than an `INTERNAL` crash.
- **Shadow DOM**: `document.querySelector` does not pierce closed OR open shadow roots (unlike the a11y walker, which does descend open shadow roots at read.ts 413). Document as a known limitation in both the tool description and `plans/04-tools.md`. Do not try to solve here — pierce-aware selectors would require a tree traversal and a custom selector grammar, out of scope.
- **`name` for non-interactive elements**: `injectedDescribe`'s `name` computation (`aria-label` OR trimmed `textContent`) can return a 200-char blob for a generic `<div>` (e.g. the whole paragraph text). Document that `name` is meaningful for interactive elements and best-effort otherwise; callers inspecting `<div class="price">` should read `textContent` semantically, not treat `name` as an accessible name.
- **`role` fallback asymmetry with `describe_ref`**: `describe_ref` falls back on the walker's computed `entry.role` when the raw attribute is empty (handler line 668). `query_selector` has no walker entry, so a role-less element returns `role: ""`. Differs from `describe_ref`'s output for the same element. See Open Questions Q3.
- **Tool count drift**: `tools.test.ts` hard-codes `23`. Bumping to `24` is trivial here, but flag the pattern as fragile for future tool additions (could switch to a snapshot or to `>= 20` sanity check).
- **Cross-origin iframes**: `executeScript` only runs in the top frame by default. A selector that matches only inside a cross-origin iframe will return `null`. This matches `describe_ref`'s existing behavior — consistent limitation, document once.

## 7. Open questions

1. **Cap value**: is 50 right, or should it be 20? 50 seems generous enough for "find all price tags on a product list page"; 20 would keep the worst-case payload under 10 KB. Defaulting to 50 with a `truncated` flag gives callers feedback to tighten the query.
2. **Configurable cap**: should `all` be `all?: boolean | number` where a number is the cap? Keeps the API small vs. giving the caller control. Recommend no — force callers to refine the selector if 50 isn't enough; arbitrary caps hide the real problem.
3. **`role` computation parity**: worth porting the walker's `roleFor()` fallback (read.ts 237–271) into `injectedDescribe` so `query_selector` returns a computed role for implicit roles on e.g. `<button>` or `<nav>`? Would make the two tools more interchangeable. Recommend yes — small, self-contained, avoids a confusing `role: ""` on a `<button>`. Could be a separate commit before this plan or folded into Commit A.
4. **Return `selector` that the caller passed, echoed back?** Useful for batched callers. Not strictly needed; punt.
5. **`visible` semantics for `all: true`**: many matches may be offscreen but not hidden (e.g. a virtualised list below the fold). Current `describe_ref` treats "has non-zero rect" as visible regardless of scroll — keep that behavior for consistency, document that offscreen elements still report `visible: true`.
6. **Should `query_selector` results be persisted into a "pseudo-ref" cache so a follow-up `click_by_selector` could use them without re-querying?** Out of scope per the task statement (read/write separation). Flag for a future tool.

### Critical Files for Implementation

- `packages/extension/src/background/handlers/read.ts`
- `packages/shared/src/tools.ts`
- `packages/shared/src/tools.test.ts`
- `packages/bridge/src/mcp-server.ts`
- `plans/04-tools.md`
