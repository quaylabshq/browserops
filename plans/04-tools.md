# 04 — Tool Surface

> The complete public MCP tool catalogue that Claude Code sees. Every tool is prefixed `browser.` per `00-overview.md §4.4`. Error codes, `tab_id`, and `ref` semantics are inherited from the overview and **must not** be redefined here.

---

## 1. Scope

This plan specifies the exact set of MCP tools exposed by the `browserops-bridge` MCP server, their input/output JSON Schemas, the error codes each tool may return, their rate-limit weight, and whether they trigger the risky-action confirmation gate. It does **not** cover how the MCP server registers tools (see `01-mcp-server.md`), how the bridge forwards them to the extension (see `02-bridge-protocol.md`), how refs are generated and resolved (see `05-element-refs.md`), or how risky actions are confirmed (see `06-autonomy-safety.md`). It defines the contract both the bridge-side adapter and the extension-side handlers must honour.

## 2. Inputs from other plans

- `00-overview.md §4.1` — `tab_id` format and `ref` semantics (integer ≥ 0, invalidated by each `read`).
- `00-overview.md §4.2` — `Request` / `Response` envelope. Each tool's `params` here becomes the request's `params`; each `result` here becomes the response's `result`.
- `00-overview.md §4.3` — fixed set of `ErrorCode` values. No tool in this file may use any other code.
- `00-overview.md §4.4` — `browser.` naming prefix (enforced on every tool).
- `00-overview.md §4.5` — default and per-method timeout caps.
- `00-overview.md §6` — rate-limit weights (`read`/`screenshot` = 0.5, mutating actions = 1) and the risky-action categories (form submit on sensitive URL, `execute_js`, password-field interaction).
- `05-element-refs.md` — how the extension produces the `ref` integers consumed by `click`, `type`, `hover`, `scroll`, and `wait_for`.
- `sanitize_html.py` at the repo root — reused (or TS-ported) by `browser.read` for `mode: "sanitized_html"`.

## 3. Outputs to other plans

- **To `01-mcp-server.md`** — the authoritative list of MCP tool names, their JSON Schemas for registration with the MCP SDK, and per-tool rate-limit/risky flags for the bridge's middleware.
- **To `02-bridge-protocol.md`** — the `method` string used in the WebSocket `Request` envelope for each tool (always the tool name without the `browser.` prefix, i.e. `browser.click` → `method: "click"`).
- **To `03-extension.md`** — the handler surface the extension must implement (one handler per tool). Parameters and results here are the wire format.
- **To `06-autonomy-safety.md`** — the set of tools marked `risky: true`, and the set that need per-call risky-URL inspection.
- **To `08-testing.md`** — the schemas used to generate fixture requests and assert on shapes.

## 4. Design

### 4.1 Conventions for tool specs

Every tool below is documented with a uniform block:

- **Description** — one line.
- **`params`** — JSON Schema (draft 2020-12). `additionalProperties: false` everywhere.
- **`result`** — JSON Schema (draft 2020-12) describing the `result` field of the MCP tool return and the WebSocket `Response.result`.
- **Error codes** — subset of `00-overview.md §4.3`.
- **`action_weight`** — `0`, `0.5`, or `1`. Consumed by the per-tab token bucket in the bridge.
- **`risky`** — `true` if the tool unconditionally triggers the safety gate. Tools that are *conditionally* risky (e.g. `click` on a password field) note it in implementation notes; the gate logic lives in `06-autonomy-safety.md`.
- **Implementation note** — 1–3 sentences on which component runs it and how.

All tools implicitly carry a `timeout_ms` from the bridge (overview §4.5); it is not listed in each `params` because it is set by the bridge, not the caller. `wait_for` and `navigate` are the exceptions — they expose caller-facing timeout knobs.

`TAB_NOT_FOUND`, `RATE_LIMITED`, `EXTENSION_DISCONNECTED`, `TIMEOUT`, and `INTERNAL` are **implicitly possible on every tool** and are omitted from the per-tool error lists below for brevity. The per-tool lists name only the *additional* codes that tool can raise.

### 4.2 Common JSON Schema fragments

```jsonc
// $def: tab_id
{ "type": "string", "pattern": "^t_[0-9a-z]+$" }

// $def: ref
{ "type": "integer", "minimum": 1 }

// $def: url
{ "type": "string", "format": "uri", "maxLength": 4096 }

// $def: modifiers
{
  "type": "array",
  "items": { "enum": ["Control", "Alt", "Shift", "Meta"] },
  "uniqueItems": true,
  "maxItems": 4
}
```

These are assumed referenced (`$ref: "#/$defs/tab_id"` etc.) in each schema below; inline types are used here for readability.

### 4.3 Tool catalogue

---

#### 4.3.1 `browser.list_tabs`

**Description.** List all open tabs in the user's Chrome profile that the extension can see.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tabs"],
  "properties": {
    "tabs": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["tab_id", "url", "title", "active"],
        "properties": {
          "tab_id":  { "type": "string", "pattern": "^t_[0-9a-z]+$" },
          "url":     { "type": "string" },
          "title":   { "type": "string" },
          "active":  { "type": "boolean" },
          "window_id": { "type": "integer" },
          "index":   { "type": "integer", "minimum": 0 }
        }
      }
    }
  }
}
```

**Error codes.** (only the implicit set)

**`action_weight`** `0`.

**`risky`** `false`.

**Implementation note.** Extension calls `chrome.tabs.query({})`, maps each Chrome `tabId` through the bridge-owned `chrome tabId ↔ tab_id` registry (creating entries for tabs the bridge has not yet seen), and returns the list. No CDP attachment required.

---

#### 4.3.2 `browser.current_tab`

**Description.** Return the currently active tab in the focused window.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}
```

