# BrowserOps — End-to-End Plan Overview

> Claude Code plugin that drives a live Chrome browser. Claude Code calls MCP tools → a local Node process forwards them to a Chrome extension over WebSocket → the extension uses `chrome.tabs`, `chrome.scripting`, and `chrome.debugger` to control the user's real browsing session.

This document is the connective tissue. Every sub-plan (01–08) refers back to the **Shared Contracts** section here. If a sub-plan disagrees with this file, this file wins and the sub-plan must be updated.

---

## 1. Goals & non-goals

**Goals (v1)**
- Claude Code, running in a terminal, can autonomously drive the user's real Chrome profile.
- Claude can open new tabs, navigate, read structured page content, click, type, submit forms, take screenshots, and read the a11y tree.
- Works with the user's existing logged-in sessions (Gmail, etc.) — no separate profile, no re-login.
- Runs fully autonomously (no per-action prompts) except for a narrow "very risky" confirmation path.
- Rate-limited to 16 actions/minute per tab as a runaway-loop safety floor.

**Non-goals (v1)**
- Firefox / Edge / Safari support.
- Multiple Chrome windows or profiles simultaneously.
- Chrome Web Store distribution (developer-mode load-unpacked is fine).
- Stealth/anti-bot — this is user-agent automation, not scraping.
- Mobile browsers.

---

## 2. Architecture

```
┌──────────────┐   stdio MCP    ┌───────────────────────┐   WebSocket   ┌─────────────────────┐
│              │ ─────────────> │                       │ ────────────> │                     │
│ Claude Code  │                │  browserops-bridge   │               │  Chrome extension   │
│              │ <───────────── │  (single Node/TS      │ <──────────── │  (MV3, background   │
└──────────────┘   tool results │   process)            │   events      │   service worker)   │
                                └───────────────────────┘               └──────────┬──────────┘
                                                                                    │
                                                                                    │ chrome.* APIs
                                                                                    │ chrome.debugger (CDP per tab)
                                                                                    ▼
                                                                         ┌─────────────────────┐
                                                                         │   Live Chrome tabs  │
                                                                         │   (user's profile)  │
                                                                         └─────────────────────┘
```

**Three components, all in one repo:**

| # | Component | Language | Lives in | Plan |
|---|---|---|---|---|
| A | MCP + WebSocket bridge (single process) | TypeScript / Node ≥20 | `packages/bridge/` | `01-mcp-server.md`, `02-bridge-protocol.md` |
| B | Chrome extension (MV3) | TypeScript | `packages/extension/` | `03-extension.md` |
| C | Shared types / JSON schemas | TypeScript | `packages/shared/` | referenced by 01–05 |

Single `pnpm` workspace. One `tsconfig`-base. One `package.json` at root.

---

## 3. How a tool call flows end-to-end

Example: Claude calls `browser.click({ tab_id: "t_17", ref: 42 })`.

1. **Claude Code → Bridge (MCP over stdio).** Standard MCP `tools/call` request with the name `browser.click`.
2. **Bridge — rate limiter.** Check the tab's per-minute budget (16 actions). Reject with `RATE_LIMITED` if exceeded.
3. **Bridge — risky-action gate.** `click` is not risky by default, so skip. (See `06-autonomy-safety.md` for the denylist.)
4. **Bridge → Extension (WebSocket).** Send a `Request` envelope (see §5) with `method: "click"` and the payload.
5. **Extension — router.** Background service worker routes to the `click` handler.
6. **Extension — resolve ref.** Look up ref `42` in the per-tab a11y snapshot taken at the last `read` call. Map it to a CSS selector or CDP backend node id.
7. **Extension — execute.** Use `chrome.debugger` (CDP `Input.dispatchMouseEvent`) or a content-script synthetic click depending on element type.
8. **Extension → Bridge.** Send a `Response` envelope with the result or error.
9. **Bridge → Claude Code.** Return the MCP tool result.
10. **Logging.** Every step is appended to `~/.browserops/log.jsonl`.

A `read` call is the same flow except the extension builds and returns a fresh a11y snapshot (and caches it keyed by tab id for later `click`/`type` ref resolution).

---

## 4. Shared contracts

### 4.1 Component identifiers

- **Tab id.** Opaque string issued by the bridge, stable for the lifetime of a Chrome tab. Format: `t_<base36-monotonic>`. The bridge maintains the mapping `tab_id ↔ chrome tabId`. Minted on a `tab_created` event from the extension; the bridge replies with a `assign_tab_id` response carrying the new id (see §4.2).
- **Ref.** Integer ≥ 1. Stable only within a single a11y snapshot. Calling `read` on a tab invalidates previous refs for that tab. Ref `0` is reserved for "no element" / sentinel use by 05-element-refs.
- **Request id.** UUIDv4, generated by the sender (bridge for Requests, extension for its own handshake). Echoed in the response.

