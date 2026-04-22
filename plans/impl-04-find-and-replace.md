# Plan 04 — `browser.find_and_replace`

**Source:** `session-retrospective.md` §1d / §5 priority #6.

## 1. Summary

Add a narrow `browser.find_and_replace(tab_id, ref?, find, replace, occurrence?, mode?)` tool that locates a substring inside a focused or ref-targeted editable element and replaces it without clearing the whole field. The tool rides the existing `synthetic`/`trusted` dispatch split from `browser.type`: it selects the substring with a DOM `Range` built over the element's text-node flat-map, then inserts the replacement either via `beforeinput`/`insertText` (synthetic) or via CDP `Input.insertText` under a debugger attach that already lives in `CdpManager` (trusted). Works on `<input>`/`<textarea>` (offset-based) and on contenteditable (text-node walker that crosses node boundaries). Complements — does not replace — `browser.type(mode:"trusted", clear_first:true)`, which still owns the full-field-clear case.

## 2. Files touched

**Shared tool catalogue**
- `packages/shared/src/tools.ts`
  - ~L658–L700 (`typeTool` — mirror its mode/clear_first schema shape).
  - ~L815–L866 (`describeRef` — closest shape for "ref-optional" tool).
  - L986–L1010 (`TOOL_DEFS` array — add `findAndReplace` tool).
  - L96–L108 (`BASE_CODES`, `TAB_CODES`, `REF_CODES`, `MUTATING_CODES`, `RISKY_CODES` — reused).
- `packages/shared/src/tools.test.ts`
  - L5–L55 (bump tool count from 23 to 24, add name check, risky classification).