**`result`** — single tab object, same shape as one element of `list_tabs.result.tabs`:
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id", "url", "title", "active"],
  "properties": {
    "tab_id": { "type": "string" },
    "url":    { "type": "string" },
    "title":  { "type": "string" },
    "active": { "const": true }
  }
}
```

**Error codes.** `TAB_NOT_FOUND` (if no window is currently focused / no active tab).

**`action_weight`** `0`.

**`risky`** `false`.

**Implementation note.** Extension calls `chrome.tabs.query({ active: true, lastFocusedWindow: true })[0]`. If empty (e.g. DevTools has focus), fall back to `currentWindow: true`, else return `TAB_NOT_FOUND`.

---

#### 4.3.3 `browser.new_tab`

**Description.** Open a new tab, optionally at a URL, optionally making it active.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "url":    { "type": "string", "format": "uri", "maxLength": 4096 },
    "active": { "type": "boolean", "default": true }
  }
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id"],
  "properties": {
    "tab_id": { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "url":    { "type": "string" }
  }
}
```

**Error codes.** (only the implicit set)

**`action_weight`** `1`.

**`risky`** `false`.

**Implementation note.** Extension calls `chrome.tabs.create({ url, active })`. The bridge mints a fresh `tab_id` at registry insertion. If `url` is omitted, the new tab opens to Chrome's new-tab page. Does not wait for `load` — callers should follow up with `wait_for` if they need loaded content.

---

#### 4.3.4 `browser.close_tab`

**Description.** Close a tab.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id"],
  "properties": {
    "tab_id": { "type": "string", "pattern": "^t_[0-9a-z]+$" }
  }
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["closed"],
  "properties": { "closed": { "const": true } }
}
```

**Error codes.** `TAB_NOT_FOUND`.

**`action_weight`** `1`.

**`risky`** `false`.

**Implementation note.** Extension calls `chrome.tabs.remove(chromeTabId)`. The bridge retires the registry entry; subsequent calls against that `tab_id` return `TAB_NOT_FOUND`. Closing the tab also invalidates any cached a11y snapshot for it.

---

#### 4.3.5 `browser.switch_tab`

**Description.** Make the given tab active (and focus its window).

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id"],
  "properties": { "tab_id": { "type": "string", "pattern": "^t_[0-9a-z]+$" } }
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id", "active"],
  "properties": {
    "tab_id": { "type": "string" },
    "active": { "const": true }
  }
}
```

**Error codes.** `TAB_NOT_FOUND`.

**`action_weight`** `0.5`.

**`risky`** `false`.

**Implementation note.** Extension calls `chrome.tabs.update(chromeTabId, { active: true })` and `chrome.windows.update(windowId, { focused: true })`. Does **not** invalidate refs (the snapshot lives per tab, not per active state).

---

#### 4.3.6 `browser.navigate`

**Description.** Point the tab at a URL and optionally wait for page load.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id", "url"],
  "properties": {
    "tab_id":       { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "url":          { "type": "string", "format": "uri", "maxLength": 4096 },
    "wait_for_load":{ "type": "boolean", "default": true }
  }
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["final_url"],
  "properties": {
    "final_url":    { "type": "string" },
    "status_code":  { "type": "integer", "minimum": 100, "maximum": 599 }
  }
}
```

**Error codes.** `TAB_NOT_FOUND`, `NAVIGATION_IN_PROGRESS` (if called while another navigation on the same tab is still pending), `CDP_ATTACH_FAILED` (for `chrome://` and similar restricted targets when CDP is needed to read the status code).

**`action_weight`** `1`.

**`risky`** `false`.

**Implementation note.** Extension calls `chrome.tabs.update(chromeTabId, { url })`. If `wait_for_load`, it waits on `chrome.webNavigation.onCompleted` filtered to frameId `0`, capped at the overview's 45 s `navigate` timeout. `status_code` is populated opportunistically via CDP `Network.responseReceived` if a debugger session exists; otherwise omitted. Starting a navigation invalidates the tab's a11y snapshot (refs will be `REF_STALE` until next `read`).

---

#### 4.3.7 `browser.back`

**Description.** Go back one step in the tab's history.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id"],
  "properties": { "tab_id": { "type": "string", "pattern": "^t_[0-9a-z]+$" } }
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["final_url"],
  "properties": { "final_url": { "type": "string" } }
}
```

**Error codes.** `TAB_NOT_FOUND`, `NAVIGATION_IN_PROGRESS`.

**`action_weight`** `1`.

**`risky`** `false`.

**Implementation note.** Extension calls `chrome.tabs.goBack(chromeTabId)`. Waits for `webNavigation.onCompleted` the same way `navigate` does. Invalidates the a11y snapshot.

---

#### 4.3.8 `browser.forward`

**Description.** Go forward one step in the tab's history.

**`params`** — identical shape to `browser.back`.

**`result`** — identical to `browser.back`.

**Error codes.** `TAB_NOT_FOUND`, `NAVIGATION_IN_PROGRESS`.

**`action_weight`** `1`.

**`risky`** `false`.

**Implementation note.** Extension calls `chrome.tabs.goForward(chromeTabId)`. Invalidates the a11y snapshot.

---

#### 4.3.9 `browser.reload`

**Description.** Reload the current page.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id"],
  "properties": {
    "tab_id":       { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "bypass_cache": { "type": "boolean", "default": false }
  }
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["final_url"],
  "properties": { "final_url": { "type": "string" } }
}
```

**Error codes.** `TAB_NOT_FOUND`, `NAVIGATION_IN_PROGRESS`.

**`action_weight`** `1`.

**`risky`** `false`.

