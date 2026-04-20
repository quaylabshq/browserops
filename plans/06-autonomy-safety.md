# 06 — Autonomy & Safety

> Exact design of the autonomy/safety layer: rate limiter, risky-action heuristic, confirmation UX, kill-switch, and audit logging. These are the hooks that sit between the bridge accepting an MCP tool call and actually forwarding it to the extension, plus the extension-side UI that backs confirmation and disconnect.

---

## 1. Scope

This plan covers:

- The per-tab token-bucket rate limiter in the bridge process.
- A secondary global cap across all tabs (second failsafe).
- The `isRisky(tool, params, tab)` heuristic and its configurable sensitive-domain list.
- The confirmation UX surfaced by the extension popup + browser notification + toolbar badge.
- The kill-switch (toolbar right-click → Disconnect) and reconnection flow.
- The `~/.browser-exp/log.jsonl` audit log: schema hooks, levels, truncation policy.
- Where the bridge (plan 01) and extension (plan 03) invoke these primitives.

Out of scope: tool schemas themselves (plan 04), ref resolution (plan 05), MCP/WS transport (plans 01/02), and the extension's UI scaffolding beyond the confirmation modal (plan 03). This plan does not introduce new error codes beyond those already declared in `00-overview.md §4.3`.

---

## 2. Inputs from other plans

- **00-overview §4.2** — `Request`/`Response`/`Event` envelopes. Safety decisions surface as `Response.error`.
- **00-overview §4.3** — error codes used here: `RATE_LIMITED`, `RISKY_ACTION_DENIED`, `EXTENSION_DISCONNECTED`. Note: overview §4.3 also includes `FRAME_UNREACHABLE`; the safety layer does not emit `FRAME_UNREACHABLE` — that's an extension-layer condition.
- **00-overview §4.6** — base log format for `log.jsonl`.
- **00-overview §6** — policy decisions this plan concretizes.
- **04-tools.md** — per-tool `action_weight` (drives rate-limit cost) and the set of tool names used by the risky-action heuristic (`browser.execute_js`, `browser.click`, `browser.type`, form-submit variants).
- **05-element-refs.md** — the ref registry exposes element metadata (role, accessible name, DOM type attribute) that `isRisky` reads synchronously when available.
- **03-extension.md** — provides a `safety:prompt` IPC channel from background service worker to the popup, and the toolbar badge / right-click menu wiring that the kill-switch uses.

---

## 3. Outputs to other plans

- **To 01 (bridge):** `RateLimiter` class and `Safety` facade with `tryConsume(tab_id, weight)`, `checkRisky(tool, params, tab)`, and `awaitConfirmation(decisionId)`. Called before forwarding any `Request` to the WS.
- **To 03 (extension):** a required `safety_prompt` inbound WS `Request` (bridge → ext) and a `safety_decision` outbound WS `Response` (ext → bridge). `safety_decision` is a `Response` (overview §4.2) to the `safety_prompt` Request — shares the same `id`, carries `result: { decision_id, allow: boolean }`. It is NOT an Event. Plus the `Disconnect` toolbar action that closes the WS with code `4006` (overview §4.3.1 reserves 4006 for user-initiated kill switch; 4003 is reserved for Hello timeout).
- **To 08 (testing):** deterministic hooks for time (`now()` injectable), clock-skew tests for the token bucket, and a CLI env var `BROWSER_EXP_AUTOCONFIRM=allow|deny` used in e2e fixtures.

---

## 4. Design

### 4.1 Rate limiter (per-tab)

**Algorithm.** Continuous token bucket. Each tab has an independent bucket.

- `capacity = 16` tokens.
- `refill_rate = 16 / 60` tokens/second (≈ 0.2667 tok/s), continuous — not stepped every minute.
- Token cost = `action_weight` from `04-tools.md` (e.g. `read`/`screenshot` = 0.5, `click`/`type`/`navigate` = 1, `execute_js` = 1).
- The bucket is created lazily on first call for a tab and destroyed when the tab closes (bridge listens for the `tab_closed` event from plan 03).

**Math.** On every `tryConsume` call:

