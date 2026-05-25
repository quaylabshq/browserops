/**
 * Roadblock capture-signal detector (Phase 5.4).
 *
 * Pure function — no I/O, no side effects, unit-testable.
 * Inspects a window of recent TraceEntry records plus the current call to
 * decide whether the agent appears stuck and a memory-scribe capture would
 * be valuable.
 */
import type { TraceEntry } from "./trace.js";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface CaptureHint {
  reason: "roadblock";
  /** Hostname where the roadblock was detected, if known. */
  origin?: string;
  /** Human-readable signals that fired. */
  signals: string[];
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Error codes that immediately signal a roadblock on their own. */
const IMMEDIATE_ERROR_CODES = new Set<string>([
  "WRITE_NOT_REFLECTED",
  "USER_DECLINED",
  "RISKY_ACTION_DENIED",
  "ELEMENT_NOT_ACTIONABLE",
  "LOCATOR_NOT_FOUND",
  "LOCATOR_AMBIGUOUS",
]);

/** Codes that count toward a timeout / transient-failure cluster. */
const TIMEOUT_LIKE_CODES = new Set<string>([
  "TIMEOUT",
  "NAVIGATION_IN_PROGRESS",
  "EXTENSION_DISCONNECTED",
]);

/** Tool name prefixes that are "action" methods (writes / interactions). */
const ACTION_PREFIXES = [
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_hover",
  "browser_find_and_replace",
  "browser_scroll",
];

/**
 * How many recent entries to consider the "cluster window".
 * Must be < RING_CAPACITY (50).
 */
const CLUSTER_WINDOW = 10;

/**
 * Number of times the same (origin, method) must appear in the cluster
 * window before it counts as "repeated retries".
 */
const RETRY_REPEAT_THRESHOLD = 3;

/**
 * Number of timeout-like errors in the window before a signal fires.
 */
const TIMEOUT_CLUSTER_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

interface CurrentCall {
  method: string;
  origin?: string;
  error_code?: string;
  effect_summary: string;
}

/**
 * Inspect the recent trace plus the just-completed call and return a
 * CaptureHint when a roadblock cluster is detected, or null otherwise.
 *
 * Rules that fire:
 *  1. Any IMMEDIATE_ERROR_CODE on the current call.
 *  2. No-op effect after an action method on the current call.
 *  3. TIMEOUT-like error cluster (≥2 in last CLUSTER_WINDOW).
 *  4. Repeated retries: same (origin, method) ≥3 times in the window.
 *  5. Any IMMEDIATE_ERROR_CODE appearing in the recent trace window
 *     at the same origin (suppressed for unrelated origins).
 *
 * Deliberate non-triggers:
 *  - Pure read tools (browser_read, browser_screenshot, etc.) with no-op
 *    effects do NOT fire — only action methods matter for no-op detection.
 *  - Single isolated errors that are already handled (circuit breaker).
 */
export function detectRoadblock(
  recentTrace: TraceEntry[],
  current: CurrentCall,
): CaptureHint | null {
  const signals: string[] = [];
  const origin = current.origin;

  // Rule 1 — immediate error codes on the current call.
  if (current.error_code && IMMEDIATE_ERROR_CODES.has(current.error_code)) {
    signals.push(`error:${current.error_code}`);
  }

  // Rule 2 — no-op effect after an action method.
  if (
    !current.error_code &&
    current.effect_summary === "no-op" &&
    ACTION_PREFIXES.some((p) => current.method.startsWith(p))
  ) {
    signals.push("no-op-after-action");
  }

  // Build the cluster window (most-recent CLUSTER_WINDOW entries).
  const window = recentTrace.slice(-CLUSTER_WINDOW);

  // Rule 3 — timeout cluster.
  const timeoutCount = window.filter(
    (e) => e.error_code && TIMEOUT_LIKE_CODES.has(e.error_code),
  ).length;
  if (timeoutCount >= TIMEOUT_CLUSTER_THRESHOLD) {
    signals.push(`timeout-cluster:${timeoutCount}`);
  }

  // Rule 4 — repeated retries on same (origin, method).
  if (origin) {
    const key = `${origin}|${current.method}`;
    const sameCount = window.filter(
      (e) => e.method === current.method && e.origin === origin,
    ).length;
    // Include the current call
    if (sameCount + 1 >= RETRY_REPEAT_THRESHOLD) {
      signals.push(`repeated:${key}:${sameCount + 1}x`);
    }
  }

  // Rule 5 — immediate error codes in the window at the same origin.
  if (origin) {
    const priorErrors = window.filter(
      (e) =>
        e.origin === origin &&
        e.error_code &&
        IMMEDIATE_ERROR_CODES.has(e.error_code),
    );
    for (const e of priorErrors) {
      const sig = `prior-error:${e.error_code}`;
      if (!signals.includes(sig)) signals.push(sig);
    }
  }

  if (signals.length === 0) return null;

  return {
    reason: "roadblock",
    ...(origin !== undefined ? { origin } : {}),
    signals,
  };
}