### 4.2 WebSocket message envelope

Each WebSocket text frame carries **exactly one** JSON document, UTF-8, no trailing newline. Five envelope types:

```ts
// Extension → Bridge, first frame after socket opens
type Hello = {
  type: "hello";
  token: string;            // shared secret from ~/.browserops/token
  extension_version: string;
  protocol_version: number; // see §4.7
};

// Bridge → Extension, response to Hello
type HelloAck = {
  type: "hello_ack";
  bridge_version: string;
  protocol_version: number;
};

// Bridge → Extension
type Request = {
  type: "request";
  id: string;               // UUIDv4
  method: string;           // e.g. "click", "read", "screenshot", "assign_tab_id", "safety_prompt"
  params: Record<string, unknown>;
  timeout_ms: number;       // default 30000
};

// Extension → Bridge
type Response = {
  type: "response";
  id: string;               // matches the Request id
  ok: boolean;
  result?: unknown;         // present iff ok === true
  error?: {                 // present iff ok === false
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
  meta?: {                  // optional, non-semantic diagnostics
    dropped_events?: number;
  };
};

// Extension → Bridge (unsolicited)
type Event = {
  type: "event";
  name: string;             // e.g. "tab_created", "tab_closed", "page_navigated", "page_loaded", "extension_paused", "extension_resumed"
  payload: Record<string, unknown>;
};
```

The handshake token is carried **only** in the first frame (`Hello`); subsequent frames are not re-authenticated at the application layer — the persistent socket is the auth boundary.

### 4.3 Error codes