1. `elapsed = now() - lastRefillAt`
2. `tokens = min(capacity, tokens + elapsed * refill_rate)`
3. `lastRefillAt = now()`
4. If `tokens >= weight`: `tokens -= weight`; return `{ ok: true }`.
5. Else: compute `deficit = weight - tokens`; `retry_after_ms = ceil(deficit / refill_rate * 1000)`; return `{ ok: false, retry_after_ms }`.

**On exhaustion.** Bridge synthesizes a `Response` with:

```ts
{ ok: false, error: { code: "RATE_LIMITED",
  message: "per-tab budget exhausted",
  details: { tab_id, retry_after_ms, scope: "tab" } } }
```

**TypeScript pseudocode (bridge):**

```ts
// packages/bridge/src/safety/rateLimiter.ts
export type ConsumeResult =
  | { ok: true }
  | { ok: false; retry_after_ms: number; scope: "tab" | "global" };

class Bucket {
  tokens: number;
  lastRefillAt: number;
  constructor(readonly capacity: number, readonly refillPerSec: number, now: number) {
    this.tokens = capacity;
    this.lastRefillAt = now;
  }
  refill(now: number) {
    const elapsed = (now - this.lastRefillAt) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefillAt = now;
  }
  tryConsume(weight: number, now: number): ConsumeResult {
    this.refill(now);
    if (this.tokens >= weight) {
      this.tokens -= weight;
      return { ok: true };
    }
    const deficit = weight - this.tokens;
    return {
      ok: false,
      retry_after_ms: Math.ceil((deficit / this.refillPerSec) * 1000),
      scope: "tab",
    };
  }
}

export class RateLimiter {
  private perTab = new Map<string, Bucket>();
  private global: Bucket;
  constructor(
    private readonly perTabCap = 16,
    private readonly perTabRefill = 16 / 60,
    globalCap = Number(process.env.BROWSER_EXP_GLOBAL_CAP ?? 60),
    private readonly now: () => number = () => Date.now()
  ) {
    this.global = new Bucket(globalCap, globalCap / 60, now());
  }
  tryConsume(tabId: string, weight: number): ConsumeResult {
    const t = this.now();
    let b = this.perTab.get(tabId);
    if (!b) {
      b = new Bucket(this.perTabCap, this.perTabRefill, t);
      this.perTab.set(tabId, b);
    }
    const perTab = b.tryConsume(weight, t);
    if (!perTab.ok) return perTab;
    const glob = this.global.tryConsume(weight, t);
    if (!glob.ok) {
      // refund the per-tab consumption so a global denial doesn't double-charge
      b.tokens += weight;
      return { ok: false, retry_after_ms: glob.retry_after_ms, scope: "global" };
    }
    return { ok: true };
  }
  dropTab(tabId: string) { this.perTab.delete(tabId); }
}
```

**Optimization note.** Check global bucket first, then per-tab; on failure at either step, no refund is needed. The pseudocode above does per-tab first with refund; both are correct, global-first is marginally simpler.

### 4.2 Global limiter

A second bucket with the same algorithm, shared across all tabs. Default `capacity = 60`, `refill = 60/60 = 1 tok/s`. Tunable via env `BROWSER_EXP_GLOBAL_CAP`. Rationale: per-tab alone doesn't protect against a runaway that fans out across 10 tabs. On denial, `error.details.scope = "global"`; Claude gets the same `RATE_LIMITED` code.

### 4.3 Risky-action heuristic

Single function, pure where possible, reads element metadata from the ref registry (plan 05) and the sensitive-domain list loaded at bridge startup.

**Signature.**

```ts
// packages/bridge/src/safety/risky.ts
export interface RiskCheckInput {
  tool: string;                 // full tool name, e.g. "browser.click"
  params: Record<string, unknown>;
  tab: { url: string; id: string };
  refMeta?: {                   // resolved by ref registry (plan 05)
    role?: string;              // ARIA role
    accessibleName?: string;
    domType?: string;           // for <input type="...">
  };
}
export type RiskVerdict =
  | { risky: false }
  | { risky: true; reason: string; ruleId: string };

export function isRisky(input: RiskCheckInput, cfg: SafetyConfig): RiskVerdict;
```

