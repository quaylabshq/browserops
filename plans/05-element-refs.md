# 05 — Element Refs (Addressing System)

> How `browser.read(mode: "a11y_tree")` numbers every interactable node on a page, how Claude uses those integers, and how subsequent `browser.click(ref)` / `browser.type(ref, text)` calls dereference them back to live DOM elements. Getting this right is load-bearing: brittle refs will dominate v1 failure modes.

---

## 1. Scope

This plan specifies the a11y-tree snapshot algorithm, the ref numbering scheme, the per-tab snapshot store, the ref→element resolution path, and the staleness model. It is the single source of truth for what a "ref" is in the browserops system.

**Out of scope:** the MCP tool signatures themselves (see `04-tools.md`), the WebSocket envelope (see `00-overview.md` §4.2), the extension's general architecture (see `03-extension.md`), and the safety/risky-action layer (see `06-autonomy-safety.md`). This plan describes the *mechanism*; the tools plan describes the *surface*.

---

## 2. Inputs from other plans

- **`00-overview.md` §4.1** — ref is `integer ≥ 0`, stable within one snapshot, invalidated on the next `read`.
- **`00-overview.md` §4.3** — error codes `REF_STALE`, `REF_NOT_FOUND`, `CDP_ATTACH_FAILED`, `NAVIGATION_IN_PROGRESS`, `FRAME_UNREACHABLE`.
- **`00-overview.md` §4.2** — WebSocket request/response envelope; this plan does not extend it.
- **`03-extension.md`** — the extension's service worker owns the snapshot store; this plan prescribes the shape but not the lifecycle wiring.
- **`04-tools.md`** — supplies `browser.read`, `browser.click`, `browser.type`, and `browser.wait_for` signatures; this plan fills in their semantics w.r.t. refs.
- **`06-autonomy-safety.md`** — password-field detection piggy-backs on the a11y tree annotation produced here (`is_password: true`).

---

## 3. Outputs to other plans

- The rendered a11y-tree string format (§4.4). Consumed by `01-mcp-server.md` (how `read` results are returned) and used by Claude verbatim.
- The per-tab snapshot record type `Snapshot` (§4.6). Consumed by `03-extension.md`'s service worker memory model.
- Emission of `REF_STALE` / `REF_NOT_FOUND` (§4.8). Consumed by bridge error-mapping and by `04-tools.md` tool docs.
- The `page_navigated` event is **consumed** here (snapshot invalidation trigger) but **emitted** by `03-extension.md`.
- `is_password`, `is_cross_origin_iframe`, and `is_contenteditable` flags on tree nodes. Consumed by `06-autonomy-safety.md`.

---

## 4. Design

### 4.1 Data source — why a11y, not DOM

Chrome's accessibility tree is the right substrate because it:

1. **Flags non-interactive / hidden nodes as `ignored`.** AT-SPI-style computation marks `display:none`, `visibility:hidden`, `aria-hidden="true"`, and nodes with no accessible name/role/interactivity with `ignored: true`. Note: `Accessibility.getFullAXTree` still returns these nodes in the response — it does **not** strip them. Our `ignored` filter in §4.2 is the step that actually prunes them, so it is load-bearing (not defense in depth).
2. **Computes names properly.** `aria-labelledby`, `aria-label`, `<label for>`, `alt`, `title`, nearest text — all normalized into one `name` string. Re-implementing this in a content script is a tarpit.
3. **Gives us roles.** `button`, `link`, `textbox`, `combobox`, `checkbox`, etc. — lets Claude reason about affordances without pattern-matching tag names.
4. **Has stable backend ids.** Each AX node carries a `backendNodeId` that survives JS-driven DOM churn better than CSS selectors.

**Primary source:** `chrome.debugger` attached to the target tab, CDP `Accessibility.getFullAXTree` (called once for the main frame, then once per same-origin child frame with a `frameId` parameter — see §4.3).