**Implementation note.** Extension calls `chrome.tabs.reload(chromeTabId, { bypassCache })`. Invalidates the a11y snapshot.

---

#### 4.3.10 `browser.screenshot`

**Description.** Capture a JPEG (default) or PNG of the tab and return it base64-encoded. Default is JPEG quality 40, downscaled so the longest edge is ≤ 1024 px — typically 30–50k base64 chars, down from ~200k at full fidelity. Set `full_quality: true` to bypass downscale and use quality 95; override `max_dimension` or `quality` individually for finer control.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id"],
  "properties": {
    "tab_id":        { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "full_page":     { "type": "boolean", "default": false },
    "format":        { "enum": ["png", "jpeg"], "default": "jpeg" },
    "quality":       { "type": "integer", "minimum": 0, "maximum": 100, "default": 40 },
    "max_dimension": { "type": "integer", "minimum": 1, "maximum": 8192, "default": 1024 },
    "full_quality":  { "type": "boolean", "default": false }
  }
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["image_base64", "width", "height", "format"],
  "properties": {
    "image_base64": { "type": "string", "contentEncoding": "base64" },
    "width":  { "type": "integer", "minimum": 1 },
    "height": { "type": "integer", "minimum": 1 },
    "format": { "enum": ["png", "jpeg"] }
  }
}
```

**Error codes.** `TAB_NOT_FOUND`, `CDP_ATTACH_FAILED` (full_page path on restricted pages), `INTERNAL` (if the encoded payload exceeds the 16 MiB WebSocket frame cap — see design decision below).

**`action_weight`** `0.5`.

**`risky`** `false`.

**Implementation note.** Extension uses `chrome.tabs.captureVisibleTab` (fast, no debugger attach). Captured bytes are decoded via `createImageBitmap`, drawn onto an `OffscreenCanvas` scaled so the longest edge equals `max_dimension`, and re-encoded as JPEG at `quality/100`. When `full_quality: true` the pipeline is bypassed: we forward `format`/`quality` to `captureVisibleTab` directly and return the raw capture (`quality` defaults to 95 in that branch). Explicit `format: "png"` without `full_quality` still returns JPEG by design — the point of the downscale path is byte reduction. `full_page: true` requires a CDP attach and is deferred in v1.

**Design decision — no chunking in v1.** Full-page screenshots comfortably fit within the 16 MiB WebSocket frame cap from plan 02 (a 4K PNG is ≈ 4–11 MB even after base64 expansion). No transport-layer chunking is implemented in v1. If a page exceeds the cap, `browser.screenshot` returns `INTERNAL` with message `"screenshot too large; use full_page: false"`, and the caller can fall back to viewport-only capture.

---

#### 4.3.11 `browser.read`

**Description.** Read structured page content in one of four modes. The `a11y_tree` mode is the canonical source of `ref` integers used by later `click` / `type` / `hover` calls.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id", "mode"],
  "properties": {
    "tab_id": { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "mode":   { "enum": ["a11y_tree", "markdown", "sanitized_html", "text"] },
    "max_length": { "type": "integer", "minimum": 1024, "maximum": 1048576, "default": 131072 },
    "viewport_only": { "type": "boolean", "default": false },
    "verbose": { "type": "boolean", "default": false },
    "selector": { "type": "string", "minLength": 1, "maxLength": 1024 },
    "start":  { "type": "integer", "minimum": 0, "default": 0 },
    "length": { "type": "integer", "minimum": 1024, "maximum": 1048576, "default": 131072 }
  }
}
```

`selector` scopes extraction to a single CSS-addressable subtree (applies to all four modes); the walker root for `a11y_tree` becomes the matched element, and `text` / `markdown` / `sanitized_html` operate on its `innerText` / subtree / `outerHTML` respectively. `start` + `length` select a byte (UTF-16 code-unit) range of the resulting content string. `length` defaults to `max_length` so existing callers see no regression; pass a smaller `length` to save tokens. When paginated, the response includes `total_length` and `next_start` so callers can iterate. For `a11y_tree`, slicing applies to the printed tree string only — `refs[]` always returns the full set for the scoped subtree.

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["content", "url", "title", "mode"],
  "properties": {
    "content": { "type": "string" },
    "mode":    { "enum": ["a11y_tree", "markdown", "sanitized_html", "text"] },
    "url":     { "type": "string" },
    "title":   { "type": "string" },
    "truncated":        { "type": "boolean", "default": false },
    "total_length":     { "type": "integer", "minimum": 0 },
    "next_start":       { "type": ["integer", "null"], "minimum": 0 },
    "matched_selector": { "type": "boolean" },
    "start":  { "type": "integer", "minimum": 0 },
    "length": { "type": "integer", "minimum": 0 },
    "refs": {
      "description": "Map from ref integer (as string key) to a minimal element summary. MUST be present and populated only when mode == 'a11y_tree'. For all other modes, either omit the field or return an empty object. Bridge-side validation rejects responses that violate this invariant.",
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "additionalProperties": false,
        "required": ["role"],
        "properties": {
          "role":    { "type": "string" },
          "name":    { "type": "string" },
          "value":   { "type": "string" },
          "tag":     { "type": "string" },
          "input_type": { "type": "string" }
        }
      }
    }
  },
  "if":   { "properties": { "mode": { "const": "a11y_tree" } } },
  "then": { "required": ["refs"] },
  "else": {
    "properties": {
      "refs": {
        "type": "object",
        "maxProperties": 0,
        "description": "Must be absent or empty when mode != 'a11y_tree'."
      }
    }
  }
}
```

**Error codes.** `TAB_NOT_FOUND`, `NAVIGATION_IN_PROGRESS`, `CDP_ATTACH_FAILED` (restricted pages when CDP-based a11y is needed), `INVALID_PARAMS` (schema validation failure on `params`).

**`action_weight`** `0.5`.

**`risky`** `false`.

**Implementation note.** Extension:
- `a11y_tree`: attaches CDP debugger, calls `Accessibility.getFullAXTree`, filters to interactable/meaningful nodes, numbers them depth-first, caches the tree keyed by `tab_id` for ref resolution (see `05-element-refs.md`).
- `markdown`: content script runs Readability-style extraction then an HTML→Markdown conversion.
- `sanitized_html`: content script serialises the DOM and runs it through the TS port of `sanitize_html.py` (stripping scripts, inline event handlers, unknown tags). Falls back to shelling out to the Python script only in the bridge-side development path if the TS port is unavailable.
- `text`: `document.body.innerText` with whitespace normalisation.

All modes truncate at `max_length` (default 128 KiB) and set `truncated: true` if the returned slice is smaller than the full content (i.e. `next_start` is non-null). `truncated:true` no longer implies data loss — the caller retrieves the remainder by re-calling with `start = next_start`. Calling `read` in `a11y_tree` mode *invalidates* any prior snapshot for that tab (per overview §4.1).

---

#### 4.3.12 `browser.click`

**Description.** Click an element identified by `ref`.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id", "ref"],
  "properties": {
    "tab_id":    { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "ref":       { "type": "integer", "minimum": 1 },
    "button":    { "enum": ["left", "middle", "right"], "default": "left" },
    "click_count": { "type": "integer", "minimum": 1, "maximum": 3, "default": 1 },
    "modifiers": {
      "type": "array",
      "items": { "enum": ["Control", "Alt", "Shift", "Meta"] },
      "uniqueItems": true,
      "maxItems": 4,
      "default": []
    }
  }
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["clicked"],
  "properties": {
    "clicked": { "const": true },
    "navigated": { "type": "boolean" }
  }
}
```

