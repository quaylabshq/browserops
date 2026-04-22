# Browserops MCP — Session Retrospective

Grounded in what actually broke during this session (a Flipkart order attempt + a Gmail draft/send). Every item below maps to a real failure, not a hypothetical.

**Guiding principle:** browserops is and should stay a **generic browser-automation MCP**. The fixes below are all about making it work on *any* site that uses modern React / role-less DOM / contenteditable — not about adding site-specific adapters. If a tool only helps on one vendor, it doesn't belong in browserops.

> **Status note (updated after subsequent shipping session):**
> A follow-up session implemented a large portion of the fixes below. Items that were shipped verbatim have been **removed** from this document. Items that were shipped in a different shape have been **kept with an inline note** describing the actual implementation, so the reader can use the new tool instead of reinventing the proposed one. Items still open are **kept as-is**.
>
> Shipped in the follow-up (reference, so you can see what's already there): `browser.click_by_text`, `browser.click_at`, `browser.pinned_tab` (popup "Use this tab"), `browser.describe_ref`, `browser.wait_for_idle`, `browser.wait_for` text/ref modes, `mode: "keystroke" | "paste" | "trusted"` on `browser.type`, `mode: "synthetic" | "trusted"` on `browser.click`, opt-in `dismiss_overlay` on `browser.click`, `safety_prompt` popup approval flow, `--yolo` CLI flag, popup "auto-approve this session" toggle, a11y walker now surfaces role-less `<div>` click-handlers (cursor:pointer or `onclick`).

---

## 1. What would have let me complete the task end-to-end

> **1a (click-by-text) and 1e (wait_for text/ref modes) are shipped as described — removed from this list.**

### 1b. Icon-only / coord-based click fallback

> **Shipped as `browser.click_at { tab_id, x, y, mode, button, modifiers }`** (not `browser_click_by_coords`). Supports `mode: "synthetic" | "trusted"`; use trusted when the synthetic dispatch is ignored by the page. Combined with `browser.screenshot` this covers the icon-only case.

**Original note, kept for context**
- Even with text-click, some elements are icon-only (hamburger, close-X on chips). Screenshots show them visually but they don't have text or ARIA. `click_at` is the escape hatch.

---

### 1c. Approvable `browser_execute_js` — shipped

> **Shipped as a three-layer approval path:**
> 1. By default, every risky invocation (execute_js and click/type on sensitive domains) sends a `safety_prompt` request to the extension. The popup renders an Allow/Deny panel with the tool name and reason; decision flows back through `chrome.runtime.sendMessage`.
> 2. Session-wide approval: popup checkbox "Auto-approve risky actions (this session)". Flag lives in `chrome.storage.session`, badge flips to red `YOLO` while active, cleared on browser restart or Disconnect.
> 3. CLI-level auto-approve: start the bridge with `--yolo` (or `BROWSEROPS_AUTOCONFIRM=1`). Short-circuits before the prompt ever leaves the bridge.
>
> Nothing in `.claude/settings.local.json` — browserops handles it in-product.

---

### 1d. `browser_find_and_replace` — still open

> **Not shipped as its own tool.** But the original Cmd+A failure is partially mitigated: `browser.type` now exposes `mode: "trusted"` (CDP-backed real trusted keystrokes) and `clear_first: true`. In trusted mode, `clear_first` sends a real Ctrl/Cmd+A followed by Delete via `Input.dispatchKeyEvent`, which Gmail's contenteditable does respect. So the workflow is `type(ref, text, mode: "trusted", clear_first: true)` — one call, proper select-all + replace. A dedicated `find_and_replace` (substring targeting without clearing the whole field) would still be a win; keeping this item open for that narrower case.

**Original note, kept for context**
- The compose body had "Hey Prathmesh" (misspelled). I tried `Cmd+A` + `Delete` + retype — but `Meta+KeyA` didn't select on Gmail's contenteditable `<div>`. My retype appended to the existing body, creating a **duplicate body**.

---

### 1f. Selector-state lookup — partially shipped

> **Shipped as `browser.describe_ref { tab_id, ref }`.** Returns `{ role, name, tag, visible, disabled, focused, checked, value, attrs, aria, rect }` for an existing ref. Fixes the "is the button enabled yet?" / "did my input land?" / "is the click a no-op because the field is still uncommitted?" questions without a full a11y re-read.
>
> **What's still missing:** describe_ref is ref-based, not CSS-selector-based. You can't `browser_query_selector(tab_id, ".price")` to find an element the a11y walker never emitted a ref for. For that, `browser.click_by_text` covers the interactive case; a read-only `browser.query_selector` (returning the same shape as describe_ref but keyed on a CSS selector) would be the next increment. Keeping this item open for that.

**Original note, kept for context**
- Refs showed up for non-visible elements, leading to wasted clicks (the "Discard draft" click that timed out because the button was off-screen / z-indexed under an overlay). `describe_ref.visible` now catches this before the click.

---

## 2. What would have drastically reduced token cost

> **None of 2a–2f is shipped yet.** These are all still open. Adjacent progress: `browser.describe_ref` and `browser.wait_for_idle` now let you avoid some of the "re-read the whole page to check one thing" pattern, but the section-2 items are the main remaining token lever.

The four biggest token drains this session:

### 2a. **Chunked / paginated `browser_read` output**

**Observation:** Flipkart PDP `sanitized_html` returned **~119k chars** → hit max-token cap → saved to a file → I had to shell out to `jq`/`python` to extract. Every read of a PDP was a detour through the filesystem.

**Fix:** let `browser_read` take `start` + `length` (byte offsets) OR a CSS selector scope:
```
browser_read(tab_id, mode, selector="main", start=0, length=20000)
```
Fetch only what you need. No need for filesystem round-trips.

---

### 2b. **A11y tree compression — drop generic nodes by default**

**Observation:** Every Flipkart and Gmail a11y read returned 30–80% `[N] generic` nodes with empty names. These consumed thousands of tokens per read and were **never clickable**.

**Fix:** default `verbose=false`. Return only nodes with a name, a role in `{button,link,textbox,combobox,checkbox,radio,menuitem,tab}`, OR children of same. Drop `generic` entirely unless `verbose=true`.

Estimated savings: **60–80% fewer tokens per page read.**

---

### 2c. **Screenshot: default to aggressively downscaled + low JPEG quality**

**Observation:** Every `browser_screenshot` returned **150–260k chars** of base64 at 1377×971. LLMs don't need that much resolution — they can read UI text, icons, and layout from a much smaller image. The token cost came from unnecessary fidelity, not from the screenshot being useful.

**Fix:** change `browser_screenshot` defaults to:
- `max_dimension: 1024` (longest edge, preserves aspect ratio — fits laptop-UI density without losing legibility)
- `quality: 40` (JPEG; still perfectly readable for UI text/buttons/icons)
- Keep returning inline base64 — no filesystem round-trip needed at this size.

Add opt-out params: `max_dimension`, `quality`, `full_quality: true` for rare cases where pixel-level detail actually matters.

**Expected envelope at new defaults:** ~30–50k chars base64 per shot (down from ~200k) while remaining legible for LLM vision. Roughly **5× reduction per screenshot** with no tooling changes on the consumer side.

---

### 2d. **`browser_read(mode="outline")`** — just the interactive elements

**Observation:** For most of my reads I only wanted "what are the clickable things on this page and their labels?" — not the full DOM or full markdown.

**Fix:** a new mode that returns:
```
[button] "Send"  (ref=44)
[link]   "Cart"  (ref=8)
[textbox] "Subject"  (ref=21, value="Picking up this phone for me?")
[textbox] "Message Body"  (ref=24, value_preview="Hey Prathamesh,...")
...
```
One short response, everything I need to click or type, ~1–2k tokens instead of 30k.

---

### 2e. **Stable refs across reads**

**Observation:** When Grammarly loaded into the Gmail compose, refs shifted (`Send` went from ref 31 → 44). I had to re-read the a11y tree after every side-loaded JS change. Each re-read = ~30k tokens.

**Fix:** persistent element identifiers tied to the element, not to its tree index. If the element still exists, its ref stays the same.

---

### 2f. **Tool-result streaming / on-demand expansion**

**Observation:** When `browser_read` overflowed, the system saved it to disk and told me to `jq` it. I did that 5+ times. Each shell-out cost tokens.

**Fix:** return a handle like `read_id="abc123"`, then let me `browser_read_slice(read_id, jq_expr)` to pull specific data. Or give me a built-in `browser_query(read_id, "css:.price")` to scope without invoking bash.

---

## 3. Second-order quality-of-life additions

These don't fix "tool missing" but fix "I kept retrying the same thing":

| Tool | Status / why |
|---|---|
| `browser_scroll` with consistent int-or-string `amount` | **Still open.** The oneOf schema forced two failed attempts before I figured out `direction="top"` doesn't need an amount. |
| `browser_type` with a `submit_after=Enter\|Tab\|None` param | **Partially shipped.** `browser.type` already accepts `submit: true` which dispatches Enter. Enter-only. Tab/None variants not yet surfaced. |
| `browser_form_fill` — accepts `{field_name: value}` map | **Still open.** High-level fill of whole form without N type calls. |
| `browser_screenshot` with `clip: {x,y,w,h}` | **Still open.** Region crop for when only a slice matters (on top of 2c's global downscale). |
| `tab_alias` (user-defined) | **Partially shipped as "pinned tab".** `browser.pinned_tab` returns the user-selected "home base" tab; the popup has "Use this tab" / "Unpin" controls; pinned tab_id lives in `chrome.storage.local` so it survives browser restart; tab_pinned/tab_unpinned events emit on change. This covers the most common case (one stable anchor tab) but does not support multiple named aliases — keep this row open for that. |
| Session-level `approve_execute_js` flag | **Shipped.** Popup toggle "Auto-approve risky actions (this session)" plus `--yolo` CLI flag on the bridge. See 1c. |
| `browser_send_keys_to_contenteditable` with `Cmd+A` support | **Shipped.** `browser.type` with `mode: "trusted", clear_first: true` uses CDP `Input.dispatchKeyEvent` to send a real Ctrl/Cmd+A + Delete — Gmail's body does respect this. No standalone send-keys tool needed for the Cmd+A case; if you need arbitrary chords at document level, `browser.press` works today. |

---

## 4. What actually went wrong, step-by-step (so the fixes above have weight)

A short honest timeline of the main blockers. Status tags reflect what's now available.

1. **PDP with role-less buttons.** a11y tree returned 80 refs; none for the primary CTA. HTML read showed `<div dir="auto">Buy now</div>` — no role, no class I could target without JS. `execute_js` was denied. **→ FIXED:** (a) walker now surfaces `cursor:pointer` / `onclick` divs as refs, (b) `browser.click_by_text("Buy now")` is the direct path, (c) `execute_js` is now approvable via popup / `--yolo`.
2. **A direct-URL shortcut that looked right loaded the wrong state** (a pre-existing cart item instead of the intended product). Generic lesson: URL hacks are unreliable substitutes for real click automation. **→ MITIGATED** by `click_by_text` + pinned tab — click the real button on the tab the user is actually on.
3. **Web-mail compose URL trick worked** for subject+body prefill, but the To field stayed as free text until manually committed. Even then, Send didn't fire on first click. The whole flow is a sequence of brittle click/keypress ops on role-less elements. **→ PARTIALLY FIXED:** `click_by_text` + `type(mode:"keystroke")` now fire per-character events so autocomplete commits; `describe_ref` can confirm the recipient chip landed before clicking Send; `click(mode:"trusted")` is the escape hatch when synthetic isn't respected.
4. **Autocomplete dropdowns** often appear in screenshots but not the a11y tree until after several keystrokes. Pressing Enter didn't always select the highlighted item. **→ FIXED:** `browser.type` now defaults to `keystroke` mode (was paste-equivalent) for short text, firing real per-char keydown/beforeinput/input/keyup so autocompletes populate; `browser.wait_for(text: "...")` can wait for the dropdown row to render; `click_by_text` can then click it.
5. **Spelling fix in a contenteditable body**: `Cmd+A` via `browser_press(["Meta","KeyA"])` silently did nothing. My retype **appended**, doubling the content. Had to discard and restart. **→ FIXED for the full-replace case:** `browser.type(..., mode:"trusted", clear_first:true)` sends a real Cmd/Ctrl+A+Delete via CDP that Gmail respects. A dedicated `find_and_replace` for substring edits (without clearing the whole field) is still open — see 1d.
6. **Click on the Send-equivalent button** returned `clicked:true` but the app didn't actually advance — likely because a dependent field (recipient chip) was in an uncommitted state. The MCP had no way to tell me the click was a no-op. **→ PARTIALLY FIXED:** `browser.describe_ref` now returns `disabled`, `focused`, `value`, `aria-*` so you can assert field state before the click; `browser.wait_for_idle` detects when the page is actually done reacting. Still open: some "click is a no-op" cases would benefit from a post-click diff of the a11y tree (snapshot diff — not shipped).
7. **MCP extension disconnected** mid-operation twice, requiring reconnect. **→ PARTIALLY ADDRESSED:** the kill-switch now correctly survives the keep-alive alarm (popup Disconnect is sticky); the safety-prompt UX no longer leaves the extension in a half-connected state. Transport-level disconnect stability still needs work, but it's unrelated to this retrospective's fix list.
8. **Every `browser_read` > 40k chars blew context** and went to disk. Same for every screenshot. **→ STILL OPEN.** See 2a + 2c.

---

## 5. Priority ranking if you build one thing at a time

**Updated for remaining work** — shipped items stricken through with a pointer to the new tool.

1. ~~**`browser_click_by_text`**~~ — **shipped as `browser.click_by_text`**.
2. **`browser_screenshot` defaulting to lower resolution + lower JPEG quality** — ~5× per-call token win with no loss of legibility for the LLM. *Still the top remaining item.*
3. **A11y tree `verbose=false` default** — 60%+ fewer tokens on every read.
4. **`browser_read` pagination / selector-scope** — no more "saved to disk, please `jq` it" round-trips.
5. ~~**Approvable `execute_js`**~~ — **shipped via popup prompt + `--yolo` CLI + popup session-toggle**.
6. **`browser_find_and_replace`** — the narrow substring-edit case in contenteditable is still open; the full-field-replace case is covered by `type(mode:"trusted", clear_first:true)`.
7. ~~**`browser_wait_for` text/ref modes actually implemented**~~ — **shipped**. Also see `browser.wait_for_idle` for network-settle.
8. **`browser_query_selector` with state info** — `describe_ref` covers the ref-state side; a CSS-selector-keyed variant is still open.

Remaining top-3 after shipping: **#2 (screenshot defaults), #3 (a11y verbose default), #4 (read pagination).** These are now the highest-value unshipped items and share a theme — token cost per read.

---

## 6. What worked well (so the redesign doesn't break it)

- **`browser_read` with `mode="a11y_tree"`** giving refs alongside selectors — clean design, just needs the compression from 2b.
- **`browser_type` with `clear_first`** — correctly did what it said.
- **`browser_press` with CDP key names** — worked for individual keys (`End`, `Tab`, `Enter`); just didn't combo-chord reliably.
- **`browser_navigate` with `wait_for_load`** — reliable.
- **`browser_new_tab` with URL + query params** — the Gmail compose URL trick was the *only* reason the draft ever got populated.
- **`browser_list_tabs`** for recovering state — essential; keep it.

The foundation is solid. The gaps are specific and enumerable.