**Fallback source:** content-script DOM walk (`packages/extension/src/content/domWalk.ts`) when CDP attach fails. CDP attach fails for:
- `chrome://` and `chrome-extension://` pages — these can't be driven meaningfully anyway; the read surfaces `CDP_ATTACH_FAILED` and the DOM walk is never invoked for them in v1.
- Devtools is already open on that tab by the user — then CDP is occupied; the DOM walk is the graceful fallback.
- Another extension holds the debugger — same as above.

The DOM-walk fallback produces the same tree shape but with lower-quality names (it only reads `aria-label`, `alt`, visible text ≤ 120 chars) and no `backendNodeId`. Refs from the fallback resolve via CSS selector only.

### 4.2 Pruning rules

Walk the raw AX tree and keep a node if **any** of:

- It has an **interactive role**: `button`, `link`, `textbox`, `searchbox`, `combobox`, `listbox`, `option`, `checkbox`, `radio`, `switch`, `slider`, `spinbutton`, `tab`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `treeitem`.
- It has a **landmark / structural role** useful for orientation: `banner`, `navigation`, `main`, `complementary`, `contentinfo`, `region`, `form`, `search`, `heading`, `dialog`, `alertdialog`, `tablist`, `tabpanel`.
- It has a **non-empty accessible name AND** at least one kept descendant (text-carrying container).
- It is an `iframe`, regardless of traversability.

Drop a node if:

