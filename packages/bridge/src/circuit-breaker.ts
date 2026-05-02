import { createHash } from "node:crypto";
import type { ErrorCode } from "@browserops/shared";

/**
 * Repeated-failure circuit breaker.
 *
 * Detects when the calling agent has invoked the *same* failing tool call
 * more than {@link FAILURE_THRESHOLD} times within {@link WINDOW_MS} and
 * short-circuits subsequent identical calls with a `REPEATED_FAILURE` error
 * envelope rather than letting them run again.
 *
 * The breaker key is derived from `(method, tab_id, ref|selector, args_hash)`
 * so changing any addressable surface (different tab, different ref, different
 * argument) gets a fresh counter — only literally-identical calls trip.
 *
 * State is per-process. Entries reset on the first success for the same key
 * and are opportunistically GC'd on every check/record.
 *
 * No setInterval; allocation-cheap; no env-var surface.
 */

// ---------------------------------------------------------------------------
// Tunables (intentionally NOT env-var configurable — keep the surface tiny).
// ---------------------------------------------------------------------------

/** Number of prior failures required before short-circuiting the next call. */
const FAILURE_THRESHOLD = 2;

/** Time window for counting failures, in milliseconds. */
const WINDOW_MS = 30_000;

/** Entries older than this are pruned opportunistically on every insert. */
const GC_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Inputs the breaker needs to compute a key and (later) describe a trip. */
export interface BreakerCall {
  method: string;
  params: Record<string, unknown>;
}

/** A bridge response shape — only the success bit and error code are read. */
export type BreakerResult =
  | { ok: true }
  | { ok: false; error_code?: ErrorCode | string };

/** Error envelope returned when the breaker trips. */
export interface BreakerErrorEnvelope {
  code: "REPEATED_FAILURE";
  message: string;
  next_action: string;
  diagnostic: {
    method: string;
    tab_id: string;
    ref_or_selector: string;
    last_error_code: string;
    repeat_count: number;
    window_seconds: number;
  };
}

export type BreakerCheck =
  | { tripped: false }
  | { tripped: true; error: BreakerErrorEnvelope };

interface Entry {
  count: number;
  last_error_code: string;
  first_seen_at: number;
  /** Cached for diagnostic emission — avoids recomputing on trip. */
  method: string;
  tab_id: string;
  ref_or_selector: string;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const entries = new Map<string, Entry>();

// ---------------------------------------------------------------------------
// Key construction
// ---------------------------------------------------------------------------

/** Pull a stringable field off params or fall back to a sentinel. */
function pickStringField(
  params: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const v = params[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number") return String(v);
  return fallback;
}

/** Stable JSON stringify with sorted object keys (recursive). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k]));
  return "{" + parts.join(",") + "}";
}

interface KeyParts {
  composite: string;
  method: string;
  tab_id: string;
  ref_or_selector: string;
}

function computeKeyParts(call: BreakerCall): KeyParts {
  const method = call.method;
  const tab_id = pickStringField(call.params, "tab_id", "no_tab");

  // ref takes priority over selector (refs are the cheaper, addressable form).
  let ref_or_selector = "no_target";
  const ref = call.params["ref"];
  if (typeof ref === "string" && ref.length > 0) {
    ref_or_selector = `ref:${ref}`;
  } else if (typeof ref === "number") {
    ref_or_selector = `ref:${ref}`;
  } else {
    const sel = call.params["selector"];
    if (typeof sel === "string" && sel.length > 0) {
      ref_or_selector = `sel:${sel}`;
    }
  }

  // Hash the remaining args (everything except tab_id/ref/selector).
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(call.params)) {
    if (k === "tab_id" || k === "ref" || k === "selector") continue;
    rest[k] = v;
  }
  const argsHash = createHash("sha1")
    .update(stableStringify(rest))
    .digest("hex")
    .slice(0, 16);

  const composite = `${method}|${tab_id}|${ref_or_selector}|${argsHash}`;
  return { composite, method, tab_id, ref_or_selector };
}

// ---------------------------------------------------------------------------
// GC
// ---------------------------------------------------------------------------

function gc(now: number): void {
  for (const [k, e] of entries) {
    if (now - e.first_seen_at > GC_TTL_MS) {
      entries.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check the breaker before forwarding a call to the extension.
 * Returns `{ tripped: false }` to let the call proceed, or
 * `{ tripped: true, error }` to short-circuit with `REPEATED_FAILURE`.
 */
export function checkBreaker(
  call: BreakerCall,
  now: number = Date.now(),
): BreakerCheck {
  const { composite, method, tab_id, ref_or_selector } = computeKeyParts(call);
  const e = entries.get(composite);
  if (!e) return { tripped: false };

  // Past the window — stale entry, treat as fresh and let the call run.
  if (now - e.first_seen_at > WINDOW_MS) {
    entries.delete(composite);
    return { tripped: false };
  }

  if (e.count < FAILURE_THRESHOLD) return { tripped: false };

  return {
    tripped: true,
    error: {
      code: "REPEATED_FAILURE",
      message: `identical call has failed ${e.count} times in the last ${Math.round(WINDOW_MS / 1000)}s`,
      next_action: `identical call has failed ${e.count} times — call browser_quick_read to refresh refs and inspect state, or switch strategy. The bridge will refuse this exact call again until you change something.`,
      diagnostic: {
        method,
        tab_id,
        ref_or_selector,
        last_error_code: e.last_error_code,
        repeat_count: e.count,
        window_seconds: Math.round(WINDOW_MS / 1000),
      },
    },
  };
}

/**
 * Record the outcome of a forwarded call. On `ok:true`, clears the entry
 * (the agent recovered). On `ok:false`, increments the failure count and
 * stamps `last_error_code`.
 *
 * Does opportunistic GC on every insert (no setInterval).
 */
export function recordResult(
  call: BreakerCall,
  result: BreakerResult,
  now: number = Date.now(),
): void {
  const { composite, method, tab_id, ref_or_selector } = computeKeyParts(call);

  if (result.ok) {
    entries.delete(composite);
    return;
  }

  const last_error_code =
    typeof result.error_code === "string" && result.error_code.length > 0
      ? result.error_code
      : "UNKNOWN";

  const existing = entries.get(composite);
  if (existing && now - existing.first_seen_at <= WINDOW_MS) {
    existing.count += 1;
    existing.last_error_code = last_error_code;
  } else {
    entries.set(composite, {
      count: 1,
      last_error_code,
      first_seen_at: now,
      method,
      tab_id,
      ref_or_selector,
    });
  }

  gc(now);
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** @internal — for unit tests. Clears all breaker state. */
export function _resetBreakerForTests(): void {
  entries.clear();
}

/** @internal — for unit tests. */
export const _BREAKER_CONSTANTS = {
  FAILURE_THRESHOLD,
  WINDOW_MS,
  GC_TTL_MS,
} as const;