**Extension-side handler**
- `packages/extension/src/background/handlers/input.ts`
  - L33–L44 (`CDP_MOD`, `CDP_BUTTON_*` — reused).
  - L99–L126 (`codedError`, `resolveChromeId`, `resolveSelector` — reused; ref will be optional, so we need a variant that falls back to `document.activeElement`).
  - L132–L151 (`execInTab` — reused).
  - L288–L334 (`injectedTypePaste`) — template for the synthetic path and the `isContentEditable` branch; reuses `document.execCommand("insertText", ...)` with the caveats in §6.
  - L346–L461 (`injectedTypeKeystroke`) — template for per-character keystroke path (we won't per-char the replacement, but we lift the setter-descriptor trick for native `<input>`).
  - L1180–L1212 (`performTrustedType` using `Input.dispatchKeyEvent`) — add a sibling `performTrustedInsertText` that uses `Input.insertText` (one-shot CDP primitive that inserts at the current selection).
  - L1400–L1475 (`browser.type` handler in `registerInputHandlers`) — structural template for the new handler; `clear_first` + trusted branch at L1410–L1453 shows the exact focus→CDP pattern we reuse.
  - End of `registerInputHandlers` (~L1541) — inject the new `router.register("browser.find_and_replace", ...)`.

**Bridge MCP surface**
- `packages/bridge/src/mcp-server.ts`
  - L184–L202 (AJV compile loop + `ListTools` — auto-picks up the new `ToolDef`).
  - L296–L313 (risky-action gate — `conditional` risky is honored via `safety.checkRisky`; see §6 security note).
  - L334–L341 (`timeoutFor` — default is fine; no override needed).
  - L147–L165 (`SERVER_INSTRUCTIONS` — one line in the "operator" bullet list mentioning the new tool).
- `packages/bridge/src/safety.ts`
  - L34–L77 (`checkRisky` — add an `if (tool === "browser.find_and_replace" && sensitive) {...}` arm mirroring the `browser.type` clause on sensitive domains; no separate `submit` concept here).

**Docs (optional, follow the convention in `plans/04-tools.md`)**
- `plans/04-tools.md` — add a new subsection under the input-tools group documenting the new tool's schema + error codes. Non-blocking for shipping.

## 3. Current behavior

Today, the nearest thing to find-and-replace is `browser.type(tab_id, ref, text, mode:"trusted", clear_first:true)`.

In the **trusted** path (input.ts L1410–L1453):
1. The extension focuses the element via `chrome.scripting.executeScript` in MAIN world calling `injectedFocusSelector(selector)` (L1035–L1040).
2. If `clear_first` is true, CDP `Input.dispatchKeyEvent` sends `Meta+Control+"a"` keyDown/keyUp followed by `Delete` keyDown/keyUp under `cdp.withAttach` (L1421–L1440). Sending both Meta and Control covers mac vs non-mac without platform detection.
3. `performTrustedType` (L1180–L1212) then dispatches per-character `keyDown`+`char`+`keyUp` for every code point in `text`.

In the **paste** synthetic path (`injectedTypePaste`, L288–L334), for contenteditable it does `Range.selectNodeContents(el)` + `execCommand("delete")` + `execCommand("insertText", false, text)`. For native `<input>`/`<textarea>` it uses the prototype-descriptor `value` setter trick and dispatches `input`/`change`. Neither mode today has any concept of a *substring* range.

Selection-API-related utilities that already exist:
- `window.getSelection()` + `Range.selectNodeContents(el)` (in `injectedTypePaste` L302–L307 and `injectedTypeKeystroke` L364–L371). Used only for "select whole contents".
- Native `<input>/<textarea>` `.select()` call (L314, L374).
- No text-node flat-map / cross-node-boundary search utility exists yet.
- No "insert at current selection without replacing whole field" primitive exists — both paste and keystroke modes assume either appending to the current value or clearing first.

`document.activeElement` is nowhere consulted as an implicit target; every current tool requires a ref.

## 4. Proposed implementation

### 4a. MCP schema + tool registration (stub → not-implemented)

Add `findAndReplace: ToolDef` in `packages/shared/src/tools.ts` modeled on `typeTool` and `describeRef`:

```ts
const findAndReplace: ToolDef = {
  name: "browser.find_and_replace",
  description:
    "Replace a substring inside an editable element without clearing the whole field. " +
    "Works on <input>, <textarea>, and contenteditable. Target resolves to `ref` if given, " +
    "otherwise document.activeElement. Two dispatch modes match browser.type: " +
    "'synthetic' (default; beforeinput + execCommand(\"insertText\")) and 'trusted' " +
    "(CDP Input.insertText; required for sites that gate on isTrusted).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "find", "replace"] as const,
    properties: {
      tab_id: tabIdSchema,
      ref: refSchema,                                // optional
      find: { type: "string", minLength: 1, maxLength: 4096 },
      replace: { type: "string", maxLength: 32768 },
      occurrence: { enum: ["first", "all"] as const, default: "first" },
      mode: { enum: ["synthetic", "trusted"] as const },
      case_sensitive: { type: "boolean", default: true },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["replaced"] as const,
    properties: {
      replaced: { type: "integer", minimum: 0 },   // how many occurrences
      mode: { enum: ["synthetic", "trusted"] as const },
      used_fallback: { type: "boolean" },          // synthetic→value-setter fallback ran
    },
  },
  action_weight: 1,
  risky: "conditional",
  errorCodes: [
    ...BASE_CODES, ...TAB_CODES, ...REF_CODES, ...MUTATING_CODES, ...RISKY_CODES,
    "TEXT_NOT_FOUND",   // substring not present
  ] as const,
} as const;
```

Append `findAndReplace` to the `TOOL_DEFS` array (L986) and update `tools.test.ts` (23 → 24, new name assertion, `risky === "conditional"` assertion).

Commit 1 ships the schema plus a stub handler in `input.ts` that throws `INTERNAL` "not implemented". MCP surface and AJV validation should be green.

### 4b. Extension-side handler: resolve ref, focus, select the substring

Add three new injected helpers in `input.ts`, following the existing "injected functions run in MAIN world, close over nothing" convention (see banner L153–L156).

**Helper 1 — `injectedResolveTarget(selector | null)`**: if `selector` is null, read `document.activeElement`; else `document.querySelector(selector)`. Return a small shape `{ found, kind: "input"|"textarea"|"contenteditable", selectorForReuse }` where `selectorForReuse` is a CSS `[data-browserops-faredit="..."]` attribute we tag onto the element (short-lived) so subsequent executeScript calls in the same operation can re-find it without a ref. This mirrors the refCache pattern but scoped to one tool call; cleanup runs in a `finally` that removes the attribute.

**Helper 2 — `injectedFindRange(opts)`** where opts = `{ selectorForReuse, find, occurrence, case_sensitive }`. Returns `{ found: boolean, count: number, ranges: Array<{start: number, end: number}> }` in a normalized form:
- For `<input>`/`<textarea>`: operate on `.value` string. `indexOf` / `String.prototype.matchAll`-ish walk. Start/end are character offsets.
- For contenteditable: build a flat text-node walker (`TreeWalker` with `NodeFilter.SHOW_TEXT`), concatenate into a single logical string while recording each text node's `[startOffset, endOffset)` within that logical string. Search the logical string; translate each hit back to a pair of `(textNode, offsetWithinNode)` endpoints — a substring hit can span multiple text nodes. The returned shape records both logical offsets and the resolved node pairs, kept inside the MAIN-world closure for the replace step (since DOM nodes can't cross the serialization boundary). We therefore *don't* return the ranges to the service worker — we keep them inside a single MAIN-world function that does both find and replace in one `execInTab` call.