**Error codes.** `TAB_NOT_FOUND`, `REF_STALE`, `REF_NOT_FOUND`, `CDP_ATTACH_FAILED`, `FRAME_UNREACHABLE` (ref resolves into a cross-origin iframe or opaque shadow root the extension cannot reach), `INVALID_PARAMS` (schema validation failure on `params`), `RISKY_ACTION_DENIED` (only when the resolved element is a password field or on a sensitive-URL submit-like target — see `06-autonomy-safety.md`).

**`action_weight`** `1`.

**`risky`** `false` (conditionally risky — see implementation note).

**Implementation note.** Extension resolves `ref` through the cached a11y snapshot to a CDP `backendNodeId`, scrolls it into view if needed (`DOM.scrollIntoViewIfNeeded`), gets its bounding box (`DOM.getBoxModel`), and dispatches `Input.dispatchMouseEvent` (`mousePressed` + `mouseReleased`) at the box centre with the supplied button / modifiers / click_count. Before dispatch, if the resolved node is `<input type="password">` or the page URL matches the sensitive pattern list, the *bridge* (not the extension) holds the request and defers to the risky-action gate (`06-autonomy-safety.md`). `navigated` reports whether `webNavigation.onCommitted` fired within 1 s of the click.

---

#### 4.3.13 `browser.type`

**Description.** Type text into an element identified by `ref`.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id", "ref", "text"],
  "properties": {
    "tab_id":      { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "ref":         { "type": "integer", "minimum": 1 },
    "text":        { "type": "string", "maxLength": 32768 },
    "submit":      { "type": "boolean", "default": false },
    "clear_first": { "type": "boolean", "default": false },
    "delay_ms":    { "type": "integer", "minimum": 0, "maximum": 200, "default": 0 }
  }
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["typed"],
  "properties": {
    "typed":     { "type": "integer", "minimum": 0 },
    "submitted": { "type": "boolean" },
    "navigated": { "type": "boolean" }
  }
}
```

**Error codes.** `TAB_NOT_FOUND`, `REF_STALE`, `REF_NOT_FOUND`, `CDP_ATTACH_FAILED`, `FRAME_UNREACHABLE` (ref resolves into a cross-origin iframe or opaque shadow root the extension cannot reach), `INVALID_PARAMS` (schema validation failure on `params`), `RISKY_ACTION_DENIED`.

**`action_weight`** `1`.

**`risky`** `false` (conditionally risky: password fields; `submit: true` on a sensitive URL).

**Implementation note.** Extension first focuses the element (click at its centre). If `clear_first: true`, it sends `Control`/`Meta`-`a` followed by `Backspace` (platform-aware: `Meta` on macOS, `Control` elsewhere) before typing. The body of `text` is then dispatched via CDP per-character `Input.dispatchKeyEvent` (`keydown` → `keypress` → `keyup` for each character) so that sites listening for `keydown` (autocomplete, submit-on-Enter, live validators) observe real key events. We deliberately do **not** use `Input.insertText`: per plan 05, it bypasses key-event dispatch and silently fails on inputs that depend on those listeners. `delay_ms` is the inter-character pause (0 by default, no throttling). If `submit: true`, a final `Enter` keydown/keyup is dispatched after the text. `typed` is the number of characters actually sent (in practice `text.length`, but lower if the field rejected input). Password-field and sensitive-URL checks run in the bridge before dispatch.

---

#### 4.3.13a `browser.find_and_replace`

**Description.** Replace a substring inside an already-editable element without clearing the whole field. Complements `browser.type(mode:"trusted", clear_first:true)`, which owns the full-field-clear case. Works on `<input>`, `<textarea>`, and contenteditable.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id", "find", "replace"],
  "properties": {
    "tab_id":         { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "ref":            { "type": "integer", "minimum": 1 },
    "find":           { "type": "string", "minLength": 1, "maxLength": 4096 },
    "replace":        { "type": "string", "maxLength": 32768 },
    "occurrence":     { "enum": ["first", "all"], "default": "first" },
    "mode":           { "enum": ["synthetic", "trusted"] },
    "case_sensitive": { "type": "boolean", "default": true }
  }
}
```

