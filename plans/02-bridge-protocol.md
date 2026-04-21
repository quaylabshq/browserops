# 02 — Bridge ⇄ Extension WebSocket Protocol

## Scope

This plan defines the WebSocket wire protocol between the Node/TS bridge (`packages/bridge/`) and the Chrome MV3 extension (`packages/extension/`). It covers transport choice, bind address, auth handshake, framing, request/response correlation, unsolicited event streams, backpressure, reconnection, version negotiation, and the concrete TypeScript types that both sides will import from `packages/shared/src/protocol.ts`.

It does **not** cover the MCP stdio surface (that's `01-mcp-server.md`), any `chrome.*` API usage or extension internals (that's `03-extension.md`), tool payload shapes (that's `04-tools.md`), or element-ref semantics (`05-element-refs.md`). The envelope, error-code table, and shared-secret posture established in `00-overview.md` §4–§5 are treated as fixed inputs here.

## Inputs from other plans

- `00-overview.md` §4.2 — `Request` / `Response` / `Event` envelope shapes. This plan extends them (adds `hello`, `hello_ack`, `ping`, `pong`) but does not mutate them.
- `00-overview.md` §4.3 — `ErrorCode` enum. This plan is the site that raises `EXTENSION_DISCONNECTED`.
- `00-overview.md` §4.5 — default timeouts (30 s / 45 s / 120 s) used as defaults for `Request.timeout_ms`.
- `00-overview.md` §5 — bind address `127.0.0.1:8765`, shared token at `~/.browser-exp/token`, origin check against the installed extension id.
- `07-dev-setup.md` (TBD) — env-var plumbing for `BROWSER_EXP_PORT`, `BROWSER_EXP_TOKEN_PATH`, `BROWSER_EXP_EXTENSION_ID`.

## Outputs to other plans

- **Typed module** `packages/shared/src/protocol.ts` — the single source of truth for message shapes, imported by both the bridge and the extension. Consumed by 01, 03, 04.
- **Connection-state API** exposed by the bridge: `onConnect`, `onDisconnect`, `sendRequest(method, params, timeout_ms) -> Promise<Result>`, `onEvent(name, handler)`. Consumed by 01 (to implement MCP tool handlers) and 06 (to listen for `extension_paused`).
- **Error semantics.** When the socket drops mid-request, the bridge rejects the pending promise with `EXTENSION_DISCONNECTED`. MCP layer (01) translates that into a tool-call error.
- **Port / token contract.** Install docs in 07 must use the same env var names and file paths documented here.

## Design

### D1. Transport

- **Node (bridge) side:** [`ws`](https://github.com/websockets/ws) v8. Battle-tested, no transitive native deps, supports per-message deflate (already `false` by default — see D3), and cleanly exposes the upgrade request so we can enforce the `Origin` check before accepting.
- **Extension side:** the global `WebSocket` constructor available in the MV3 service worker. No extra dependency. Note: WebSocket connections from an MV3 service worker are not subject to `host_permissions`; no `<all_urls>` is needed for the WS connection itself.
- **Direction:** the **extension is the client**, the **bridge is the server**. This matters because (a) the bridge boots first and outlives the extension's service-worker lifecycle, (b) extensions cannot reliably bind listening sockets, and (c) the extension already has a natural "reconnect" story via service-worker wakeups.
- **Bind address:** `127.0.0.1:8765` by default. Configurable via env var `BROWSER_EXP_PORT`. The bridge **must** pass `host: "127.0.0.1"` to `new WebSocketServer({ host, port })` — never `0.0.0.0`, never omitted (Node's default is all-interfaces). A startup assertion logs the bound address and aborts if it resolves to anything non-loopback.
- **Origin check.** Enforced on the HTTP `upgrade` event **before** `handleUpgrade` (per overview §5) — not after `'connection'`, which would mean the handshake has already completed. Construct the `WebSocketServer` with `noServer: true` and wire it up like:
  ```js
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.origin !== expectedOrigin) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  ```
  `expectedOrigin` must exactly equal `chrome-extension://<BROWSER_EXP_EXTENSION_ID>`. The extension id is baked into the bridge via env var (set by the install script once the user loads the unpacked extension and pastes its id).
- **TLS.** None. Loopback only. Adding TLS would force the extension to trust a self-signed cert, which is worse UX than the current shared-secret + origin-pin model.

### D2. Handshake

Three-step lifecycle before normal traffic:

1. **TCP + WS upgrade.** Bridge accepts only if `Origin` matches (above). Otherwise 403, no WS established.
2. **`hello` from extension (first frame after open).** The extension must send, as its very first frame, exactly one JSON object:
   ```ts
   { type: "hello", token: "<contents of ~/.browser-exp/token>", extension_version: "0.3.1" }
   ```
   The bridge arms a 5-second timer on `open`; if no `hello` arrives in that window it closes with code **4003** (`HELLO_TIMEOUT`).
3. **`hello_ack` from bridge.** On valid token + compatible protocol:
   ```ts
   { type: "hello_ack", bridge_version: "0.3.1", protocol_version: 1, server_time_ms: 1745226000000 }
   ```
   Only after `hello_ack` is sent does the bridge mark the connection as "ready" and start dispatching queued `Request`s.

Close codes (all in the application-reserved 4000–4999 range):

| Code | Name | When |
|---|---|---|
| 4001 | `BAD_TOKEN` | Token in `hello` does not match the file on disk. |
| 4002 | `PROTOCOL_MISMATCH` | Extension's `protocol_version` is outside the compat window (see D7). |
| 4003 | `HELLO_TIMEOUT` | No `hello` within 5 s of socket open. |
| 4004 | `BAD_HELLO` | First frame was not a valid `hello` (wrong `type`, missing fields, unparseable). |
| 4005 | `SUPERSEDED` | A newer extension connected; old socket is closed. Only one connection allowed at a time. |
| 4006 | `USER_DISCONNECT` | User-initiated kill switch from the extension (toolbar icon / popup). |
| 4008 | `BACKPRESSURE_ABORT` | Bridge killed the connection because the receive queue overflowed (see D5). |
| 1000 | normal | Clean shutdown from either side. |

The bridge enforces **single-connection invariant**: if an extension connects while another is already `ready`, the existing one is closed with 4005 and the new one becomes the active connection. This handles the MV3 service-worker restart case cleanly.

### D3. Framing

**Decision: one JSON document per WebSocket text frame.** Not NDJSON inside a single frame — one frame, one doc. The `ws` library and browser `WebSocket` both expose message boundaries; we use them.

Reasoning: NDJSON would be the right call over a raw TCP stream, but WebSocket already frames for us, and a "many JSON docs per frame" convention forces both sides to re-implement line splitting (and guess whether a trailing `\n` is required). Using one doc per frame makes the code simpler and keeps each screenshot a discrete message the runtime can stream.

**Compression.** `ws` v8 server-side `perMessageDeflate` is already `false` by default; we leave it explicitly disabled for clarity. The extension's native `WebSocket` never enables it. Screenshots are the biggest payloads and they're already PNG-compressed; deflate doesn't help, and it adds CPU on the extension side where service-worker budget matters.

**Max frame size.** `maxPayload: 16 * 1024 * 1024` (16 MiB). Justification: a full-page 4K screenshot PNG base64-encodes to ~10 MiB worst case. 16 MiB gives headroom for a11y snapshots of very large pages too. Oversized frames are rejected by `ws` (it closes with 1009), and the bridge surfaces that as `EXTENSION_DISCONNECTED` to any pending requests.

**Binary frames.** Not used in v1. If we ever need them (e.g. to skip base64 on screenshots), it's a `protocol_version` bump.

**Liveness.** The bridge sends a WebSocket ping (control frame, not a JSON `ping`) every 20 s. The extension's `WebSocket` auto-responds with pong. If no pong within 10 s, the bridge closes with 1011 and lets the extension reconnect. We do **not** use JSON-level `ping`/`pong` messages; the protocol-level ones are sufficient and don't contend with application traffic.

### D4. Request / response correlation

- Every `Request.id` is a UUIDv4 generated by the bridge (`crypto.randomUUID()`).
- The bridge keeps an in-memory `Map<id, Pending>` where `Pending = { resolve, reject, timer, method, startedAt }`.
- On every `Request` send, the bridge arms `setTimeout(timeout_ms)` that rejects the pending with `TIMEOUT` (per §4.3) and **removes it from the map** so the late response is ignored.
- When a `Response` arrives:
  - If `id` is in the map: clear the timer, resolve or reject based on `ok`, delete the entry.
  - If `id` is **not** in the map (orphan): log at `warn` level (`{dir:"ws_in", orphan:true, id}`), drop the message, do not close the socket. Orphans happen naturally after a timeout already fired, and killing the connection for a benign race is worse than dropping.
- On socket close, walk the `Pending` map and reject every entry with `EXTENSION_DISCONNECTED`. Clear the map before the `reconnect` event fires so stale requests can't leak across reconnects.

Extension-side mirror: the extension keeps a small set of "in-flight handler tasks" keyed by `id`, so if the socket drops while a handler is still running (e.g. awaiting a `chrome.debugger` round-trip), it can abort and not emit a response into a dead socket.

### D5. Event stream & backpressure

Events are fire-and-forget from the extension. The bridge cannot reply. Consumer APIs in the bridge (`onEvent`) are synchronous callbacks.

**Event catalogue (v1).** Payload shapes are frozen here; additions are a minor `protocol_version` bump.

```ts
// "tab_created" — a new Chrome tab appeared.
{
  name: "tab_created",
  payload: {
    tab_id: string;            // t_<base36>
    chrome_tab_id: number;     // raw chrome.tabs id, for debug only
    opener_tab_id: string | null;
    url: string;               // may be "about:blank"
    title: string;
    ts_ms: number;
  }
}

// "tab_closed"
{
  name: "tab_closed",
  payload: { tab_id: string; ts_ms: number }
}

// "tab_updated" — title or URL changed *without* a full navigation
// (e.g. SPA route, document.title assignment).
{
  name: "tab_updated",
  payload: {
    tab_id: string;
    url: string | null;        // null = unchanged
    title: string | null;      // null = unchanged
    ts_ms: number;
  }
}

// "page_loaded" — `load` event fired in the top frame.
{
  name: "page_loaded",
  payload: {
    tab_id: string;
    url: string;
    status_code: number | null;  // best-effort via webRequest; null if unknown
    ts_ms: number;
  }
}

// "page_navigated" — committed navigation in the top frame.
// Always precedes "page_loaded" for the same URL.
{
  name: "page_navigated",
  payload: {
    tab_id: string;
    url: string;
    transition_type: string;   // chrome.webNavigation TransitionType
    ts_ms: number;
  }
}

// "extension_paused" — user clicked the kill-switch icon or the popup
// confirmation was declined.
{
  name: "extension_paused",
  payload: { reason: "user_toolbar" | "confirmation_denied" | "rate_limit"; ts_ms: number }
}

// "extension_resumed" — user re-enabled after a pause.
{
  name: "extension_resumed",
  payload: { ts_ms: number }
}
```

**Backpressure.** The bridge maintains a bounded **receive queue** (applied uniformly to events and responses) with `maxQueue = 1024` messages. Policy:

- Under `maxQueue`: normal processing, O(1) dispatch.
- At 80% (`816`) of `maxQueue`: the bridge logs a `warn` and starts sampling events — specifically, for the high-volume events `tab_updated` and `page_navigated`, it coalesces consecutive events for the same `tab_id` within a 250 ms window into the last one. Responses are **never** dropped.
- At 100%: the bridge closes the socket with code `4008` (`BACKPRESSURE_ABORT`) and lets the extension reconnect (fresh queue). This is a hard failsafe, not the expected path. An alert fires in the log.

**Socket-level write backpressure.** Node-side `ws.send()` returns `false` when the underlying socket buffer is full; listen for the `'drain'` event or check `ws.bufferedAmount` before sending more. Extension-side browser `WebSocket` exposes only `.bufferedAmount` (no `drain` event) — the extension polls it with an interval before flushing queued messages.

The extension has its own bounded **send queue** (256 messages, FIFO). If events are produced faster than the socket can drain (shouldn't happen over loopback, but possible during MV3 service-worker throttling), it drops the oldest `tab_updated`/`page_navigated` first, then oldest events of any kind, and **never** drops `Response` messages or `extension_paused`/`extension_resumed`. A dropped-event counter is attached to the next `Response` as a debug header — see `meta.dropped_events`:

```ts
type Response = {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: ErrorCode; message: string; details?: unknown };
  meta?: { dropped_events?: number };   // canonical in overview §4.2
};
```

### D6. Reconnection

**Extension reconnect strategy** (the extension owns reconnect, because it's the client):

- Exponential backoff with full jitter: `delay = random(0, min(cap, base * 2^attempt))`, `base = 500 ms`, `cap = 15 s`.
- Reset `attempt` to 0 once a `hello_ack` is received and the connection has been stable for ≥ 10 s.
- No maximum attempt count — keep trying forever. A paused bridge is the user's concern; silently giving up is worse.
- Before each attempt, re-read the token from storage (user may have rotated it), re-read the port from `chrome.storage.local`.
- MV3 service-worker wakeups: the background script registers `chrome.runtime.onStartup` and `chrome.alarms.create({ periodInMinutes: 0.5 })` to keep itself alive enough to drive reconnects. Full detail is the extension's problem (plan 03), but this plan constrains it: the extension must be reconnecting within 5 s of a worker wakeup.

**In-flight request behavior on drop.**

- Bridge walks `Pending`, rejects each with `{ code: "EXTENSION_DISCONNECTED", message: "socket closed mid-request" }`. The MCP layer (01) translates that into a tool-call error with the same code.
- No automatic retry. The extension may complete a side-effect (e.g. the click landed) before the socket closed; retrying could double-click. Claude is responsible for retrying at its own discretion based on the error.
- Events emitted during a disconnect window are **lost**. We do not buffer unsent events on the extension side across a socket drop (other than the 256-slot send queue, which is flushed on close). This is intentional: stale tab-update events from 30 s ago aren't useful.

### D7. Versioning

`protocol_version` is a single monotonically increasing integer starting at `1`. It lives in `hello_ack` and in `packages/shared/src/protocol.ts` as a const.

Compatibility rules:

- **Minor, additive change** (new event name, new optional field, new error code): **same** `protocol_version`. Both sides ignore unknown fields (structural widening). The extension tolerates unknown event names coming from itself-older bridges by… being the event producer, so this direction is moot. The bridge tolerates unknown event names from newer extensions by logging at `debug` and dropping (no `onEvent` handler fires).
- **Breaking change** (renamed field, changed semantics, removed error code): bump `protocol_version`. The bridge keeps a small `SUPPORTED_PROTOCOL_VERSIONS: Set<number>` (e.g. `{1, 2}` during a transition). If the extension's hello declares a version outside the set, close with 4002.
- The extension declares the protocol version it was built against by including `protocol_version: number` in its `hello` (canonical in overview §4.2).

### D8. Concrete TypeScript types (ship in `packages/shared/src/protocol.ts`)

```ts
// ---------- shared constants ----------
export const DEFAULT_PORT = 8765;
export const DEFAULT_HOST = "127.0.0.1";
export const PROTOCOL_VERSION = 1 as const;
export const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<number> = new Set([1]);
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const HELLO_TIMEOUT_MS = 5_000;
export const PING_INTERVAL_MS = 20_000;
export const PONG_TIMEOUT_MS = 10_000;
export const MAX_RECEIVE_QUEUE = 1024;
export const MAX_SEND_QUEUE = 256;

// ---------- close codes ----------
export const CLOSE_BAD_TOKEN = 4001;
export const CLOSE_PROTOCOL_MISMATCH = 4002;
export const CLOSE_HELLO_TIMEOUT = 4003;
export const CLOSE_BAD_HELLO = 4004;
export const CLOSE_SUPERSEDED = 4005;
export const CLOSE_USER_DISCONNECT = 4006;
export const CLOSE_BACKPRESSURE_ABORT = 4008;

// ---------- error codes (must match overview §4.3) ----------
export type ErrorCode =
  | "TAB_NOT_FOUND"
  | "REF_STALE"
  | "REF_NOT_FOUND"
  | "TIMEOUT"
  | "NAVIGATION_IN_PROGRESS"
  | "CDP_ATTACH_FAILED"
  | "FRAME_UNREACHABLE"
  | "RATE_LIMITED"
  | "RISKY_ACTION_DENIED"
  | "EXTENSION_DISCONNECTED"
  | "INVALID_PARAMS"
  | "INTERNAL";

// ---------- handshake ----------
export interface Hello {
  type: "hello";
  token: string;
  extension_version: string;
  protocol_version: number;     // extension of overview envelope
}

export interface HelloAck {
  type: "hello_ack";
  bridge_version: string;
  protocol_version: number;
  server_time_ms: number;
}

// ---------- request / response (conform to overview §4.2) ----------
export interface Request {
  type: "request";
  id: string;                   // UUIDv4
  method: string;
  params: Record<string, unknown>;
  timeout_ms: number;
}

export interface ResponseMeta {
  dropped_events?: number;
}

export interface ResponseOk {
  type: "response";
  id: string;
  ok: true;
  result: unknown;
  meta?: ResponseMeta;
}

export interface ResponseErr {
  type: "response";
  id: string;
  ok: false;
  error: { code: ErrorCode; message: string; details?: unknown };
  meta?: ResponseMeta;
}

export type Response = ResponseOk | ResponseErr;

// ---------- events ----------
export type Event =
  | { type: "event"; name: "tab_created";      payload: TabCreatedPayload }
  | { type: "event"; name: "tab_closed";       payload: TabClosedPayload }
  | { type: "event"; name: "tab_updated";      payload: TabUpdatedPayload }
  | { type: "event"; name: "page_loaded";      payload: PageLoadedPayload }
  | { type: "event"; name: "page_navigated";   payload: PageNavigatedPayload }
  | { type: "event"; name: "extension_paused"; payload: ExtensionPausedPayload }
  | { type: "event"; name: "extension_resumed";payload: ExtensionResumedPayload };

export interface TabCreatedPayload {
  tab_id: string; chrome_tab_id: number; opener_tab_id: string | null;
  url: string; title: string; ts_ms: number;
}
export interface TabClosedPayload { tab_id: string; ts_ms: number; }
export interface TabUpdatedPayload {
  tab_id: string; url: string | null; title: string | null; ts_ms: number;
}
export interface PageLoadedPayload {
  tab_id: string; url: string; status_code: number | null; ts_ms: number;
}
export interface PageNavigatedPayload {
  tab_id: string; url: string; transition_type: string; ts_ms: number;
}
export interface ExtensionPausedPayload {
  reason: "user_toolbar" | "confirmation_denied" | "rate_limit"; ts_ms: number;
}
export interface ExtensionResumedPayload { ts_ms: number; }

// ---------- union of everything that crosses the wire ----------
export type WireMessage = Hello | HelloAck | Request | Response | Event;

// ---------- type guards (implementations live in the same file) ----------
export function isResponse(m: WireMessage): m is Response { return m.type === "response"; }
export function isEvent(m: WireMessage): m is Event { return m.type === "event"; }
```

### D9. Bridge-side connection-manager pseudocode

```
// Origin is already enforced on the HTTP 'upgrade' event before handleUpgrade;
// by the time we're here the handshake has succeeded and the Origin was valid.
on WebSocketServer.connection(ws, req):
  state = "awaiting_hello"
  helloTimer = setTimeout(5s, () => ws.close(4003))
  ws.on("message", onFrame)

onFrame(raw):
  if raw.byteLength > MAX_FRAME_BYTES: ws.close(1009); return
  msg = JSON.parse(raw)           // on throw: ws.close(4004)
  switch (state):
    case "awaiting_hello":
      if msg.type !== "hello": ws.close(4004); return
      if msg.token !== diskToken: ws.close(4001); return
      if !SUPPORTED.has(msg.protocol_version): ws.close(4002); return
      clearTimeout(helloTimer)
      if activeSocket: activeSocket.close(4005)
      activeSocket = ws; state = "ready"
      ws.send(makeHelloAck()); drainQueuedRequests()
    case "ready":
      if msg.type === "response": routeResponse(msg)
      else if msg.type === "event": enqueueEvent(msg)
      else: log warn, ignore
```

## Risks & mitigations

1. **Another local process squats on 8765.** Mitigation: on bind failure, probe +1/+2/+3 up to 8770, pick the first free port, and write the chosen port to `~/.browser-exp/port` for the extension to read on next connect attempt.
2. **Token exfiltration by a malicious local process.** The token file is world-readable by default on macOS. Mitigation: `fs.chmod(tokenPath, 0o600)` on write, verify mode on read, refuse to start if it's group/other-readable. Combined with the origin pin, exfiltration requires also spoofing the extension id in the Origin header, which a non-extension process cannot do against a real Chrome (Chrome sets the header, not the extension).
3. **MV3 service worker gets evicted mid-request.** Mitigation: `chrome.alarms` at 30 s to keep it warm, plus the reconnect loop. In-flight requests reject with `EXTENSION_DISCONNECTED` (D6) — Claude retries at its discretion. We accept occasional spurious failures rather than persisting a request queue across worker deaths (that would risk double-executing side effects).
4. **Orphan responses after a timeout.** Mitigation: D4 policy — drop-and-log, don't tear down the connection. The alternative (close on orphan) would amplify transient issues into long reconnect storms.
5. **Max-frame-size underestimate for giant a11y snapshots.** Mitigation: the `read` tool (plan 04) must paginate results if they exceed ~8 MiB serialized; the 16 MiB ceiling is a hard cap, not a target. Over-cap payloads fail with `INTERNAL` and a helpful message, never silently truncate.
6. **Single-connection invariant causes flapping during rapid extension reloads.** Mitigation: 4005 (`SUPERSEDED`) is explicitly a "clean takeover" close code; the old socket's in-flight requests reject with `EXTENSION_DISCONNECTED` exactly once, and the new socket starts fresh. Add a 500 ms grace period where the bridge ignores a second `hello` from the same extension id to dampen duplicate-connect bugs.

## Open questions

- All envelope types and close codes are canonical in overview §4.2 and §4.3.1; this plan mirrors them.
- **Should `extension_paused` be a `Response` field instead of an event?** If Claude tries to act during a pause, is a per-request `RISKY_ACTION_DENIED` enough? Current design keeps it as an event so the MCP layer can reject immediately without a round-trip.
- **Log rotation.** `~/.browser-exp/log.jsonl` growth is not bounded by this plan. Belongs in 07.
- **Port-probing fallback (Risk 1).** Does the extension poll `~/.browser-exp/port` on every reconnect, or is the port pinned at install time? Leaning toward poll-on-every-reconnect; confirm with 03.
- **Do we ever need server-pushed requests from the bridge to initiate a `hello` re-auth** (e.g. after token rotation)? Not in v1; deferred.

## Acceptance checklist

- [ ] `packages/shared/src/protocol.ts` exists and exports every type / constant listed in D8, with no `any`.
- [ ] Bridge binds to `127.0.0.1:8765` (or env-overridden port), rejects `0.0.0.0`, and logs the bound address on startup.
- [ ] Bridge 403s any upgrade whose `Origin` header doesn't match `chrome-extension://<BROWSER_EXP_EXTENSION_ID>`; unit-tested with a raw HTTP request.
- [ ] Handshake: valid `hello` → `hello_ack`; bad token → close 4001; bad protocol_version → 4002; no hello in 5 s → 4003; malformed first frame → 4004; second connect while one is active → old closes 4005.
- [ ] Request/response: a 100-request round-trip test completes with correct `id` correlation, no orphans, all within budget.
- [ ] Timeout: a request with `timeout_ms: 200` against a handler that sleeps 500 ms rejects with `TIMEOUT`, and the late response is logged as an orphan and dropped (not crashing the bridge).
- [ ] Mid-request disconnect: killing the extension process mid-request rejects the pending promise with `EXTENSION_DISCONNECTED` within 1 s.
- [ ] Ping liveness: with pong responses blocked, the bridge closes the socket within `PING_INTERVAL_MS + PONG_TIMEOUT_MS + 1 s`.
- [ ] Max frame: a 20 MiB payload is rejected by `ws` and surfaces as `EXTENSION_DISCONNECTED`; a 15 MiB payload round-trips successfully.
- [ ] Reconnect: killing and restarting the extension results in a new `hello_ack` within 3 s (on the first attempt; backoff is tested separately).
- [ ] Event stream: each of the seven event names fires with the documented payload shape; TypeScript compilation proves exhaustiveness via a `switch` on `name`.
- [ ] Backpressure: synthetic flood of 10 000 `tab_updated` events does not OOM the bridge; coalescing at 80% queue depth is observable in logs; 4008 fires only when the flood exceeds the hard cap.
- [ ] `protocol_version` bump in a branch causes the extension to be rejected with close code 4002; the test is wired into CI.
