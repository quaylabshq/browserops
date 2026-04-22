# Plan 03 — `browser_read` pagination and selector-scope

**Source:** `session-retrospective.md` §2a / §5 priority #4.

## 1. Summary

Add three params to `browser.read` — `selector` (CSS string, scopes extraction), `start` (byte offset ≥ 0), and `length` (slice size, default ≤ `max_length`) — and two response fields — `total_length` and `next_start` — so callers can fetch a PDP slice without the "saved to disk → `jq`" round-trip called out in the retrospective. Stateless: no `read_id` handle (that is §2f future work).

## 2. Files touched

All paths absolute. Line ranges from the current HEAD.

- `packages/shared/src/tools.ts` — `read: ToolDef` at **414–478**. Add `selector`, `start`, `length` to `inputSchema.properties`; add `total_length`, `next_start` (and keep `truncated`) to `outputSchema.properties`; leave `max_length` as a ceiling.
- `packages/shared/src/tools.test.ts` — extend after line **63** with a new `describe` covering the read schema.
- `packages/extension/src/background/handlers/read.ts` — entire handler is the edit surface:
  - `ReadMode` + `ReadParams` + `ReadResult` typedefs at **21–38**
  - `parseParams` at **53–66**
  - `sanitizeHtml` at **68–80**
  - `injectedReadText` / `injectedReadOuterHtml` / `injectedReadMarkdown` at **88–167**
  - `injectedA11yWalk` at **176–429** (esp. root selection at **420–422**)
  - `execInTab` at **431–449** (add args-passing overload)
  - the `router.register("browser.read", …)` body at **573–632**
- `packages/bridge/src/mcp-server.ts` — **no code changes required**; Ajv validates new params via the shared schema and `useDefaults: true` (line 182) will populate `start`/`length`/`max_length` defaults before the handler sees them. Verify at line 244–258.
- **New test file:** `packages/extension/src/background/handlers/read.slice.test.ts` — unit-level tests for the pure helpers (`sliceContent`, clamp logic, envelope assembly). Pulled out of the handler so they can run under Vitest without a real Chrome runtime.

## 3. Current behavior

`browser.read(tab_id, mode)` — **no pagination today**.

- **`mode="text"`** → `execInTab(injectedReadText)` returns `document.documentElement.innerText` verbatim (`read.ts:88–90, 616`).
- **`mode="markdown"`** → injected walker at `read.ts:96–167` DFS-walks `document.body` and returns a joined string.
- **`mode="sanitized_html"`** → injects `injectedReadOuterHtml` (full `document.documentElement.outerHTML`), then `sanitizeHtml()` (`read.ts:68–80`) strips `<script>/<style>/<noscript>/<meta>/<link>/<!-- -->` and `class|style|id|on*|data-*` attrs via regex.
- **`mode="a11y_tree"`** → injected walker at `read.ts:176–429`, DFS from `document.body`, emits numbered `[ref] role "name"` lines and a `RefEntry[]` stored in the `RefCache` keyed by `tab_id` (`read.ts:591–612`).

**Output envelope today** (wire + schema):

```ts
// shared/src/tools.ts:429–468
{ content: string, refs: { [key]: {...} }, url: string, title: string, mode, truncated?: boolean }
```

Handler actually returns `refs: RefEntry[]` (array) — the schema says object-map, and the handler returns an array (`read.ts:28–33, 605–631`). That is an **existing, separate drift** — flag but do not fix in this plan.

**There is NO in-server on-disk overflow path.** `max_length` and `truncated` exist in the schema (`tools.ts:425, 438`) but the extension handler never reads `max_length` and never sets `truncated`. The "saved to disk, `jq` it" behavior the retrospective describes is client-side — Claude Code writes the oversized tool result to a temp file on its own. Implication: **we don't have to remove a disk-write path, we just have to give the caller a way to ask for less.**

The only slicing that exists is the a11y walker's 500-ref cap and per-name 80-char `truncate` (`read.ts:177, 193–197`) — neither related to byte-range pagination.

## 4. Proposed implementation

### 4a. Selector scope

**Wire:** add `selector: { type: "string", minLength: 1, maxLength: 1024 }` to `inputSchema`. Optional; absence = current behavior (whole document).