**Helper 3 — one-shot `injectedFindAndReplaceSynthetic(opts)`** where opts = `{ selectorForReuse, find, replace, occurrence, case_sensitive }`. Lives entirely in MAIN world; does not return DOM nodes. Runs the walker, iterates matches (first or all), and for each match:
1. `el.focus()`.
2. For `<input>`/`<textarea>`: set `el.selectionStart`, `el.selectionEnd` to the match offsets. Then dispatch `beforeinput` with `inputType: "insertReplacementText"`, data = `replace`, cancelable = true. If not prevented, use the prototype-descriptor `value` setter (same trick as L317–L322) to splice: `newValue = value.slice(0, start) + replace + value.slice(end)`. Then dispatch `input` event with matching InputEvent. Keep `selectionStart = selectionEnd = start + replace.length` (caret at end of replacement).
3. For contenteditable: build a `Range` from `(startNode, startOffset)` to `(endNode, endOffset)` — the walker already resolved these. `getSelection().removeAllRanges(); selection.addRange(range);`. Dispatch `beforeinput` with `inputType: "insertText"`. If not prevented, call `document.execCommand("insertText", false, replace)`. This collapses the selection and inserts, leaving the caret at the end of the insertion — exactly the behavior we want. If `execCommand` returns `false` (some editors have it disabled), fall back to range manipulation: `range.deleteContents()`, `range.insertNode(document.createTextNode(replace))`, then collapse range to end + dispatch synthetic `input` event.
4. Re-run the walker each iteration in `occurrence: "all"` mode, because the underlying text has mutated and offsets shift. Loop bounded by max-iterations = 1024 to prevent pathological infinite loops when `replace` contains `find`.

Return `{ replaced: N, used_fallback: boolean }`.