`ref` is optional; when omitted, the target is `document.activeElement` (useful after a prior `browser.click` on the field). `mode: "synthetic"` (default) dispatches `beforeinput`+`input(insertReplacementText)` and either splices the native-input value via the prototype setter or issues `document.execCommand("insertText")` with a Range-manipulation fallback on contenteditable. `mode: "trusted"` sets the DOM selection to the match and issues CDP `Input.insertText` under a debugger attach — required on rich editors (Gmail, Notion, Slate, ProseMirror, Lexical) that gate on `isTrusted`. `occurrence: "all"` replaces every match with a loop cap of 1024; the search cursor advances past each inserted replacement so `replace` containing `find` cannot loop.

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["replaced"],
  "properties": {
    "replaced":      { "type": "integer", "minimum": 0 },
    "mode":          { "enum": ["synthetic", "trusted"] },
    "used_fallback": { "type": "boolean" }
  }
}
```

`used_fallback: true` indicates the synthetic contenteditable path had to drop from `execCommand("insertText")` to the Range-manipulation fallback — a signal that the site's editor is intercepting `beforeinput`, in which case the caller should retry with `mode: "trusted"`.

**Error codes.** `TAB_NOT_FOUND`, `REF_STALE`, `REF_NOT_FOUND` (when `ref` is provided), `INVALID_PARAMS` (no target when `ref` omitted and `document.activeElement` is not editable), `TEXT_NOT_FOUND`, `CDP_ATTACH_FAILED` (trusted mode only), `RISKY_ACTION_DENIED`, `RATE_LIMITED`.

**`action_weight`** `1`.

**`risky`** conditional — treated as risky only when the active tab is on a sensitive domain (mirrors `browser.type`).

**Implementation note.** Caret lands at the end of the (last) replacement in both modes. Cross-text-node matches in contenteditable are supported via a flat-map `TreeWalker(SHOW_TEXT)` that translates logical-string offsets into DOM `Range` endpoints; replacements collapse to a single text node under the common ancestor, which means inline formatting inside the find substring is lost by design.

---

#### 4.3.14 `browser.press`

**Description.** Send a keyboard-only chord to the tab without targeting a specific ref.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id", "keys"],
  "properties": {
    "tab_id": { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "keys": {
      "type": "array",
      "minItems": 1,
      "maxItems": 8,
      "items": { "type": "string", "minLength": 1, "maxLength": 32 }
    },
    "repeat": { "type": "integer", "minimum": 1, "maximum": 20, "default": 1 }
  }
}
```

Examples of valid `keys` values: `["Control","a"]`, `["Enter"]`, `["Shift","Tab"]`, `["Meta","k"]`.

**Key naming (design decision).** Keys use CDP `key` naming (e.g. `"ArrowDown"`, `"Enter"`, `"a"`, `"Control"`, `"Escape"`, `"Tab"`, `"Backspace"`, `"F1"`–`"F12"`, `"Home"`, `"End"`, `"PageUp"`, `"PageDown"`, the digits `"0"`–`"9"`, printable characters as their literal value). This matches CDP `Input.dispatchKeyEvent`'s `key` field directly — no translation layer, no normalisation of DOM `KeyboardEvent.code` values (`Digit1`, `KeyA`) on input. The tool description registered with the MCP server enumerates the full accepted key list so callers can discover names without reading CDP docs.

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["pressed"],
  "properties": { "pressed": { "const": true } }
}
```

**Error codes.** `TAB_NOT_FOUND`, `CDP_ATTACH_FAILED`.

**`action_weight`** `1`.

**`risky`** `false`.

**Implementation note.** Extension attaches the debugger and dispatches `Input.dispatchKeyEvent` for each key, applying the leading modifiers (`Control`/`Alt`/`Shift`/`Meta`) as a bitmask on the terminal key's `keyDown` and `keyUp`. For repeats > 1, the full chord is replayed. Does not require a ref; targets whatever currently has focus in the tab.

---

#### 4.3.15 `browser.scroll`

**Description.** Scroll the page (directional) or scroll a specific element into view (ref-based). Exactly one of `direction` or `ref` must be provided.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id"],
  "properties": {
    "tab_id":   { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "direction":{ "enum": ["up", "down", "left", "right", "top", "bottom"] },
    "amount":   {
      "description": "Pixels, or 'page' for one viewport height/width. Ignored for 'top'/'bottom'.",
      "oneOf": [
        { "type": "integer", "minimum": 1, "maximum": 100000 },
        { "const": "page" }
      ]
    },
    "ref":      { "type": "integer", "minimum": 1 }
  },
  "oneOf": [
    { "required": ["direction"] },
    { "required": ["ref"] }
  ]
}
```