**Extension:** apply `selector` as close to the DOM read as possible so each mode sees a consistent scoped root.

- `injectedReadText(selector?: string)` → `selector ? (document.querySelector(selector) as HTMLElement | null)?.innerText ?? "" : document.documentElement.innerText`.
- `injectedReadOuterHtml(selector?: string)` → same pattern but `.outerHTML`. Return `""` if no match.
- `injectedReadMarkdown(selector?: string)` → change `visit(document.body, 0)` at `read.ts:165` to `visit(root, 0)` where `root = selector ? document.querySelector(selector) : document.body`. Return `""` if selector matched nothing.
- `injectedA11yWalk(selector?: string)` → change `walk(document.body, 0)` at `read.ts:420–422` to the selected element, if any. Walker body is otherwise untouched. (a11y_tree is "sensible" for selector scoping — common case: "just the refs inside `<main>`".)

**Empty-match policy:** return `content=""`, `total_length=0`, `next_start=null`, and a new field `matched_selector: false` in the envelope. Do **not** throw — callers often speculate on selectors (`#prod-details`, `[data-testid="..."]`). The retrospective explicitly complains about round-trips; a soft miss is cheaper than an error.

**Pass-through mechanism:** `execInTab` currently only takes a 0-arg `func`. Extend it to accept an `args: unknown[]` tuple forwarded to `chrome.scripting.executeScript({ args })`. Pattern already used on line 219 of `navigation.ts` and line 659 of `read.ts` (describe_ref), so this is consistent.

**Interaction with `sanitized_html`:** `sanitizeHtml` is a pure-string regex pass that operates fine on fragments — no `DOMParser` dependency (read.ts:68–80 is explicitly regex because MV3 service workers lack DOMParser). Passing it a subtree's `outerHTML` works unchanged. Verify with a test case that feeds a `<div>` fragment.

### 4b. `start` + `length` slicing

**Wire:** add to `inputSchema`:

```jsonc
"start":  { "type": "integer", "minimum": 0, "default": 0 },
"length": { "type": "integer", "minimum": 1024, "maximum": 1048576, "default": 20000 }
```

Keep `max_length` as a hard ceiling (still defaults to 131072), but make `length` the caller-preferred slice size; server-side `effectiveLength = Math.min(length, max_length)`.

**Where to slice:** after the full per-mode `content: string` has been constructed, once, in the SW. Do not try to stream from the injected function — the full string is already materialized in-tab and returned as one `result` from `executeScript`; slicing in the SW is ~free and keeps the injected functions simple.

**Slice implementation:** add a pure helper:

```ts
function sliceContent(content: string, start: number, length: number):
  { slice: string; total_length: number; next_start: number | null; truncated: boolean }
```

Semantics (see §6 for rationale): operate on **JavaScript UTF-16 code units** (i.e., `content.length` and `content.slice(start, start+length)`). `total_length = content.length`. `next_start = start + length < total_length ? start + length : null`. `truncated = next_start !== null`. Clamp `start > total_length` → returns `""`, `next_start = null`, no error.

### 4c. Response envelope

Extend `outputSchema` (`tools.ts:429–468`):

```jsonc
"total_length": { "type": "integer", "minimum": 0 },
"next_start":   { "type": ["integer", "null"], "minimum": 0 },
"matched_selector": { "type": "boolean" },
"start":        { "type": "integer", "minimum": 0 },
"length":       { "type": "integer", "minimum": 0 }    // actual bytes returned
```

