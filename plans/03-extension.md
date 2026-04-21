# 03 — Chrome Extension (MV3)

## Scope

This plan covers everything that runs **inside Chrome**: the MV3 extension that receives WebSocket requests from the bridge, drives `chrome.*` APIs, attaches `chrome.debugger` for trusted input and screenshots, tracks tabs, caches per-tab a11y refs, and surfaces a minimal options/popup UI. It does **not** cover the Node bridge (see `01-mcp-server.md`), the wire protocol itself (see `02-bridge-protocol.md`), the tool semantics (see `04-tools.md`), ref-snapshot algorithm details (see `05-element-refs.md`), or the risky-action gate which lives bridge-side (see `06-autonomy-safety.md`). The extension **consumes** the envelope and error codes defined in `00-overview.md §4` verbatim.

Target: a single unpacked MV3 extension under `packages/extension/`, loaded via `chrome://extensions` in developer mode. Chrome-only, v1.

## Inputs from other plans

- **`00-overview.md §4`** — `Request` / `Response` / `Event` envelope shapes, error codes, tab-id format, ref semantics, timeout defaults.
- **`00-overview.md §5`** — shared-token handshake, `127.0.0.1:8765` default, origin policy (the bridge will reject the extension's WS unless `Origin` matches `chrome-extension://<our-extension-id>`; this plan is responsible for making that id deterministic).
- **`02-bridge-protocol.md`** — handshake frame shape, reconnect/backoff expectations, the set of `method` strings the extension must implement handlers for, the set of `event` names it may emit.
- **`04-tools.md`** — per-method request/response payload schemas. This plan routes by `method` but delegates payload shape to 04.
- **`05-element-refs.md`** — the a11y snapshot build algorithm and the ref → element resolution rules. This plan **stores and invalidates** the snapshot; it does not define how the snapshot is built.

## Outputs to other plans

- **Extension id.** Deterministic via the manifest `key` field (derived from a committed dev keypair). The bridge (`01`) hardcodes this id for its origin allowlist.
- **Supported methods & events.** The extension exposes handlers for every method in `04-tools.md` and emits events `tab_created`, `tab_closed`, `page_navigated`, `page_loaded`, `debugger_detached`. Rate limiting lives entirely in the bridge; the extension does not emit rate-limit events.
- **`safety_prompt` Request handler** (per `06-autonomy-safety.md`): the background SW surfaces the prompt in the extension popup and returns a `Response` with matching `id` carrying `{ decision_id, allow: boolean }`. This is consumed by plan 06's confirmation flow.
- **Session state surface.** `chrome.storage.session` keys documented below (`refCache:*`, `inflight`, `tabMap`) — consumed only within this extension but documented so hot-reload / debug tools don't collide.
- **Token file expectation.** The user pastes the bridge's token from `~/.browserops/token` into the options page; the extension stores it in `chrome.storage.local` under `token`. (The bridge is not responsible for delivering it.)

## Design

### D1. `manifest.json`

MV3, `manifest_version: 3`. Chrome minimum version: **120** (required for stable `chrome.storage.session`, `chrome.debugger.onEvent` behavior on SW restarts, and `offscreen` documents if we need them).

```jsonc
{
  "manifest_version": 3,
  "name": "browserops",
  "version": "0.1.0",
  "minimum_chrome_version": "120",
  "key": "<base64 pubkey committed to repo under /packages/extension/dev-key.pub>",
  "background": { "service_worker": "sw.js", "type": "module" },
  "action": { "default_popup": "popup.html", "default_title": "browserops" },
  "options_page": "options.html",
  "permissions": [
    "tabs",
    "scripting",
    "debugger",
    "storage",
    "alarms",
    "webNavigation"
  ],
  "host_permissions": ["<all_urls>"],
  "content_security_policy": {
    "extension_pages": "script-src 'self'; object-src 'self'"
  }
}
```

**Why each permission:**

| Permission | Why |
|---|---|
| `tabs` | Enumerate tabs, read `url`/`title`, listen to `onCreated`/`onRemoved`/`onUpdated`. Required for tab-id mapping and `page_navigated` events. |
| `scripting` | `chrome.scripting.executeScript` to inject the content script on demand for DOM reads, a11y-tree DOM walk, and fast synthetic clicks. Preferred over a static `content_scripts` match because we only want to run on active tabs when a tool call arrives. |
| `debugger` | `chrome.debugger.attach` per tab for CDP — `Input.dispatchMouseEvent` / `Input.insertText` / `Input.dispatchKeyEvent` for **trusted** input events, `Page.captureScreenshot` for full-page screenshots, `Accessibility.getFullAXTree` as the authoritative snapshot source. |
| `storage` | `chrome.storage.local` for the shared token (persisted); `chrome.storage.session` for hot state across SW restarts within a browser session. |
| `alarms` | Periodic SW keep-alive (every 30 s) so the background service worker is revived if Chrome tried to evict it while a WS connection is supposed to be live. |
| `webNavigation` | `webNavigation.onCommitted` / `onCompleted` — used to emit `page_navigated` / `page_loaded` events and to invalidate the ref cache for that tab. More reliable than `tabs.onUpdated`. |
| `host_permissions: <all_urls>` | CDP commands work on any tab, but `scripting.executeScript` requires host access. v1 targets the user's everyday browsing, so `<all_urls>` is unavoidable. We do **not** broaden to `chrome://` / `chrome-extension://` — those are blocked by Chrome anyway and will surface as `CDP_ATTACH_FAILED`. |

**`key` field — deterministic extension id.** During development we generate one keypair, commit the public half inline in `manifest.json`'s `key` field, and keep the private half out of source control (it's only used if/when we publish). The extension id is the first 32 hex nibbles of SHA-256(pubkey DER), each remapped a–p (0→a, 1→b, …, f→p), so it stays stable across `rm -rf && reload unpacked` cycles. This is what lets the bridge (`01`) hardcode the origin allowlist.