| Code | Meaning |
|---|---|
| `TAB_NOT_FOUND` | `tab_id` does not resolve to an open tab. |
| `REF_STALE` | Ref existed in an older snapshot for this tab but no longer matches DOM/AX state. |
| `REF_NOT_FOUND` | Ref id never existed in any snapshot for this tab. |
| `TIMEOUT` | Operation exceeded `timeout_ms`. |
| `NAVIGATION_IN_PROGRESS` | Target tab is mid-navigation; retry after `page_loaded` event. |
| `CDP_ATTACH_FAILED` | `chrome.debugger.attach` rejected (e.g. chrome:// page, another debugger attached). |
| `FRAME_UNREACHABLE` | Target element is inside a cross-origin iframe we cannot drive, or an opaque shadow root. |
| `RATE_LIMITED` | Per-tab or global action budget exhausted. Details include `retry_after_ms`. |
| `RISKY_ACTION_DENIED` | Blocked by safety layer; user denied or confirmation timed out. |
| `EXTENSION_DISCONNECTED` | WebSocket closed before response (bridge-side only). |
| `INVALID_PARAMS` | Tool parameters failed schema validation (bridge-side, before forwarding). |
| `INTERNAL` | Unexpected failure. Should be rare; expected conditions use a specific code above. |

These codes are the exhaustive set. A sub-plan that needs a new code must update this table, not invent one locally.

### 4.3.1 WebSocket close codes

Application-defined codes (RFC 6455 §7.4.2, 4000–4999 range). Canonical here:

| Code | Meaning | Initiator |
|---|---|---|
| 4001 | Bad token | Bridge |
| 4002 | Protocol version mismatch | Bridge |
| 4003 | Hello timeout (no hello within 5 s) | Bridge |
| 4004 | Malformed hello frame | Bridge |
| 4005 | Superseded (newer socket from same extension) | Bridge |
| 4006 | User-initiated kill switch | Extension |
| 4008 | Backpressure abort (queue full) | Either |

### 4.4 Tool naming

All MCP tools are prefixed `browser.` (e.g. `browser.click`, `browser.read`, `browser.screenshot`). Full list in `04-tools.md`.

### 4.5 Default timeouts

- Default tool timeout: 30 s.
- `navigate`: 45 s (from call to `load` event).
- `wait_for`: honors caller-provided timeout, cap 120 s.

### 4.7 Protocol version

Integer, starts at `1`. Bumped only on breaking envelope changes. `HelloAck` carries the bridge's version; extension must close the socket if the bridge's version is not in its `SUPPORTED_PROTOCOL_VERSIONS` set. See 02-bridge-protocol.md for full rules.

### 4.6 Log format

`~/.browserops/log.jsonl` — one JSON object per line:

```json
{"ts":"2026-04-21T10:00:00.000Z","dir":"mcp_in","id":"...","method":"click","params":{...}}
{"ts":"2026-04-21T10:00:00.050Z","dir":"ws_out","id":"...","method":"click"}
{"ts":"2026-04-21T10:00:00.200Z","dir":"ws_in","id":"...","ok":true}
{"ts":"2026-04-21T10:00:00.201Z","dir":"mcp_out","id":"...","ok":true}
```

---

## 5. Runtime & security posture

- **Transport between bridge and extension:** WebSocket on `127.0.0.1:8765` (default, configurable via `BROWSEROPS_PORT`). **Never** bound to `0.0.0.0`.
- **Shared secret.** On first run, the bridge generates a token written to `~/.browserops/token` (mode 0600). The user pastes the same token into the extension's options page; it is stored in `chrome.storage.local`. The token is sent **only** in the extension's first frame (`Hello`); the subsequent persistent socket is the ongoing auth boundary. Mismatch → bridge closes with code 4001.
- **Origin check.** Bridge accepts only WebSocket upgrades with `Origin: chrome-extension://<our-extension-id>`, enforced on the HTTP `upgrade` event *before* `handleUpgrade` (so rejected connections get 403 and never reach application code).
- **No telemetry.** All logs local.

---

## 6. Autonomy model (summary — full detail in `06-autonomy-safety.md`)

- **Default:** no prompts, no denylists. Claude's tool calls execute immediately.
- **Rate limit:** 16 actions/minute per tab. Token-bucket. `read` and `screenshot` count as 0.5 actions; `click`/`type`/`navigate` count as 1.
- **Kill switch:** extension toolbar icon → one click disconnects the WebSocket; any in-flight requests return `EXTENSION_DISCONNECTED`.
- **"Very risky" confirmation — heuristic, not a denylist:**
  - Submitting forms on pages whose URL matches a small built-in list of financial/auth patterns (`*.bank*`, `paypal.com`, `1password.com`, etc. — editable file).
  - `execute_js` tool calls.
  - Click/type on `<input type="password">`.
  - These surface a confirmation in the extension popup. No response = deny after 30 s.

---

## 7. Build order (dependency graph)

```
  00-overview  ─┐
                ├─> 04-tools ─┐
  02-bridge ───┤              ├─> 01-mcp-server ──> 03-extension ──> 08-testing
                ├─> 05-refs ──┘                                  ▲
                └─> 06-safety ─────────────────────────────────> │
  07-dev-setup (independent; just tooling)  ───────────────────> │
```

Sub-plans can be drafted in parallel (they all consume this overview), but **01 cannot be implemented before 02 + 04 are locked**, and **03 cannot be implemented before 01 is running on stubs**.

---

## 8. Repository layout

```
browserops/
├── package.json                 # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── plans/                       # this directory
│   ├── 00-overview.md
│   ├── 01-mcp-server.md
│   ├── 02-bridge-protocol.md
│   ├── 03-extension.md
│   ├── 04-tools.md
│   ├── 05-element-refs.md
│   ├── 06-autonomy-safety.md
│   ├── 07-dev-setup.md
│   └── 08-testing.md
├── packages/
│   ├── shared/                  # types, JSON schemas, constants
│   ├── bridge/                  # single-process MCP + WebSocket
│   └── extension/               # MV3 extension (chrome only)
├── sanitize_html.py             # existing helper, reused by "read" tool's html-sanitize mode
└── scripts/                     # build, load-unpacked helper, dev runner
```

---

## 8.1 Procedure runtime

Procedures are persistent, per-user, YAML-on-disk action graphs stored in
`~/browserops/procedures/`. Each procedure is a versioned directory containing a
`procedure.yaml` file that declares inputs, preconditions, steps (referencing
`browser.*` primitives or other procedures via `uses:`), and optional
`success_criteria`. Six MCP tools surface the subsystem: `procedures.list`,
`procedures.search`, `procedures.get`, `procedures.save`, `procedures.promote`,
and `procedures.delete`. The bridge owns persistence, schema validation, index
building, and search ranking — it never executes procedures. Execution is
agent-side: the agent reads the YAML body via `procedures.get`, interprets the
`steps:` sequence, and calls the `browser.*` primitives itself. Canonical design:
[impl-06-procedures.md](impl-06-procedures.md).

---

## 9. Open questions deferred from v1

These are intentional gaps that sub-plans should **not** try to close:

- How Claude Code launches the bridge (bundled npm package vs. standalone binary). Defer to packaging sub-plan later.
- Multi-window support. Deferred.
- Firefox port. Deferred.
- Proper Gmail-API fallback for reliable email composition. Deferred — DOM-driving Gmail works in v1.

---

## 10. Conventions each sub-plan MUST follow

Every sub-plan file (`01-…` through `08-…`) must contain these sections in order:

1. **Scope** — one paragraph, what this plan covers and what it deliberately doesn't.
2. **Inputs from other plans** — bulleted list of things this plan depends on from elsewhere.
3. **Outputs to other plans** — bulleted list of things this plan produces that others will consume.
4. **Design** — the actual plan content. Use subsections freely.
5. **Risks & mitigations** — at least three, with one-line mitigations.
6. **Open questions** — anything unresolved. Empty list is allowed.
7. **Acceptance checklist** — concrete, testable items that mark this component "done".

Sub-plan authors must not invent new tool names, new error codes, or new envelope fields without updating this overview.