All additive, all optional on the wire (don't add to `required`). Keep `truncated` and wire it to mean "there is more content after this slice" (`next_start !== null`). Document in the tool description that `truncated=true` no longer implies data loss — it implies "call again with `start=next_start`".

**Backwards compatibility:** existing callers that omit `start`/`length` get default `start=0, length=20000` and the new fields; content for pages ≤20k is unchanged but callers that relied on always getting the whole PDP in one response now get only 20k. That is an intentional cost reduction (exactly the §5 goal), but call it out in the tool description so an older agent prompt doesn't get silently truncated. If backwards-compat concerns dominate, the fallback is `length` default of `max_length` (131072); pagination becomes opt-in. **Recommended: opt-in default `length = max_length`**, documented caveat that callers should pass a smaller `length` to save tokens. See open question Q3.

### 4d. Per-mode semantics matrix

| Mode             | `selector` | `start`/`length` |
|------------------|------------|------------------|
| `text`           | innerText of matched node (or `""`) | slice post-construction |
| `markdown`       | walker rooted at matched node | slice post-construction |
| `sanitized_html` | `outerHTML` of matched node → regex sanitize | slice post-construction |
| `a11y_tree`      | walker rooted at matched node; refs still cached in full | slice applies to the text `content` (the printed tree) only — `refs[]` is returned whole |

**a11y_tree caveat:** `refs` is structured data, not a byte stream. Slicing it would break the `ref → selector` contract the ref-cache depends on (`read.ts:594–604`). So: `content` (the tree string) is paginated, `refs` always returns the full array for the selected subtree. Document this explicitly.

### 4e. Tests

Add to `packages/shared/src/tools.test.ts`:

- `read.inputSchema` has required `[tab_id, mode]`, additionalProperties:false, allows `selector`/`start`/`length`.
- `read.outputSchema` has `total_length`, `next_start`, `matched_selector` as optional properties.
- Negative: rejects `start: -1`, `length: 0`, `selector: ""`.

Add `packages/extension/src/background/handlers/read.slice.test.ts`:

- `sliceContent("abcdef", 0, 3)` → `{ slice:"abc", total_length:6, next_start:3, truncated:true }`
- `sliceContent("abcdef", 3, 3)` → `{ slice:"def", next_start:null, truncated:false }`
- `sliceContent("abcdef", 6, 3)` → `{ slice:"", next_start:null, truncated:false }`
- `sliceContent("abcdef", 100, 3)` → `{ slice:"", next_start:null, truncated:false }` (clamp)
- `sliceContent("abc", 0, 100)` → `{ slice:"abc", next_start:null }` (length > total)
- UTF-16 surrogate-pair case: slicing mid-surrogate returns a string with a lone high surrogate; assert the code-unit semantics explicitly so the contract is locked.

To unit-test this, refactor `sliceContent` into a named export — the rest of `read.ts` stays within the SW-bound module, but a pure helper is importable by Vitest. Either put it inline and export, or move it to `packages/shared/src/read-slice.ts` so both sides can reason about it (bridge side doesn't need it yet, but putting it in `shared` is cheap insurance for future §2f `read_id` work).

**Manual/smoke verification:** the extension already has a smoke harness (`pnpm test:smoke` per `package.json:20`). Add a fixture page served from the smoke harness with known content length; read with `{start:0, length:50}` then `{start:50, length:50}`; assert concatenation equals whole.

## 5. Sequencing (independently committable, typecheck+test gate between each)

Each commit ends with `pnpm -r typecheck && pnpm test`. No Claude attribution in commit messages.

1. **Schema + shared helper.** Add `start`/`length`/`selector`/`max_length` params and `total_length`/`next_start`/`matched_selector` output fields to `tools.ts`. Add `sliceContent` to a new `packages/shared/src/read-slice.ts`. Extend `tools.test.ts` and add a `read-slice.test.ts` covering the slice math. Gate passes with pure unit tests; no runtime wiring yet.
2. **Extension: byte-range pagination on existing modes.** In `read.ts`, parse `start`/`length`/`max_length`, import `sliceContent`, wrap the existing per-mode content construction with the slice call, and extend `ReadResult` + response envelope. No selector support yet. Gate: typecheck green. Manual smoke: `browser.read(mode:"markdown", start:0, length:2000)` on a long page.
3. **Extension: selector scope for text/markdown/sanitized_html.** Extend `execInTab` to forward `args: unknown[]`. Add an optional `selector` arg to `injectedReadText`/`injectedReadOuterHtml`/`injectedReadMarkdown`. Return `""` + `matched_selector:false` when selector misses. Gate: smoke test reading scoped subtree on a fixture page.
4. **Extension: selector scope for a11y_tree.** Feed the selector-matched element to `walk()` in `injectedA11yWalk`. Document that `refs[]` returns the full scoped set regardless of `start`/`length`. Gate: smoke test.
5. **Docs + description polish.** Update `browser.read`'s `description` in `tools.ts` to explain `start`/`length`/`next_start`, the a11y caveat, and the matched_selector semantics. Cross-link `plans/04-tools.md §browser.read` (existing section). Gate: typecheck only (docs).
6. **(Optional) Tune default `length`.** Once steps 1–5 are deployed, decide based on real usage whether to lower the default from `max_length` to e.g. 20000. Separate commit — easy to revert.

## 6. Risks / tradeoffs

- **Mid-token slicing (HTML/markdown).** Slicing by code units can split a UTF-16 surrogate pair or cut mid-tag/mid-entity. Acceptable because callers are typically substring-searching (`indexOf("$")`, `grep -i`), not parsing. Document the caveat; offer a future "safe-boundary" mode only if real callers break. Alternatives considered: (a) byte offsets via `TextEncoder` — adds cost and confuses JS-land callers; (b) token-aware splitting — too expensive and mode-specific. **Chosen: UTF-16 code units, documented.**
- **`sanitized_html` on fragments.** The sanitizer is regex over a string (read.ts:68–80) — document or fragment makes no difference. Verified. No change needed.
- **`a11y_tree` + selector + refs.** If the caller slices the tree string, ref IDs inside the slice may dangle (a printed `[47] link "..."` appears in the slice but `refs[47]` might be further along the array). Since `refs` is returned whole, this is fine — the caller can still dereference. Document this.
- **Response envelope change.** All new fields are additive and optional; `truncated` is reinterpreted to mean "more available". Older agent prompts that treated `truncated:true` as a warning will now see it more often (and correctly). Mitigation: description text spells out the new meaning; consider a dedicated `more_available: boolean` synonym for clarity. See Q1.
- **On-disk overflow path.** Doesn't exist server-side; it's Claude Code's client behavior. Pagination doesn't obsolete it but greatly reduces how often it triggers. No code to remove.
- **Default `length` regression.** If we default `length` small (20k), existing callers that read short pages get paginated unnecessarily. If we default to `max_length`, the token-saving benefit requires opt-in. Recommend default `max_length`; sell pagination via the description + a short example in the tool docstring.
- **Memory on huge pages.** We still materialize the full per-mode content in the SW (e.g., 2 MB HTML) before slicing. That's unchanged from today and hasn't been an issue; MV3 SW has ~100 MB headroom. Revisit only if a page blows it up.

## 7. Open questions

- **Q1.** Rename `truncated` → `more_available` (or add `more_available` alongside and deprecate `truncated`)? `truncated` today (pre-ship) means "we cut off data you can't recover"; post-ship it would mean "call again". Different meaning, same field name, risk of agent confusion.
- **Q2.** Should selector mismatch raise `INVALID_PARAMS`, a new `SELECTOR_NO_MATCH` code, or stay a soft `matched_selector:false`? Argument for soft: callers speculate. Argument for hard: matches existing failure-mode patterns (`TEXT_NOT_FOUND`, `REF_NOT_FOUND`). Soft is cheaper on tokens; hard is more discoverable.
- **Q3.** Default `length`: `max_length` (131072, safe backcompat) or something smaller like 20000 (aggressive token savings but surprises existing callers)? Lean `max_length` now, tighten later.
- **Q4.** Should `selector` honor shadow DOM the way the a11y walker does at `read.ts:413–417`? `document.querySelector` does not pierce open shadow roots. Could implement a small `deepQuerySelector` for parity. Probably out of scope for v1 — pinned to this plan as follow-up.
- **Q5.** Should the bridge forward the new params unchanged? Yes — no special handling; `mcp-server.ts` validates via the shared Ajv schema at line 255 and forwards via `callExtension` at 320–325. Confirm only.

### Critical Files for Implementation

- `packages/shared/src/tools.ts`
- `packages/extension/src/background/handlers/read.ts`
- `packages/shared/src/tools.test.ts`
- `packages/shared/src/read-slice.ts` (new)
- `packages/extension/src/background/handlers/read.slice.test.ts` (new)