> **Exclusivity note.** The `oneOf` above is satisfied by objects that set *both* `direction` and `ref` (each branch's `required` clause is met independently). JSON Schema draft 2020-12 cannot express "exactly one of these properties is present" without auxiliary constructs. The **bridge-side validator MUST enforce** that callers provide exactly one of `direction` or `ref`; requests with both return `INVALID_PARAMS` before any extension dispatch. Document this as a validator rule, not a schema one.

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["scroll_y"],
  "properties": {
    "scroll_x": { "type": "number" },
    "scroll_y": { "type": "number" }
  }
}
```

**Error codes.** `TAB_NOT_FOUND`, `REF_STALE`, `REF_NOT_FOUND` (ref mode only), `INVALID_PARAMS` (both `direction` and `ref` supplied, or neither; any other schema violation).

**`action_weight`** `0.5`.

**`risky`** `false`.

**Implementation note.** Directional mode: content script calls `window.scrollBy` / `scrollTo` with the computed delta (`amount === "page"` → `innerHeight`/`innerWidth`). Ref mode: resolve via the snapshot and run `DOM.scrollIntoViewIfNeeded` via CDP. Returns the final `scrollX`/`scrollY`.

---

#### 4.3.16 `browser.hover`

**Description.** Move the synthetic mouse over an element identified by `ref` (triggers CSS `:hover` and pointer events).

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id", "ref"],
  "properties": {
    "tab_id": { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "ref":    { "type": "integer", "minimum": 1 }
  }
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["hovered"],
  "properties": { "hovered": { "const": true } }
}
```

**Error codes.** `TAB_NOT_FOUND`, `REF_STALE`, `REF_NOT_FOUND`, `CDP_ATTACH_FAILED`, `FRAME_UNREACHABLE` (ref resolves into a cross-origin iframe or opaque shadow root the extension cannot reach), `INVALID_PARAMS` (schema validation failure on `params`).

**`action_weight`** `0.5`.

**`risky`** `false`.

**Implementation note.** Resolve `ref` → bounding box → `Input.dispatchMouseEvent { type: "mouseMoved" }` at the centre. No scroll-into-view (callers should `scroll` first if the element is off-screen; hover on an off-screen element is silently a no-op visually but still dispatches).

---

#### 4.3.17 `browser.wait_for`

**Description.** Block until a ref, a text substring, or a URL pattern appears. Intended for post-navigation / post-XHR synchronisation.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id"],
  "properties": {
    "tab_id":      { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "ref":         { "type": "integer", "minimum": 1 },
    "text":        { "type": "string", "minLength": 1, "maxLength": 1024 },
    "url_pattern": { "type": "string", "minLength": 1, "maxLength": 1024 },
    "timeout_ms":  { "type": "integer", "minimum": 100, "maximum": 120000, "default": 10000 },
    "poll_ms":     { "type": "integer", "minimum": 50, "maximum": 5000, "default": 250 }
  },
  "anyOf": [
    { "required": ["ref"] },
    { "required": ["text"] },
    { "required": ["url_pattern"] }
  ]
}
```

`url_pattern` is a glob (`*` wildcard, `?` single-char) matched against the tab's current URL.

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["matched"],
  "properties": {
    "matched": { "enum": ["ref", "text", "url_pattern"] },
    "elapsed_ms": { "type": "integer", "minimum": 0 }
  }
}
```

**Error codes.** `TAB_NOT_FOUND`, `REF_STALE`, `REF_NOT_FOUND`, `TIMEOUT`.

**`action_weight`** `0`.

**`risky`** `false`.

**Implementation note.** Extension polls at `poll_ms` until `timeout_ms`. `ref` mode checks that the resolved node is still attached and visible (`offsetParent !== null`). `text` mode greps `document.body.innerText` (case-sensitive, substring). `url_pattern` compares against `location.href`. The overall 120 s cap is enforced server-side per overview §4.5 regardless of `timeout_ms`.

---

#### 4.3.17a `browser.query_selector`

**Description.** Read-only CSS-selector inspector. Returns the same element-state shape as `browser.describe_ref`, but keyed on a CSS selector instead of an a11y ref. Use when the walker skipped an element (generic div, unusual role, below the 500-ref cap, `display:contents`) but you still need to inspect it. Does not assign a ref, mutate the page, or clash with the walker.

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id", "selector"],
  "properties": {
    "tab_id":   { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "selector": { "type": "string", "minLength": 1, "maxLength": 2048 },
    "all":      { "type": "boolean", "default": false }
  }
}
```

**`result`** (single-match form when `all` is false, array form when `all` is true)
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "match":     { "$ref": "#/$defs/elementState" },
    "matches":   { "type": "array", "items": { "$ref": "#/$defs/elementState" }, "maxItems": 50 },
    "total":     { "type": "integer", "minimum": 0 },
    "truncated": { "type": "boolean" }
  }
}
```

Each `elementState` carries `{ role, name, tag, visible, disabled, focused, checked, value?, attrs, aria, rect }` — the same fields `describe_ref` exposes, minus `ref`. `all: true` is capped at 50 matches; if `truncated: true` the caller should narrow the selector.

**Error codes.** `TAB_NOT_FOUND`, `INVALID_PARAMS` (bad selector syntax surfaces here, not as `INTERNAL`).

**`action_weight`** `0`.

**`risky`** `never`.

**Implementation note.** `document.querySelector` / `querySelectorAll` run in MAIN world so `value` on React-controlled inputs is readable. `SyntaxError` from a malformed selector is caught inside the injected function and re-thrown as `INVALID_PARAMS` in the bridge. Shadow DOM is **not** pierced (`describe_ref` inherits the same limitation); the a11y walker still provides the shadow-aware path.

---

#### 4.3.18 `browser.execute_js`