**Helper 4 — trusted-mode replace orchestrator (service-worker side)**: for trusted mode, the primitive is CDP `Input.insertText`. Steps per occurrence:
1. Call `injectedFindRange_trusted(opts)` (a helper variant that only resolves + tags the element and computes offsets — no mutation) in MAIN world.
2. For `<input>`/`<textarea>`: call a small injected setter `injectedSelectRange(start, end)` that sets `selectionStart`/`selectionEnd`. Then `cdp.withAttach` + `Input.insertText { text: replace }` — this dispatches an insertText command to the focused field as a trusted input event. Chrome's CDP handles the "replace current selection" semantics when a selection is non-collapsed.
3. For contenteditable: inject a helper `injectedSelectContentEditableRange(offsetPath)` where `offsetPath` encodes the resolved start/end as a pair of text-node descriptors — we re-resolve inside MAIN world because we can't pass Nodes back. Simplest encoding: since we tagged `data-browserops-faredit` on the root, also tag each text node with `data-browserops-faredit-idx="N"` on the nearest element ancestor + offset-within-that-element's-subtree and pass back `{startIdx, startOffset, endIdx, endOffset}`. The injected helper re-walks, finds nodes by their temporary idx. Once selection is set, CDP `Input.insertText` performs the trusted replacement.
4. Loop for `occurrence: "all"` — same re-walk after each mutation.

Cleanup: strip all `data-browserops-faredit*` attributes in a final injected pass, guarded by try/finally in the handler. Also guard against the case where the user navigates mid-operation (handler catches REF_STALE from the helper and surfaces it; the attribute dies with the document).

### 4c. Replacement insertion — recommendation + fallback

**Recommended primary (for rich editors): trusted mode via CDP `Input.insertText` at the resolved selection.**

Why primary:
- Generates `isTrusted: true` input events, which Gmail, Notion, Slate, Lexical, and ProseMirror-based editors all accept without special-casing.
- Reuses the existing `CdpManager.withAttach` path that `browser.type(mode:"trusted")` already uses — no new CDP plumbing.
- Single CDP call per occurrence, so `occurrence: "all"` cost is linear and fast.
- Selection is set via DOM before the CDP call, so we retain precise targeting semantics — CDP just does the insertion at whatever selection the focused document has.

**Default mode choice**: match `browser.type`'s heuristic — default to `synthetic` for short replacements and accept `mode` explicitly. But unlike type, find-and-replace is much more likely to hit rich editors (that's the raison d'être), so document in the tool description that `mode: "trusted"` is the right choice on Gmail / Notion / Slate-based apps, and leave the default as `synthetic`. Consider flipping the default to `trusted` in a v2 once we have telemetry.

**Fallback (synthetic path)**:
1. Dispatch `beforeinput { inputType: "insertReplacementText", data: replace }` on the focused element. This is the modern, correct event — React 18+, Lexical, and ProseMirror listen for it specifically.
2. If not prevented, for `<input>`/`<textarea>` perform the prototype-setter splice + `input` event dispatch (same trick used at L317–L327 in `injectedTypePaste`).
3. For contenteditable, try `document.execCommand("insertText", false, replace)` — this still works on Chrome even though MDN marks it deprecated, and critically it fires a trusted-looking path through the browser's own editing pipeline. The pure-Range fallback (deleteContents + insertNode + manual `input` event) is the last resort.
4. Surface `used_fallback: true` in the response whenever we had to drop below execCommand to the Range-manipulation path — lets callers learn which sites are problematic without having to instrument.

The synthetic path is known to fail on some editors (Notion, Slate) even with `beforeinput`. When it fails (detect via a post-mutation re-read of `.value` or `textContent`: if `replaced` count on re-walk didn't decrease by the number of occurrences we tried to replace, the write didn't stick), return a clear error `INTERNAL` with a message telling the caller to retry with `mode: "trusted"`.

### 4d. `occurrence: "all"` loop

Implemented inside the injected helper (synthetic) or the service-worker orchestrator (trusted). Loop cap at 1024 with a safety counter; on each iteration we re-search from the beginning of the logical string to handle overlap correctly (e.g. replacing `"aa"` with `"a"` in `"aaa"` should not loop). If `replace` contains `find` (e.g. find=`"foo"`, replace=`"foobar"`), we advance the search cursor to `matchStart + replace.length` after each replacement so we don't re-match inside our own insertion. This matches the `String.replaceAll` semantics callers expect.

Caret restoration in `all` mode: caret lands at end of the last replacement. Document this in the tool description.