### D2. Background service worker (`sw.js`)

**Single responsibility entry point.** On load (cold start or eviction-revive), the SW:

1. Reads `token` from `chrome.storage.local`. If absent → stays idle, sets badge to "!", waits for options page to set it (listens on `chrome.storage.onChanged`).
2. Opens `ws://127.0.0.1:8765/` with `Origin` set implicitly by Chrome to `chrome-extension://<id>` (Chrome does this automatically for WS from an extension context).
3. Sends handshake frame: `{ "type": "hello", "token": "<token>", "extension_version": "0.1.0" }`. Mismatch → bridge closes socket; we go into backoff.
4. Reconnect backoff: 500 ms, 1 s, 2 s, 5 s, 10 s, 30 s (cap). Resets on successful handshake.
5. Registers `chrome.alarms.create("ws-keepalive", { periodInMinutes: 0.5 })` — 30 s, the minimum Chrome ≥120 allows for packed extensions (sub-0.5 values are silently clamped / ignored). Since Chrome 110, any extension API call resets the SW idle timer, so the alarm fire itself is sufficient to keep the SW alive; a 30-s cadence stays comfortably ahead of eviction. On alarm fire, if WS closed → reconnect. The SW relies on `chrome.alarms` + the persistent WebSocket itself for liveness; no application-layer ping frame is sent (the browser's `WebSocket` API does not permit emitting control-frame pings, and the server may ping us with the browser auto-ponging).
6. Registers listeners: `chrome.tabs.onCreated`, `onRemoved`, `chrome.webNavigation.onCommitted`, `onCompleted`, `chrome.debugger.onDetach`, `chrome.debugger.onEvent`, `chrome.runtime.onMessage` (popup/options).

**Request router.** Incoming `Request` → `switch(method)` → handler module. Each handler is async, returns `{ok:true, result}` or `{ok:false, error}`; the dispatcher wraps it in the `Response` envelope with the matching `id`. The dispatcher also enforces `timeout_ms` by racing the handler against a timer that resolves to `{code: "TIMEOUT"}`.

**Event emitter.** `emitEvent(name, payload)` — serializes and writes to the WS. Drops silently if WS is closed (bridge will re-fetch state on reconnect).

### D3. MV3 service-worker eviction — what actually survives

Chrome will terminate the SW after ~30 s idle. Everything in SW module scope is lost. Concretely:

| State | Where it lives | Survives eviction? |
|---|---|---|
| WS connection | SW module scope | **No** — must reopen |
| Token | `chrome.storage.local` | Yes |
| Tab-id ↔ chrome-tabId map | `chrome.storage.session` (mirrored) | Yes, for the browser session |
| Ref cache per tab | `chrome.storage.session` | Yes |
| In-flight request ids | `chrome.storage.session.inflight` | Yes — used to send `EXTENSION_DISCONNECTED`-style terminal responses on revive |
| Attached debugger sessions | Chrome-internal | Yes across SW eviction, but a `chrome.debugger.onDetach` may fire if user closed the devtools banner |

**On cold start / revive the SW:**

1. Reopens WS.
2. Rehydrates `tabMap` and `refCache` from `chrome.storage.session`.
3. Reads `inflight` — for any request id present there, sends a `Response` with `ok:false, error:{code:"INTERNAL", message:"sw_evicted"}`. This is a belt-and-suspenders safety net; in normal operation the alarm keeps the SW alive so `inflight` is empty.
4. Walks `chrome.debugger.getTargets()` to reconcile attached tabs against `tabMap`.

**Why `chrome.storage.session` and not `chrome.storage.local` for hot data:** `session` is cleared on browser restart, which is exactly what we want — tab ids and refs are meaningless across Chrome restarts. It also has higher quota (10 MB vs. local's 10 MB but shared with extension preferences) and is faster because it's memory-backed.

### D4. Content scripts vs. `chrome.debugger` — decision matrix

| Operation | Mechanism | Why |
|---|---|---|
| Build a11y snapshot for `read` | CDP `Accessibility.getFullAXTree` **primary**; content-script DOM walk as fallback if CDP attach fails | CDP gives role/name that match what AT users see, including shadow DOM / iframes. DOM walk is a lossy fallback for `chrome://` etc. |
| Resolve ref to backend node | Stored at snapshot time: `{ref → backendNodeId}` from CDP, plus `{ref → cssPath}` redundant for content-script path | Allows either mechanism to act. |
| Click on resolved ref | CDP `Input.dispatchMouseEvent` (mousePressed + mouseReleased) **primary** | Trusted event — passes `isTrusted` checks, triggers anti-bot handlers that reject `.click()`. |
| Click on "safe" element where trusted not needed | Content-script `element.click()` **opt-in fallback** | Faster (no CDP round-trip), works on `chrome.debugger`-forbidden pages. |
| Type into input | CDP per-char `Input.dispatchKeyEvent` (keydown/keypress/keyup) for all inputs; `Input.insertText` reserved for contenteditable rich-text fallback only | Triggers real `input` / `keydown` events including IME composition. |
| Screenshot | CDP `Page.captureScreenshot` with `captureBeyondViewport:true` | Full-page required; `chrome.tabs.captureVisibleTab` is viewport-only. |
| Read DOM text / HTML | Content-script via `chrome.scripting.executeScript` | No CDP needed; also cheaper. |
| `scroll_to` | CDP `Input.dispatchMouseWheelEvent` or content-script `scrollIntoView` depending on target | Wheel is trusted and mimics the user; `scrollIntoView` is sufficient for ref-targeted scroll. |
| `execute_js` | Content-script `chrome.scripting.executeScript({world:"MAIN"})` | Runs in page world so results reflect page state. |

**Attach lifecycle (per tab):**

- **Lazy attach.** First action on a tab that requires CDP → `chrome.debugger.attach({tabId}, "1.3")`. On success, remember `attachedTabs.add(tabId)` (mirrored to `chrome.storage.session`) and show Chrome's "is being debugged" yellow banner — this is expected and unavoidable.
- **On attach failure** (e.g. `chrome://` page, DevTools already open on the tab, or user refused): return `CDP_ATTACH_FAILED`. For tools with a non-CDP fallback (DOM read, `.click()`) we try the fallback transparently; for screenshot/trusted-input we surface the error.
- **Idle detach.** `chrome.alarms.create("debugger-sweep", {periodInMinutes: 1})`. Each fire, detach any tab that hasn't seen CDP activity in **5 minutes**. Idle detach removes the yellow banner while the user is not being driven.
- **Tab-close detach.** `chrome.tabs.onRemoved` → if in `attachedTabs`, no explicit `detach` needed (Chrome cleans up), but remove from `attachedTabs` and clear `refCache` for that tab.
- **User-initiated detach.** `chrome.debugger.onDetach` with `reason === "canceled_by_user"` → emit `debugger_detached` event, drop from `attachedTabs`, do not auto-reattach until next tool call.
- **Navigation.** Debugger session survives navigation. Only the ref cache is invalidated (D6).

### D5. Tab tracking

The opaque `tab_id` (`t_<base36>`) defined in overview §4.1 is minted **by the bridge**, not the extension. The extension receives `tab_id` in every request and maps it to a chrome `tabId` via `tabMap`. Flows:

- **New tab opened by the user.** `chrome.tabs.onCreated` fires → extension emits `{type:"event", name:"tab_created", payload:{chrome_tab_id, url, title}}`. The bridge allocates a `t_*` id and stores the mapping; it then sends an `assign_tab_id` request with `{chrome_tab_id, tab_id}` back. The extension writes it into `tabMap` (mirrored to `storage.session`). This two-step dance keeps id-allocation authority with the bridge (important for the log).
- **New tab opened by a tool call** (`browser.new_tab`). Handler calls `chrome.tabs.create`, returns `{chrome_tab_id}`, and the bridge does the id allocation as above.
- **Tab closed.** `chrome.tabs.onRemoved` → emit `tab_closed` with the mapped `tab_id` if one exists; drop from `tabMap`; clear `refCache[tab_id]`; remove from `attachedTabs`.
- **Navigation.** `chrome.webNavigation.onCommitted` (main frame only) → emit `page_navigated` with `{tab_id, url, transition_type}`, invalidate refs. `onCompleted` (main frame only) → emit `page_loaded` with `{tab_id, url}`.
- **Request targets unknown tab.** Router checks `tabMap[tab_id]`; missing → `TAB_NOT_FOUND`.

### D6. Ref cache

Per-tab, one active snapshot at a time.

```ts
type RefCache = Map<tab_id, {
  snapshotId: string;                  // UUID, echoed in read response
  takenAt: number;                     // ms epoch
  url: string;                         // invalidate if current url differs
  refs: Map<number, {
    backendNodeId?: number;            // CDP
    cssPath?: string;                  // content-script fallback
    role: string;
    name: string;
  }>;
}>;
```

- Populated by the `read` handler after it builds the snapshot (algorithm lives in `05-element-refs.md`).
- Mirrored to `chrome.storage.session` under key `refCache:<tab_id>` on every update; SW revive restores from there.
- **Invalidation triggers** (in order of authority):
  1. `webNavigation.onCommitted` main-frame → drop.
  2. Subsequent `read` call on the same tab → overwrite with new `snapshotId`.
  3. Tab closed → drop.
  4. Stale-URL check at resolution time: if `refs.url !== currentTabUrl` when resolving, return `REF_STALE` defensively.
- Ref lookup: missing tab entry → `REF_STALE`; ref id not in `refs` → `REF_NOT_FOUND`.

### D7. Options page and popup

**`options.html`** — bare form:
- Connection status indicator (green/red dot, last-connect timestamp).
- Bridge URL field (default `ws://127.0.0.1:8765/`, rarely changed).
- Token paste field with `type="password"` + "show" toggle; saves to `chrome.storage.local.token` on blur.
- "Reconnect now" button → messages SW to close+reopen WS.
- Line explaining: "Paste the token from `~/.browserops/token`".

**`popup.html`** (toolbar icon) — three things:
1. Big red **Kill switch** button → messages SW to close WS; WS remains closed until user clicks "Reconnect" in options or the popup. While killed, badge shows "OFF".
2. Current status ("connected", "idle 00:12", "reconnecting in 2s").
3. Count of attached-debugger tabs with a "Detach all" link.

No per-action confirmation UI in v1 — the risky-action confirmation flow (overview §6) is on the bridge side and surfaces through Claude Code, not the extension. The extension's only user-visible safety surface is the kill switch.

### D8. Deterministic extension id via `key`

Procedure:

1. Generate once: `openssl genrsa 2048 > dev-key.pem`.
2. Extract pubkey: `openssl rsa -in dev-key.pem -pubout -outform DER | openssl base64 -A`. This is the `key` value.
3. Commit the public value in `manifest.json`. **Do not** commit `dev-key.pem`.
4. Chrome derives the extension id from the first 32 hex nibbles of `sha256(pubkey_der)`, each remapped a–p (0→a, 1→b, …, f→p). Record this id in a constant consumed by `01-mcp-server.md`.

This keeps the bridge's origin allowlist static: dev, CI, and every contributor's `load unpacked` all produce the same id. When we eventually move to the Chrome Web Store, the store issues its own key and we update the constant in both places.

### D9. Security

- **Token.** Stored in `chrome.storage.local` (not `sync`, not `session`) so it survives SW eviction and browser restarts but does not sync across profiles. Never logged. Never sent to any endpoint except the first WS handshake frame.
- **Log scrubbing.** The extension does **not** write logs — all logging is bridge-side (overview §4.6). If we add a debug console log in the SW, it must `redactToken(frame)` before `console.log`.
- **Sensitive-domain page content.** On URLs matching the risky patterns from overview §6, the extension suppresses any `page_content_snippet` fields in events. The bridge also re-filters; this is defense in depth.
- **Kill switch non-bypassable.** When the user hits kill, we close the WS *and* set a `killed:true` flag in `chrome.storage.session`. The SW refuses to reconnect until the flag is cleared via options-page "Reconnect". Prevents a runaway reconnect loop right after a kill.
- **No remote code.** No `eval`, no remote script tags, no `chrome.scripting.executeScript({files: remoteUrl})`. All scripts are bundled at build time.
- **Debugger scope.** We only ever attach to tabs referenced by an incoming request. We never attach to every tab pre-emptively.

### D10. Build and load

- TypeScript compiled with `esbuild` into `packages/extension/dist/` (`sw.js`, `content.js`, `options.js`, `popup.js`, plus `manifest.json` copied in).
- `scripts/load-unpacked.sh` — hint for developers; no programmatic load.
- Hot-reload during dev: `chrome://extensions` → click reload. No live-reload loop (MV3 makes it fragile; not worth the complexity in v1).

## Risks & mitigations

1. **SW eviction mid-request.** Chrome may kill the SW if an alarm misfires or an async handler awaits for too long. *Mitigation:* 30-s keep-alive alarm (the Chrome ≥120 packed-extension minimum; since Chrome 110 any extension API call resets the SW idle timer, so 30 s is sufficient); long operations (`wait_for`) register progress pings every 10 s; `inflight` persisted to `storage.session` so revival sends terminal error responses for any stranded ids.
2. **`chrome.debugger` yellow banner scares users / user clicks "cancel".** *Mitigation:* lazy attach only on CDP-requiring ops; 5-minute idle detach; popup shows attached-tab count with one-click "Detach all"; we document the banner in README so it's not a surprise.
3. **Origin check vs. non-deterministic extension id.** Without `key` in manifest, reloading unpacked generates a new id, breaking the bridge's origin allowlist. *Mitigation:* commit the `key` pubkey; CI asserts `sha256(key)[:16]` matches the constant in `packages/shared/`.
4. **`chrome://` and Chrome Web Store pages forbid injection and debugger.** *Mitigation:* handlers catch the specific rejection and return `CDP_ATTACH_FAILED`; a read-only DOM fallback is attempted only where safe; docs call out that browser-internal pages are out of scope.
5. **Token leak via console / source maps.** *Mitigation:* `redactToken` helper for every `console.*`; production builds ship without source maps; `chrome.storage.local` values are never embedded in DOM.
6. **Ref cache drift across a single-page-app route change that doesn't trigger `webNavigation.onCommitted`.** *Mitigation:* stale-URL check at resolution time; 60-second TTL on every snapshot as a backstop; emit `page_navigated` also on `chrome.webNavigation.onHistoryStateUpdated` (SPA pushState).
7. **Simultaneous requests racing on the same tab's debugger session.** *Mitigation:* per-tab async mutex around CDP operations; `read` takes a write-lock; click/type serializes behind it. Bridge already serializes per-tab at the rate-limiter layer but we don't rely on that.

## Open questions

1. **`page_loaded` vs. `page_navigated` naming.** Overview §4.2's `Event.name` is free-form; this plan introduces both names. If the bridge wants only one, we can merge them with a `phase: "committed"|"completed"` field — flagging for 02 to confirm.
2. **Chrome minimum version 120.** If the user's Chrome is older, `chrome.storage.session` behavior differs. Is there a floor we need to publish? Suggests coordinating with `07-dev-setup.md`.
3. **Offscreen document for WebSocket.** MV3 `offscreen` API can host a DOM WebSocket that doesn't count toward SW idle. v1 sticks with SW-hosted WS + alarm keep-alive for simplicity, but if eviction proves painful in practice, migrating the WS into an offscreen doc is the known escape hatch. Flag for post-v1.

## Acceptance checklist

- [ ] `packages/extension/manifest.json` present with the exact permissions listed in D1, `key` field populated, `minimum_chrome_version: 120`.
- [ ] `load unpacked` from `packages/extension/dist/` produces the same extension id on three separate machines.
- [ ] Options page accepts a token, stores it in `chrome.storage.local`, and the WS handshake uses it.
- [ ] With bridge running, extension connects within 2 s of load and reconnects with capped backoff after bridge restart.
- [ ] Kill switch in popup closes the WS in ≤100 ms; badge shows "OFF"; requires explicit options-page reconnect.
- [ ] SW survives 10 minutes of idle without losing the WS, proved by a script that queries `chrome.runtime.getContexts` every minute.
- [ ] Cold-start revive rehydrates `tabMap` and `refCache` from `chrome.storage.session` within 200 ms.
- [ ] `read` followed by `click` on the same ref works; navigation between them returns `REF_STALE`.
- [ ] Attaching `chrome.debugger` on an `http(s)` tab succeeds; attaching on `chrome://extensions` returns `CDP_ATTACH_FAILED`.
- [ ] Attached debugger auto-detaches after 5 minutes idle; `debugger_detached` event emitted.
- [ ] Opening, navigating, and closing a tab each emit the corresponding event within 250 ms.
- [ ] No `console.log` in built artifacts contains the raw token (grep check in CI).
- [ ] On a password field, click/type requests still succeed (bridge owns the risky-action gate; extension does not block).
- [ ] Concurrent `click` + `read` on the same tab serialize without CDP "Another instance" errors.
- [ ] Total built extension size under 500 KB (sanity check; alerts on accidental bundling of large deps).