- `ignored: true` in the AX tree (Chrome flagged it; this filter is load-bearing — `getFullAXTree` returns ignored nodes intact, so we must drop them here).
- Its bounding box is entirely outside `viewport ∪ 1.5×viewport margin` on all four sides. Checked via `DOM.getBoxModel`. Keep the node if the box is unavailable (JIT-rendered, zero-size flex, etc.) — safer to over-include.
- It is `aria-hidden="true"` and has no focusable descendant (AX tree already drops most of these; defense in depth).
- Role is `presentation` / `none` **and** it has no interactive descendant.
- The node is a pure text leaf under an already-kept container (the container's `name` absorbs it).

A kept node whose only kept descendants are other kept nodes **is still kept** — landmark scaffolding is what lets Claude say "click the Sign in button in the main region" accurately.

### 4.3 Same-origin iframes, cross-origin iframes, shadow DOM

- **Same-origin iframes.** Enumerate child frames via `Page.getFrameTree`, then call `Accessibility.getFullAXTree({ frameId })` once per same-origin child frame. (Recent Chrome added the `frameId` parameter; we no longer need `Accessibility.getPartialAXTree` for this.) Render inline with the parent tree; do **not** start a new numbering — refs are per-tab, not per-frame. Prefix iframe subtrees with `[N] iframe (same-origin, /path/to/src)`.
- **Cross-origin iframes.** Cannot traverse (Chrome AX tree is per-origin; cross-origin frames are opaque leaves). Render as a single leaf `[N] iframe (cross-origin, not traversable, src: https://…)`. The ref is still valid and resolvable — `click(ref)` will click *the iframe element itself* (focus it, useful for OAuth pop-ins). `type(ref, …)` on a cross-origin iframe ref returns a descriptive `FRAME_UNREACHABLE` error.
- **Shadow DOM — open roots.** Pierce automatically. CDP's `Accessibility.getFullAXTree` already crosses open shadow boundaries; the DOM-walk fallback uses `element.shadowRoot` when present.
- **Shadow DOM — closed roots.** Do not attempt to pierce. The shadow host itself is rendered as a normal node; its interior is opaque. This is a known gap (see §5) but v1 accepts it — most major web apps use open shadow roots or avoid shadow DOM entirely in their interactive surfaces.

### 4.4 Flattening, numbering, and rendering

Walk the pruned tree depth-first. Assign integer refs starting at **1** (not 0 — 0 is reserved as "no ref"). This matches overview §4.1. Every kept node gets a ref, including landmarks and headings. Claude needs to be able to say "scroll to ref 42" even if 42 is a heading.

Render as an indented text tree, two spaces per depth level. Per-node format:

```
[<ref>] <role> "<name>" (<key=value attrs>)
```

Where:
- `<role>` — AX role verbatim. Lowercase.
- `<name>` — normalized accessible name, JSON-escaped, truncated to 120 chars with `…` suffix. Elide entirely if empty.
- `<attrs>` — a compact, stable subset: `url` for links (path + query, host elided if same-origin), `required`, `disabled`, `checked`, `expanded`, `selected`, `placeholder` (truncated to 40 chars), `value` for non-password textboxes truncated to 40 chars. Password field values are **never** serialized — only `is_password: true`.

Example:

```
[1] banner
  [2] link "Home" (url: /)
  [3] button "Menu" (expanded: false)
[4] main
  [5] heading "Welcome" (level: 1)
  [6] textbox "Email" (required, placeholder: "you@example.com")
  [7] textbox "Password" (is_password, required)
  [8] button "Sign in"
  [9] iframe (cross-origin, not traversable, src: https://recaptcha.net/…)
```

The full `result` returned by `browser.read` is:

```ts
{
  tab_id: "t_17",
  url: "https://…",
  title: "…",
  snapshot_id: "s_<uuid>",   // opaque, echoed back only for debugging
  tree: "[1] banner\n  [2] link …",
  ref_count: 47,
  truncated: false            // true if we hit the 500-ref cap (§4.5)
}
```

### 4.4.1 Compression modes (`verbose`)

`browser.read(mode: "a11y_tree")` accepts an optional `verbose: boolean` param, defaulting to `false`:

- **`verbose: false` (default).** The walker applies a pre-pass that marks only elements that already pass today's eligibility gate (`shouldKeep` + `canEmit`) **and** additionally have an accessible name, a core interactive role (`button`, `link`, `textbox`, `combobox`, `checkbox`, `radio`, `menuitem`, `tab`), or an eligible descendant. The main DFS then emits only marked elements. Ref numbers remain sequential in DFS pre-order over the surviving set.
- **`verbose: true`.** Legacy behavior: every element that passes `shouldKeep && canEmit` is emitted, including name-less `generic` wrappers. Use when debugging page structure or capturing a full snapshot for test fixtures.

Every node that survives the compact filter would also have been emitted in verbose mode, so the non-verbose tree is a strict subset of the legacy tree; downstream `click(ref)` / `type(ref)` / `describe_ref` calls made against a compact tree resolve against the same snapshot they were read from. Refs are not stable across a `verbose: true` → `verbose: false` transition within a tab; the latest `browser.read` always wins.

### 4.5 Size budget

Cap at **500 refs per snapshot**. Rationale:

- A 500-ref tree renders to roughly 15–25 KB of text — comfortably under Claude's per-tool-call attention budget while still covering most real pages.
- Pages with > 500 meaningful interactables (infinite feeds, giant data tables) are better served by Claude re-reading a scrolled viewport than by a monster tree.

When the cap is hit, stop the DFS at the 500th kept node, set `truncated: true`, and append a line `… (truncated at 500 refs; call browser.scroll then browser.read to see more)`. Do **not** try to "pick the most important" 500 — DFS-order truncation is predictable and lets Claude reason about what it's missing.

### 4.6 Ref → element resolution

Per tab, the service worker keeps:

```ts
type SnapshotEntry = {
  ref: number;
  backendNodeId?: number;     // from CDP; absent in DOM-walk fallback
  axNodeId?: string;          // CDP AX id, for re-querying
  frameId?: string;           // for iframe-scoped resolution
  cssSelector: string;        // always populated (fallback path)
  role: string;
  name: string;
  isPassword: boolean;
  isContenteditable: boolean;
  isCrossOriginIframe: boolean;
};

type Snapshot = {
  id: string;                 // "s_<uuid>"
  tabId: string;              // browserops tab_id, not chrome tabId
  chromeTabId: number;
  createdAt: number;          // epoch ms
  navigationId: number;       // chrome tabs' navigation counter at capture
  mutationSeq: number;        // mutation-observer tick at capture
  entries: Map<number, SnapshotEntry>;
  truncated: boolean;
};
```

Storage: primary copy in an in-memory `Map<tabId, Snapshot>` on the service worker. Mirror to `chrome.storage.session` keyed by tab id on every write, so a service-worker restart (MV3 terminates idle workers aggressively) doesn't nuke refs. On worker wake, rehydrate lazily on first ref resolution.

**`browser.click(tab_id, ref)` resolution order:**

1. Look up `SnapshotEntry` for `(tab_id, ref)`. Miss → `REF_NOT_FOUND` (ref never existed) or `REF_STALE` (snapshot invalidated; see §4.7).
2. Guard: check `mutationSeq` against current observer tick. If it has advanced by more than a threshold (propose **50 mutations** or **3 s**, whichever comes first), do not mark stale but **re-resolve the node** by re-querying the AX tree for `axNodeId` and confirming the `backendNodeId` still matches. If confirmation fails → `REF_STALE`.
3. Primary: call `DOM.getBoxModel({ backendNodeId })` directly — it returns the element's quad without needing a RemoteObject. Compute the center of the content quad, then `Input.dispatchMouseEvent` (`mouseMoved` → `mousePressed` → `mouseReleased`) at that point. This produces a **trusted** event — critical for login flows, form handlers that check `event.isTrusted`, and framework synthetic-event guards. `DOM.resolveNode` is **not** on the click path; it is only needed when we want to invoke a method on the element object (e.g. `.scrollIntoView()`), which is a separate code path.
4. Fallback (only if CDP unavailable — DOM-walk snapshot): content-script `document.querySelector(cssSelector).click()`. Non-trusted, but works for most static sites.
5. Post-check: within 200 ms, observe for either a `DOM.childNodeCountUpdated`, a focus change, or a URL change. If none, return success with a `soft_no_effect` warning flag in the result — Claude can decide whether to retry.

**`browser.type(tab_id, ref, text)`:**

1. Same lookup + staleness guard as click.
2. **Default typing path (textbox / searchbox / spinbutton / plain inputs):** CDP `DOM.focus` → for each character, `Input.dispatchKeyEvent` with a full `keyDown` → `keyPress` (for printable chars) → `keyUp` sequence. This fires real `keydown` / `keypress` / `keyup` events on the page, so autocomplete widgets, submit-on-Enter handlers, form-validation-on-keyup logic, and hotkey listeners all observe input as they would from a human typist. This is a **deliberate divergence from Playwright's `page.fill()`** (which uses `Input.insertText` and bypasses key events) — `page.fill` is faster but silently breaks inputs that listen for keydown, which is a failure mode we cannot accept as the default.
3. **Contenteditable fallback (`isContenteditable`) only:** CDP `Input.insertText` after focus. This is reserved for rich-text editors (Google Docs, Notion, contenteditable surfaces) that expect IME-style composition input and don't drive their model from key events. Do not clear first unless `clear: true` is passed.
4. `Input.insertText` is **not** used for plain `<input>` / `<textarea>` elements under any circumstance — it only fires input/composition events, not keydown/keyup, and would silently break any page that listens for key events on its inputs.
5. If `isPassword`: follows the default per-character path, but the risky-action gate (`06-autonomy-safety.md`) runs first.
6. If the target is a cross-origin iframe: return `FRAME_UNREACHABLE` with message `"cannot type into cross-origin iframe"`.

**CSS selector construction** (used as fallback + storage):

- If the element has a stable `id` matching `^[a-zA-Z_-][\w-]*$`: `#id`.
- Else walk up to 5 ancestors, building `tag[attr]:nth-of-type(n)` chains. Prefer attributes from the allowlist `[data-testid, data-test, name, type, role, aria-label]`; skip `class` unless nothing else discriminates (BEM-ish classes are fine; tailwind-noise classes are not — detect by length & count).
- Final selector is validated against the live DOM at snapshot time; if it doesn't uniquely match, fall back to XPath-by-position and store that instead (prefixed `xpath=`). This is the one place XPath lives in the system.

### 4.7 Staleness

A snapshot for tab `T` is invalidated when **any** of:

- The extension receives a `chrome.webNavigation.onCommitted` event for `T` (new document, new navigation id). Also emits `page_navigated`.
- A new `browser.read` call completes on `T` (the new snapshot replaces the old; the old entries are dropped).
- `Date.now() - createdAt > 5 * 60 * 1000` (5 minutes). A timer in the service worker sweeps expired snapshots every 60 s.
- The tab is closed.
- Mutation re-resolution (§4.6 step 2) fails.

On invalidation, the entry is **deleted** from both the in-memory map and `chrome.storage.session`. Future `click`/`type` calls referencing it return:

- `REF_STALE` — if `ref` is within a valid-looking range for a recently-existed snapshot (heuristic: ref ≤ last-known `ref_count` for that tab, kept around as a tombstone for 10 min).
- `REF_NOT_FOUND` — otherwise.

Claude's recovery path, documented in the `browser.read` tool description (see `04-tools.md`): on `REF_STALE`, call `browser.read` again and re-issue the action with the new ref.

### 4.8 Error surface (restated, no new codes)

| Situation | Code |
|---|---|
| Ref in current snapshot, resolves, succeeds | `ok: true` |
| Ref in current snapshot, element since removed from DOM | `REF_STALE` |
| Ref within tombstone range, snapshot invalidated | `REF_STALE` |
| Ref never plausibly issued for this tab | `REF_NOT_FOUND` |
| CDP attach rejected | `CDP_ATTACH_FAILED` |
| Tab navigating during read | `NAVIGATION_IN_PROGRESS` |
| Cross-origin iframe + `type` | `FRAME_UNREACHABLE` with descriptive message |

No new codes are introduced by this plan (`FRAME_UNREACHABLE` is defined in overview §4.3).

### 4.9 Alternatives considered

- **Pure CSS selectors handed to Claude.** Claude produces `#signin-btn` itself. Rejected: brittle (class-name churn, duplicate ids, frameworks hashing attribute names), token-expensive (Claude has to regenerate selectors on every call), and impossible to sanity-check server-side.
- **XPath.** Same brittleness problems as CSS, plus worse Claude fluency with the syntax. Kept only as a last-resort fallback when CSS doesn't uniquely match.
- **Pure coordinates + vision.** Screenshot → Claude picks (x, y). Rejected: every action costs a vision-capable screenshot round-trip (tokens, latency), and coords are viewport-relative (scrolling breaks them). Useful as a *supplement* for canvas-heavy pages (maps, editors), not as the primary surface.
- **Playwright-style text locators** (`getByRole("button", { name: "Sign in" })`). Rejected as the *primary* surface because ambiguity resolution (two "Continue" buttons) forces Claude to disambiguate with qualifiers every call — brittle on dynamic pages. We do render role+name in the tree so Claude *sees* them, and we expose a `browser.find` tool (see `04-tools.md`) as sugar over the a11y tree for Claude's convenience, but the underlying address remains the integer ref.

Integer refs over an a11y snapshot is the sweet spot: compact, stable within a call window, semantically rich enough for Claude to reason about, and resolvable server-side without re-running LLM-sized heuristics.

---

## 5. Risks & mitigations

1. **Ref brittleness on dynamic pages.** Single-page apps mutate the DOM constantly; a ref captured at t=0 may point to a detached node at t=500ms.
   *Mitigation:* mutation-sequence re-resolution guard (§4.6 step 2), trusted-event verification (post-action DOM-change sniff), documented Claude recovery loop (`REF_STALE` → `read` → retry). Accept that pathological pages will require `read`-per-action; rate limiter (16/min) keeps the cost bounded.

2. **Shadow DOM (closed roots) and web components.** Closed shadow roots are opaque to both CDP and content scripts. A "button" rendered inside `mode: "closed"` shadow DOM is invisible.
   *Mitigation:* pierce open roots by default; for closed roots, surface the shadow host as a leaf so Claude can at least click it; document the gap in tool descriptions. v2 can add a targeted `execute_js` escape hatch with risky-action confirmation.

3. **AX tree lag on slow JS frameworks.** React/Angular can finish committing the DOM before the accessibility tree is updated; a `read` issued during the gap yields a stale tree.
   *Mitigation:* before `getFullAXTree`, await `Page.lifecycleEvent: "networkAlmostIdle"` **or** a 250 ms quiet window on `DOM.childNodeCountUpdated`, whichever fires first. Cap at 2 s so we don't hang on never-idle pages.

4. **Service worker eviction loses snapshots.** MV3 kills idle workers after ~30 s; in-memory `Map` vanishes.
   *Mitigation:* mirror every snapshot write to `chrome.storage.session`. On worker wake, rehydrate lazily. Staleness model (§4.7) is unchanged — wake-up doesn't refresh timestamps.

5. **Ref collisions across snapshots confuse Claude.** Claude sees `[7] button "Sign in"` now, calls `click(7)` 10 s later after the page mutated; ref 7 is now a different element.
   *Mitigation:* snapshot invalidation on any navigation; mutation-sequence re-resolution catches in-page churn; tombstone + `REF_STALE` catches the narrow window where the old snapshot is gone but Claude hasn't re-`read`. Claude's system prompt (see `04-tools.md`) tells it that refs are per-snapshot.

6. **CSS-selector fallback matches the wrong element after DOM churn.** The recorded `#nth-of-type` chain points to a sibling.
   *Mitigation:* fallback only runs when CDP is unavailable (rare). When it does run, we re-verify by comparing the matched node's AX role+name against the stored entry; mismatch → `REF_STALE` rather than silently clicking the wrong thing.

---

## 6. Open questions

- **Threshold tuning.** The "50 mutations or 3 s" re-resolve trigger and the "250 ms DOM-quiet" pre-read wait are guesses. Needs empirical tuning against a corpus (Gmail, Google Docs, GitHub, Linear, Amazon checkout). Defer to `08-testing.md`.
- **Heading levels in the rendered tree.** Currently proposing `(level: 1)` for headings. Worth it, or noise? Claude can usually infer from indentation.
- **Should `select` / `<option>` elements expose both the select ref and the per-option ref?** Proposal: yes, both, and `click(option_ref)` does the right thing. Confirm with tool plan.
- **`browser.find` tool surface.** Mentioned in §4.9 as sugar over the tree. Is it redundant given that Claude already has the full tree? Defer to `04-tools.md`.
- **DOM-walk fallback parity.** How closely does it need to match the CDP output? v1 proposal: "good enough to click links and fill visible inputs"; don't try to match role computation.

---

## 7. Acceptance checklist

- [ ] `browser.read(mode: "a11y_tree")` on a representative corpus (google.com, github.com, gmail.com inbox, a Linear issue, amazon product page) returns a tree of ≤ 500 refs in ≤ 2 s p95.
- [ ] Every returned ref resolves via `browser.click` within the same snapshot window (no churn) with 100 % success on the corpus.
- [ ] `REF_STALE` is returned (never a wrong-element click) when the snapshot is invalidated by navigation, by a fresh `read`, by 5-min timeout, or by DOM-mutation re-resolution failure.
- [ ] Password inputs appear in the tree with `is_password` and *never* leak their current value in the serialized tree.
- [ ] Cross-origin iframes render as single leaves with a clear `(cross-origin, not traversable)` annotation; their refs are clickable but not typeable.
- [ ] Same-origin iframes are rendered inline with parent tree; refs across the frame boundary share the same numbering.
- [ ] Open shadow DOM is pierced; closed shadow DOM surfaces the host as a leaf with no interior children.
- [ ] Snapshots survive a service-worker restart (forced via `chrome://serviceworker-internals`) without losing refs.
- [ ] CDP input dispatch produces `event.isTrusted === true` on a synthetic test page.
- [ ] DOM-walk fallback path is reachable (devtools-open scenario) and clicks/types succeed for simple `<a>` / `<input type="text">` / `<button>`.
- [ ] Truncation at 500 refs sets `truncated: true` and appends the advisory line; `browser.scroll` + `browser.read` surfaces refs not in the first snapshot.
- [ ] Rate limiter (from `06-autonomy-safety.md`) accounts `read` as 0.5 actions so a read-retry loop on a dynamic page degrades gracefully rather than hitting the 16/min cap in seconds.