### 4e. Tests

Unit tests live alongside the shared catalogue; the handler itself is end-to-end and runs in a real Chrome (no jsdom — the walker and InputEvent semantics are browser-specific). So:

- `packages/shared/src/tools.test.ts`: add schema-shape tests (required fields, enum values, risky classification, error-code inclusion).
- `packages/bridge/src/safety.test.ts` (create if missing — the file `risky-domains.test.ts` is the precedent): unit test for `checkRisky({tool: "browser.find_and_replace", ...})` classification on a sensitive vs non-sensitive URL.
- Manual test matrix (document in `plans/08-testing.md`):
  1. Plain `<textarea>` on `example.com` — replace substring in the middle, verify caret at end.
  2. `<input type="text">` — same.
  3. Gmail compose body (contenteditable `<div>`) — fix "Prathmesh" → "Prathamesh". Run both `synthetic` and `trusted` modes; expect `trusted` to work reliably, `synthetic` to work on recent Gmail builds.
  4. Substring spanning multiple text nodes in Gmail (e.g. bold word in middle of paragraph — the `<b>` creates a node boundary). Verify find locates across boundary and replacement collapses to plain text under the common ancestor.
  5. `occurrence: "all"` on a `<textarea>` with three copies of the find string.
  6. ref-omitted case with `document.activeElement` (after a `browser.click` on the field).
  7. No-match case returns `TEXT_NOT_FOUND`.
  8. `replace` contains `find` — verify no infinite loop, exactly N replacements.

## 5. Sequencing (commit-per-step)

Run `pnpm -r typecheck && pnpm -r test` between every step. No Claude attribution.

1. **Schema + catalogue.** Add `findAndReplace` ToolDef in `shared/src/tools.ts`, wire into `TOOL_DEFS`. Update `tools.test.ts` count and name/risky assertions. Commit.
2. **Bridge risky-gate + safety.** Extend `safety.ts` `checkRisky` to classify the new tool on sensitive domains. Unit test. Commit.
3. **Extension stub handler.** Register `browser.find_and_replace` in `registerInputHandlers` returning an `INTERNAL` "not implemented" error. Confirms MCP surface end-to-end; AJV validation works. Commit.
4. **Synthetic path, `<input>`/`<textarea>` only.** Implement `injectedFindAndReplaceSynthetic` for the native-input branch (prototype-setter splice). `occurrence: "first"` only. Manual test against a textarea. Commit.
5. **Synthetic path, contenteditable.** Add the text-node walker and the execCommand path + Range-manipulation fallback. `occurrence: "first"`. Manual test against Gmail compose. Commit.
6. **`occurrence: "all"` loop.** Add the loop cap and the advance-past-replacement cursor logic. Commit.
7. **Trusted path.** Implement the CDP `Input.insertText` orchestrator, selection-setting injected helpers, data-attribute tagging scheme for contenteditable text-node re-resolution. Commit.
8. **Cleanup + error polish.** `try/finally` to strip `data-browserops-faredit*` attributes. `TEXT_NOT_FOUND` wired for no-match. Update `plans/04-tools.md` docs. Commit.
9. **SERVER_INSTRUCTIONS mention + final tests.** One-line update to the operator-tools list in `mcp-server.ts`. Round out manual test matrix. Commit.

## 6. Risks / tradeoffs