**Rules (evaluated in order; first match wins).**

1. **R1 — `execute_js` is always risky.** `tool === "browser.execute_js"` → `{ risky: true, ruleId: "R1-execute-js" }`.
2. **R2 — password typing.** `tool === "browser.type"` AND `refMeta?.domType === "password"` → `{ risky: true, ruleId: "R2-password-input" }`. Skipped if `cfg.optOutPasswordPrompt === true` (set via options page).
3. **R3 — sensitive-domain submit.** For `browser.click` where the target ref's role is button AND accessible name matches the submit-word regex `/^(send|submit|buy|purchase|pay|delete|remove|transfer|confirm)$/i` AND `tab.url` matches the sensitive-domain list; OR for `browser.type` where `params.submit === true` AND the tab's current URL matches the sensitive-domain list → `{ risky: true, ruleId: "R3-sensitive-submit" }`.

All other cases: `{ risky: false }`.

**Sensitive-domain list.** Built-in starter patterns (matched against the host, case-insensitive; glob only — no regex, no substring. Leading `*.` = any subdomain. No other wildcards):

```
["*.chase.com","*.bankofamerica.com","*.wellsfargo.com","*.citibank.com",
 "paypal.com","*.paypal.com","venmo.com","*.venmo.com",
 "1password.com","bitwarden.com","*.coinbase.com","robinhood.com"]
```

Users extend via `~/.browser-exp/risky-domains.json`. Glob only — no regex, no substring. Leading `*.` = any subdomain. No other wildcards.

User overrides live in `~/.browser-exp/risky-domains.json`:

```json
{ "add": ["brokerage.example.com"], "remove": ["venmo.com"] }
```

Loaded once at bridge startup; `SIGHUP` re-reads. Malformed file → log + fall back to built-in.

### 4.4 Confirmation UX

When `isRisky` returns `risky: true`, the bridge:

1. Assigns a fresh `decision_id` (UUIDv4).
2. Sends a `safety_prompt` request over WS to the extension:
   ```ts
   { type: "request", method: "safety_prompt", id: decision_id, params: {
       tool, params, reason, ruleId, tab_id, tab_url, tab_title } }
   ```
3. Parks the originating MCP call in a pending-promise map keyed by `decision_id`, with a 30 s timer.
4. The extension background worker, on `safety_prompt`:
   - Sets toolbar action badge text to `"!"` with red background on that tab.
   - Stores the pending decision in `chrome.storage.session`.
   - Fires a `chrome.notifications.create` with the tool + tab title.
   - If the popup is open, pushes a `safety:prompt` runtime message; otherwise the popup reads `chrome.storage.session` on open.
5. Popup renders a modal: tool name, serialized params (JSON, truncated at 1 kB per field), tab title, URL, rule reason, and two buttons — **Allow** / **Deny**. No "always allow" option. Decisions are per-call.
6. User click sends `safety_decision` (`{ decision_id, allow: boolean }`) over WS.
7. Bridge resolves the parked promise. On `allow`, forwards the original `Request` to the extension exactly as if it had passed through unprompted. On `deny` (or 30 s timeout), returns:
   ```ts
   { ok: false, error: { code: "RISKY_ACTION_DENIED",
     message: "risky action denied", details: { ruleId, reason, tab_id, timeout: boolean } } }
   ```
8. On decision (either way), the badge is cleared. Notification is cleared on popup close.

**Explicit anti-features.**

- No "remember this domain" / "always allow". Every risky action re-prompts. Reason: risky actions are by definition financial/auth, where silent re-consent is the failure mode we're avoiding.
- No auto-allow on user activity in the tab. The human must interact with the popup.

**Test hook.** Env var `BROWSER_EXP_AUTOCONFIRM=allow|deny` short-circuits step 2–6 (bridge resolves immediately) — used by e2e only; the bridge logs a warning line on startup if set. When autoconfirm is enabled, the bridge writes a startup warning to **stderr** (stdout is reserved for MCP JSON-RPC; anything on stdout corrupts the MCP stream).