**Description.** Execute JavaScript inside the tab's main world. **Always risky.**

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["tab_id", "code"],
  "properties": {
    "tab_id": { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "code":   { "type": "string", "minLength": 1, "maxLength": 65536 },
    "args":   {
      "type": "array",
      "maxItems": 16,
      "items": {}
    },
    "await_promise": { "type": "boolean", "default": true },
    "return_by_value": { "type": "boolean", "default": true }
  }
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["value"],
  "properties": {
    "value":    {},
    "type":     { "type": "string" },
    "subtype":  { "type": "string" },
    "thrown":   { "type": "boolean", "default": false }
  }
}
```

If the script throws, `thrown: true` and `value` is the serialised error; the MCP response is still `ok: true` (the *execution* succeeded). Errors in attach/dispatch remain `ok: false` with the usual codes.

**Error codes.** `TAB_NOT_FOUND`, `CDP_ATTACH_FAILED`, `RISKY_ACTION_DENIED`.

**`action_weight`** `1`.

**`risky`** **`true`**.

**Implementation note.** Before dispatch the bridge routes the request through the risky-action gate (overview §6); denial returns `RISKY_ACTION_DENIED`. On approval the extension attaches the debugger, calls `Runtime.callFunctionOn` with a function wrapper that spreads `args`, `awaitPromise` and `returnByValue` honouring the params. The wrapper form (rather than raw `Runtime.evaluate`) lets us pass arguments safely without string interpolation.

---

#### 4.3.19 `browser.get_cookies`

**Description.** Read cookies for a URL (or for the tab's current URL if unspecified). **Deferred past v1.**

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "tab_id": { "type": "string", "pattern": "^t_[0-9a-z]+$" },
    "url":    { "type": "string", "format": "uri", "maxLength": 4096 },
    "name":   { "type": "string", "maxLength": 256 }
  },
  "anyOf": [
    { "required": ["tab_id"] },
    { "required": ["url"] }
  ]
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["cookies"],
  "properties": {
    "cookies": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "value", "domain", "path"],
        "properties": {
          "name":     { "type": "string" },
          "value":    { "type": "string" },
          "domain":   { "type": "string" },
          "path":     { "type": "string" },
          "secure":   { "type": "boolean" },
          "http_only":{ "type": "boolean" },
          "same_site":{ "enum": ["strict", "lax", "no_restriction", "unspecified"] },
          "expires_at":{ "type": "number" }
        }
      }
    }
  }
}
```

**Error codes.** `TAB_NOT_FOUND`.

**`action_weight`** `0`.

**`risky`** `false`.

**Status.** **Deferred to v2.** Not registered in v1. Listed here so the name is reserved and so the schema does not drift when added. In v1 the bridge returns an MCP error before the tool is invoked.

**Implementation note (when enabled).** Extension calls `chrome.cookies.getAll({ url })` with the MV3 `cookies` permission (must be declared in the manifest at the time we ship it).

---

#### 4.3.20 `browser.set_cookie`

**Description.** Set a cookie on a URL. **Deferred past v1. Risky when enabled.**

**`params`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["url", "name", "value"],
  "properties": {
    "url":       { "type": "string", "format": "uri", "maxLength": 4096 },
    "name":      { "type": "string", "maxLength": 256 },
    "value":     { "type": "string", "maxLength": 4096 },
    "domain":    { "type": "string" },
    "path":      { "type": "string" },
    "secure":    { "type": "boolean" },
    "http_only": { "type": "boolean" },
    "same_site": { "enum": ["strict", "lax", "no_restriction", "unspecified"] },
    "expires_at":{ "type": "number" }
  }
}
```

**`result`**
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["set"],
  "properties": { "set": { "const": true } }
}
```

**Error codes.** `RISKY_ACTION_DENIED`.

**`action_weight`** `1`.

**`risky`** **`true`** (when enabled). Setting cookies can log a user into an arbitrary account or bypass auth — always gated.

**Status.** **Deferred to v2.**

**Implementation note (when enabled).** Extension calls `chrome.cookies.set(...)`. Gated through the risky-action flow before dispatch.

---

### 4.4 Summary table

| Tool | `action_weight` | `risky` | Conditionally risky | Status |
|---|---|---|---|---|
| `browser.list_tabs`   | 0   | no  | — | v1 |
| `browser.current_tab` | 0   | no  | — | v1 |
| `browser.new_tab`     | 1   | no  | — | v1 |
| `browser.close_tab`   | 1   | no  | — | v1 |
| `browser.switch_tab`  | 0.5 | no  | — | v1 |
| `browser.navigate`    | 1   | no  | — | v1 |
| `browser.back`        | 1   | no  | — | v1 |
| `browser.forward`     | 1   | no  | — | v1 |
| `browser.reload`      | 1   | no  | — | v1 |
| `browser.screenshot`  | 0.5 | no  | — | v1 |
| `browser.read`        | 0.5 | no  | — | v1 |
| `browser.click`       | 1   | no  | password field; sensitive-URL submit | v1 |
| `browser.type`        | 1   | no  | password field; `submit:true` on sensitive URL | v1 |
| `browser.press`       | 1   | no  | — | v1 |
| `browser.scroll`      | 0.5 | no  | — | v1 |
| `browser.hover`       | 0.5 | no  | — | v1 |
| `browser.wait_for`    | 0   | no  | — | v1 |
| `browser.execute_js`  | 1   | **yes** | — | v1 |
| `browser.get_cookies` | 0   | no  | — | **v2** |
| `browser.set_cookie`  | 1   | **yes** | — | **v2** |

### 4.5 Validation responsibilities