**Contenteditable text spans multiple nodes.** The core difficulty. Mitigation: the flat-map TreeWalker builds a logical-string view that makes `indexOf`/`matchAll` trivial, and we translate matches back to `(startNode, startOffset, endNode, endOffset)` pairs. Cross-node replacement collapses to a single text node under the common ancestor (that's just what `execCommand("insertText")` and `range.insertNode(document.createTextNode(...))` do). Formatting inside the find substring is lost by design — callers who want to preserve formatting should use a higher-level edit. Document this in the tool description.

**Editors that intercept `beforeinput` (Notion, Slate, ProseMirror, Lexical).** These may call `preventDefault()` on our synthetic `beforeinput` and then expect the framework's own model update to drive the DOM. In that case:
- Synthetic path is ignored — our splice doesn't stick. We detect via post-op re-walk and surface an `INTERNAL` error suggesting `mode: "trusted"`.
- Trusted path: CDP `Input.insertText` goes through Blink's editing pipeline, which fires a trusted `beforeinput`+`input` sequence that these editors *do* process correctly. So trusted mode should work on all four. Document this and default users toward it on problematic sites.

**`document.execCommand` is deprecated.** It still works in all target browsers (Chrome 120+, per the comment at input.ts L426–L427) and is explicitly what the existing `injectedTypePaste` + `injectedTypeKeystroke` rely on. Accepting the same risk profile as the existing code. If Chrome ever removes it, the Range-manipulation fallback already covers the synthetic contenteditable path, and trusted mode (our recommended primary) doesn't use `execCommand` at all.

**Caret/selection restoration.** Default: caret at end of replacement (`selectionStart = selectionEnd = matchStart + replace.length`). For `occurrence: "all"`, caret at end of the *last* replacement. Both synthetic and trusted paths produce this naturally (CDP `Input.insertText` collapses selection to end; so does `execCommand("insertText")`). No extra work needed.

**IME / composition events.** Out of scope for v1. Don't fire `compositionstart`/`compositionend`; don't handle the case where the user has an active IME composition when the tool fires. Document the limitation and surface `INTERNAL` if we detect `isComposing: true` at focus time (optional — can defer to v2).

**Security / risky-action gate.** This is "programmatic text replacement in an already-editable field the page has given focus". Threat model is identical to `browser.type`: we're modifying an input value the user has (transitively) authorized by focusing the field and invoking the MCP. Recommendation: classify `risky: "conditional"` identical to `browser.type` — risky only when on a sensitive domain. Do **not** classify as "always risky" like `execute_js`, because there's no code-execution surface. Do not require `safety_prompt` on non-sensitive domains because that would be more restrictive than `type` without good reason.

**Debugger-attach UX.** `mode: "trusted"` attaches `chrome.debugger`, which flashes the "Chrome is being controlled by automated test software" banner briefly. Same tradeoff already accepted for `type(mode:"trusted")`. Keep default `mode: "synthetic"` so non-problematic sites don't pay that UX cost.

**Long `find`/`replace`.** `find` capped at 4096 chars (reasonable substring length), `replace` capped at 32768 (matches `typeTool`'s `maxLength` at L669). Prevents accidental megabyte payloads.

**Pathological `replace` containing `find`.** Loop cap of 1024 + cursor-advance-past-replacement. Tested explicitly.

## 7. Open questions

1. **Default mode:** stick with `synthetic` default for parity with `browser.type`, or flip to `trusted` because find_and_replace's target audience is rich editors where synthetic often fails? Suggest `synthetic` default for v1, revisit after use.
2. **Return shape:** should we include the replaced-substring location (offsets, or an xpath) for diagnostics? Useful for debugging but adds complexity. Defer to v2 unless first-week users ask.
3. **Regex support?** Tool spec is explicitly substring. A `regex: boolean` flag would be natural but doubles the test matrix. Defer to a separate v2 tool `browser.find_and_replace_regex` if demand exists.
4. **Case-insensitive find:** included as `case_sensitive?: boolean` defaulting to `true`. Consistent with `browser.click_by_text`.
5. **Should the tool return `navigated: true`** when the replacement triggers a form submission via a content-script listener? Probably no — that's noise; document that the caller should `describe_ref` or `wait_for_idle` after.

### Critical Files for Implementation

- `packages/shared/src/tools.ts`
- `packages/extension/src/background/handlers/input.ts`
- `packages/bridge/src/safety.ts`
- `packages/bridge/src/mcp-server.ts`
- `packages/shared/src/tools.test.ts`