### 4.5 Kill switch

- Toolbar icon right-click exposes a "Disconnect" context-menu item (registered via `chrome.contextMenus` scoped to the action). Left-click opens the popup as normal.
- Clicking "Disconnect":
  1. Service worker calls `ws.close(4006, "user disconnect")`.
  2. Sets `chrome.storage.local.connected = false` so reconnection requires an explicit action.
  3. Updates badge to `"off"` with a gray background.
- Bridge on `close` event with code `4006` (or any close):
  - Rejects every entry in the pending-request map with `{ code: "EXTENSION_DISCONNECTED", message: "extension disconnected" }`.
  - Rejects every parked safety-decision promise with the same error (the already-delivered `safety_prompt` frames are moot).
  - Stops the WS server from accepting new frames until a reconnect completes; MCP tool calls during the disconnected window fail immediately with `EXTENSION_DISCONNECTED` (no buffering — it's an operator kill switch, not a pause).
- Reconnection: user opens the extension **options page** and clicks **Connect**. The popup's primary button does NOT reconnect — deliberate friction so an accidental popup click can't reverse a kill. Reconnection performs the usual shared-secret handshake (plan 00 §5).

### 4.6 Audit log

Extends `00-overview §4.6`. All writes are appended to `~/.browser-exp/log.jsonl` from the bridge process only (the extension does not write the log directly — it ships events over WS that the bridge folds in). One JSON object per line, UTC ISO timestamps.

**Levels.** Set via env `BROWSER_EXP_LOG_LEVEL`:

- `normal` (default) — truncates any string field > 200 chars to `"<first 200>…[truncated:N]"` where `N` is the dropped-char count. Applies to `params`, `result`, `details`.
- `audit` — full payloads, no truncation. Recommended for incident review; not recommended as default because page content may include PII.

**Additional record types produced by this layer:**

```jsonl
{"ts":"...","dir":"safety","event":"rate_limited","tab_id":"t_4","scope":"tab","retry_after_ms":2300,"tool":"browser.click"}
{"ts":"...","dir":"safety","event":"risky_detected","decision_id":"...","ruleId":"R3-sensitive-submit","tab_id":"t_4","tool":"browser.click"}
{"ts":"...","dir":"safety","event":"risky_resolved","decision_id":"...","allow":false,"timeout":true}
{"ts":"...","dir":"safety","event":"disconnected","code":4006,"in_flight":3}
{"ts":"...","dir":"safety","event":"connected"}
```

Log rotation is not in scope (deferred to 07-dev-setup.md); this plan only requires append-writes under `fs.createWriteStream('~/.browser-exp/log.jsonl', { flags: 'a' })`.

### 4.7 Invocation points

**Bridge (plan 01).** In the MCP `tools/call` handler, ordered:

```
1. resolve tab_id → chrome tabId (may fail with TAB_NOT_FOUND)
2. rl = rateLimiter.tryConsume(tab_id, toolWeight(method))
   if !rl.ok → return RATE_LIMITED
3. refMeta = refRegistry.lookupMeta(tab_id, params.ref)  // may be undefined
4. verdict = safety.checkRisky({ tool, params, tab, refMeta }, cfg)
5. if verdict.risky:
     decision = await safety.awaitConfirmation(verdict, tool, params, tab)
     if !decision.allow → return RISKY_ACTION_DENIED
6. forward Request over WS, await Response
7. log tool call + result
```

Ordering rationale: rate-limit before the risky check so a runaway loop can't flood the user with confirmation prompts.

**Extension (plan 03).** Background worker:

- Receives `safety_prompt` WS requests → stores + notifies popup + sets badge.
- Receives the `Disconnect` context-menu action → closes WS with 4006.
- Emits `safety_decision` WS messages when popup resolves.

---

## 5. Risks & mitigations

1. **False negatives — the heuristic misses a genuinely risky action.** E.g. a "Pay" button whose accessible name is an icon-only glyph, or a bank under a novel TLD. *Mitigation:* rule set is intentionally narrow so its failures fall back to the rate limiter (16/min ceiling) and the audit log (post-hoc review). Sensitive-domain list is user-editable without a release. A follow-up plan can add heuristic learning from declined actions; explicitly out of scope here.

2. **False positives — the heuristic is annoying.** Users doing legitimate repeated transfers on a bank site would be prompted every single time. *Mitigation:* scope of R3 is deliberately narrow (must be `role=button` AND exact-match submit-word AND sensitive domain). R2 has an opt-out toggle in options for users whose workflow involves frequent password fields. No "always allow" on purpose — if the rate of prompts is unbearable, the correct response is for the user to edit `risky-domains.json` or toggle R2 off, not to train themselves to click Allow.

3. **Kill-switch latency — user clicks Disconnect during a long-running `execute_js` and it hangs.** *Mitigation:* `ws.close(4006)` is synchronous at the socket layer; the bridge's `close` listener rejects in-flight promises immediately. The extension doesn't wait for responses from already-attached CDP sessions — `chrome.debugger.detach` is fire-and-forget on disconnect. Upper bound: one event-loop tick + one tab-dispatch tick. Documented target: p99 < 200 ms from click to MCP error.

4. **Log-file write contention.** Multiple concurrent tool calls append to the same file. *Mitigation:* single write stream per bridge process, all writes go through one async queue; each log line is written with a single `stream.write` call so OS-level `O_APPEND` atomicity covers the line boundary.

5. **Decision-id spoofing.** A malicious page can't forge `safety_decision` because messages come over the authenticated WS from the extension (plan 00 §5 shared secret + origin check). A compromised extension is out of v1 threat model.

---

## 6. Open questions

- Should the per-tab bucket survive tab navigation (same tab_id, new origin)? Current plan: yes — tab_id is the budget unit, navigation does not reset. Flag for review after dogfooding.
- Should `execute_js` have a separate, lower rate limit on top of R1 confirmation? Deferred; R1 already gates every call with a human click.
- Format of the "notification" — Chrome's native `chrome.notifications` vs. an injected in-page banner. Current plan uses `chrome.notifications`; plan 03 owns the final call.
- Whether `safety_prompt` should include a diff preview for `execute_js` (the JS source). Currently yes, via truncated `params.code`; usability review pending.

---

## 7. Acceptance checklist

- [ ] `RateLimiter` class exists in `packages/bridge/src/safety/rateLimiter.ts` with injectable `now()` and unit tests for: fresh bucket allows 16 weight-1 calls in a burst, 17th returns `retry_after_ms` ≈ 3750, continuous refill restores one token per 3.75 s.
- [ ] Global bucket denies when > 60 weight-1 calls fire inside 60 s across ≥ 2 tabs; `error.details.scope === "global"`.
- [ ] `isRisky` has unit tests covering R1 (positive), R2 with and without opt-out, R3 positive/negative for each of: wrong role, wrong accessible name, non-sensitive domain, sensitive domain match.
- [ ] `risky-domains.json` overrides merge correctly (`add` union, `remove` subtract); malformed file logs + uses built-in.
- [ ] Bridge pending-promise map rejects all entries with `EXTENSION_DISCONNECTED` on WS close, including parked safety-decision promises; verified with an e2e that triggers `ws.close(4006)` mid-flight.
- [ ] Extension toolbar right-click shows "Disconnect"; clicking it closes WS with code `4006` and sets the "off" badge.
- [ ] Reconnect path requires opening options page; popup has no reconnect control.
- [ ] A risky action produces: WS `safety_prompt`, red badge, `chrome.notifications` entry, popup modal with Allow/Deny; 30 s of no-response yields `RISKY_ACTION_DENIED` with `details.timeout === true`.
- [ ] `BROWSER_EXP_AUTOCONFIRM=allow|deny` short-circuits the prompt and emits a startup warning log line.
- [ ] `log.jsonl` contains the safety event records listed in §4.6 under both levels; `normal` truncates fields > 200 chars with `…[truncated:N]` suffix.
- [ ] Bridge tool-call handler invocation order matches §4.7 exactly; test verifies that a rate-limited call never triggers a risky prompt.
- [ ] No new error codes or envelope fields introduced beyond those declared in `00-overview.md`.