- **Bridge side.** Validate `params` against the schema above before emitting a `Request` envelope. On validation failure, return `INVALID_PARAMS` (now part of the canonical `ErrorCode` set — overview §4.3) *without* touching the rate-limit bucket and *without* contacting the extension. This keeps malformed input from spending budget. The error's `details` field SHOULD include the `ajv` error path and reason so callers can correct the request. The same code covers validator-enforced rules that JSON Schema alone can't express (e.g. `browser.scroll`'s "exactly one of `direction` or `ref`").
- **Extension side.** Re-validate at the handler boundary as defence-in-depth. Any mismatch returns `INTERNAL` with `details.reason = "schema_mismatch"` — this is the one place `INTERNAL` is expected rather than exceptional.
- **Schema source.** The schemas in this file are the authoritative spec. `packages/shared/` holds TypeScript types generated from them (or hand-kept in sync); the bridge imports those for MCP registration and for runtime validation via `ajv`.

## 5. Risks & mitigations

1. **Ref staleness mid-sequence.** Claude calls `read` → `scroll` → `click` but the page mutated between `read` and `click` (e.g. lazy-loaded list pushed items down), making the cached CSS selector match the wrong node. *Mitigation:* resolution in the extension cross-checks the cached node's `role` + accessible name against the snapshot; mismatch → `REF_STALE`. Claude is expected to `read` again.

2. **Large `read` / `screenshot` payloads blow the WebSocket frame or MCP line buffer.** A full-page screenshot of a long doc page can be > 10 MB; `sanitized_html` of a complex page can exceed 1 MB. *Mitigation:* `read` enforces `max_length` with `truncated: true`; screenshots are chunked at the transport layer per `02-bridge-protocol.md`. JPEG is the default fallback in the extension when a PNG capture exceeds a size threshold (documented in `03-extension.md`).

3. **Rate limit exhaustion stalls recovery loops.** If Claude hits `RATE_LIMITED` while trying to back out of a bad state, it cannot call `read` to observe why. *Mitigation:* `read`, `screenshot`, `switch_tab`, `scroll`, `hover`, `wait_for` are all weighted 0 or 0.5 precisely so observation and navigation-light actions survive longer than mutating ones. `wait_for` is weight 0 so it can always be used to recover.

4. **`execute_js` as a bypass for every other risky check.** A model can trivially issue `execute_js` with `document.querySelector('input[type=password]').value = '...'` to skirt the password-field gate on `type`. *Mitigation:* `execute_js` is *unconditionally* risky (the gate fires for every invocation), so the bypass ends up stricter than the thing it would bypass.

5. **`wait_for` polling can masquerade as a busy-loop budget consumer.** Weight-0 `wait_for` still spends CPU in the extension and can pin an event loop. *Mitigation:* `poll_ms >= 50`, `timeout_ms <= 120 000`, and the extension coalesces overlapping `wait_for`s on the same tab onto a single poll interval.

6. **`navigate` racing with background-triggered navigations.** A user or a page script can start navigating while we send `navigate`; the `wait_for_load` handler may attach to the wrong navigation event. *Mitigation:* the extension tracks the most recent `webNavigation.onBeforeNavigate` requestId for the tab and only resolves the promise on the matching `onCompleted`. If it sees a newer requestId preempt ours, it returns `NAVIGATION_IN_PROGRESS`.

## 6. Open questions

- **Multi-select / drag-and-drop.** Not in v1. Should we reserve `browser.drag` in the naming space now? Likely yes; flag for decision before v1 freeze.
- **`browser.read` mode `viewport_only`.** Drafted here (boolean, default false) but the extension may only implement it for `text` and `a11y_tree` in v1. Who owns that cutoff?
- **Cookie-tool risk model.** If/when `get_cookies` ships, should it also be risky (cookie values can be session tokens)? Pushed to the v2 author.
- **`execute_js` result size cap.** No explicit cap today. Does the overview's 128 KiB log-line norm (§4.6) imply one?

### 6.1 Resolved (previously open)

- **Chunked screenshot response.** **Resolved — no chunking in v1.** Full-page screenshots fit within the 16 MiB WebSocket frame cap (plan 02); oversize captures return `INTERNAL` with `"screenshot too large; use full_page: false"`. See `browser.screenshot` design decision.
- **`browser.press` key naming divergence.** **Resolved — CDP `key` naming only.** See `browser.press` key-naming design decision; no normalisation of DOM `KeyboardEvent.code` on input.
- **Error code for schema validation failures on params.** **Resolved — `INVALID_PARAMS` is canonical.** Added to overview §4.3; bridge returns it on schema failure without consuming a rate-limit token (see §4.5).

## 7. Acceptance checklist

- [ ] Every tool name starts with `browser.`.
- [ ] Every tool's `params` and `result` validate against JSON Schema draft 2020-12.
- [ ] Every tool uses only error codes from `00-overview.md §4.3`. No new codes are introduced.
- [ ] Every tool has `action_weight ∈ {0, 0.5, 1}`.
- [ ] The three conditionally-risky cases (password field, sensitive-URL submit via `click`/`type`, all `execute_js`) are explicitly referenced and the gate logic is delegated to `06-autonomy-safety.md`.
- [ ] `browser.read` in `a11y_tree` mode is the sole producer of refs consumed by `click`/`type`/`hover`/`scroll(ref)`/`wait_for(ref)`.
- [ ] A summary table (§4.4) lists every tool, weight, risky flag, and v1/v2 status.
- [ ] `packages/shared/` is identified as the home of the machine-generated types; no types are duplicated in `packages/bridge/` or `packages/extension/` independently of it.
- [ ] The `sanitize_html.py` reuse path is documented for `sanitized_html` mode of `read`.
- [ ] All deferred tools (`get_cookies`, `set_cookie`) are marked and are not registered by the v1 MCP server.
- [ ] Bridge-side vs extension-side validation responsibility is explicit (§4.5).
- [ ] Timeouts above §4.5's caps are impossible by schema (`wait_for.timeout_ms` max 120 000).
- [ ] At least one risk addresses each of: ref staleness, payload size, rate-limit interplay, `execute_js` bypass, polling cost, navigation races.
- [ ] Every tool has an implementation note naming the Chrome API or CDP domain used.
