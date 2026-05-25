/**
 * Confidence model for MemoryRecord entries.
 *
 * A pure, deterministic function: inject `now` for testability.
 * Mirrors the threshold-constant + predicate pattern of
 * packages/bridge/src/procedures/health.ts.
 *
 * confidence(record, now?) → [0, 1]
 *
 * Four factors (multiplicative / weighted blend):
 *   1. Severity weight   — high > med > low
 *   2. Recency decay     — exponential, half-life ~30 days on last_hit
 *   3. Resolution ratio  — resolved / (resolved + door_failures); 0/0 → 0.5
 *   4. Door-failure penalty — grows as door_failures dominates
 *
 * No stats at all → neutral value driven purely by severity.
 */

import type { MemoryRecord, MemoryStats } from "@browserops/shared";

// ---------------------------------------------------------------------------
// Threshold constants (exported, mirroring health.ts style)
// ---------------------------------------------------------------------------

/** Minimum ratio door_failures/(door_failures+resolved) to flag as unreliable. */
export const DOOR_FAILURE_RATIO_THRESHOLD = 0.6;

/** Minimum total observations before the door-failure ratio is meaningful. */
export const DOOR_FAILURE_MIN_OBSERVATIONS = 3;

/** Half-life for recency decay in days. */
export const RECENCY_HALF_LIFE_DAYS = 30;

/** Severity weights — sum to nothing specific; they normalise the base. */
const SEVERITY_WEIGHT: Record<string, number> = {
  high: 1.0,
  med: 0.75,
  low: 0.5,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Exponential recency factor in [0, 1].
 * Returns 1 when last_hit is today, decays toward 0 as time grows.
 * Half-life = RECENCY_HALF_LIFE_DAYS.
 *
 * When last_hit is undefined (never hit), returns a neutral 0.5 — the
 * record exists and might be valid, we just don't have usage evidence.
 */
export function recencyFactor(last_hit: string | undefined, now: Date): number {
  if (!last_hit) return 0.5;
  const lastHitMs = Date.parse(last_hit);
  if (Number.isNaN(lastHitMs)) return 0.5;
  const elapsedDays = (now.getTime() - lastHitMs) / (1000 * 60 * 60 * 24);
  if (elapsedDays < 0) return 1.0; // last_hit in the future — treat as fresh
  return Math.pow(0.5, elapsedDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Resolution-ratio factor in [0, 1].
 * resolved / (resolved + door_failures) — 0/0 → neutral 0.5.
 */
function resolutionFactor(stats: MemoryStats): number {
  const total = stats.resolved + stats.door_failures;
  if (total === 0) return 0.5;
  return stats.resolved / total;
}

/**
 * Door-failure penalty in [0, 1].
 * Grows as door_failures accumulates relative to resolved.
 * Returns 1.0 (no penalty) when there are no failures.
 */
function doorFailurePenalty(stats: MemoryStats): number {
  if (stats.door_failures === 0) return 1.0;
  const total = stats.resolved + stats.door_failures;
  if (total === 0) return 1.0;
  // penalty grows from 1 → 0 as the failure ratio grows from 0 → 1
  const ratio = stats.door_failures / total;
  return 1.0 - ratio;
}

// ---------------------------------------------------------------------------
// Self-heal predicate
// ---------------------------------------------------------------------------

/**
 * True when the door workaround for a blocker record is no longer reliable —
 * door_failures dominates resolved past the threshold and we have enough
 * observations to be confident in the signal.
 *
 * Mirrors shouldDemoteFromHealth: named threshold + simple predicate.
 */
export function doorUnreliable(stats: MemoryStats): boolean {
  const total = stats.resolved + stats.door_failures;
  if (total < DOOR_FAILURE_MIN_OBSERVATIONS) return false;
  const ratio = stats.door_failures / total;
  return ratio >= DOOR_FAILURE_RATIO_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Main confidence function
// ---------------------------------------------------------------------------

/**
 * Compute a confidence score in [0, 1] for a MemoryRecord.
 *
 * @param record  The record to evaluate.
 * @param now     Reference timestamp (inject for determinism in tests). Defaults to new Date().
 */
export function confidence(record: MemoryRecord, now: Date = new Date()): number {
  const severity = record.severity ?? "med";
  const severityWeight = SEVERITY_WEIGHT[severity] ?? SEVERITY_WEIGHT["med"]!;

  const stats = record.stats;
  if (!stats) {
    // No usage data — neutral confidence modulated only by severity.
    // Map severity weight (0.5–1.0) to confidence range (0.4–0.65).
    return 0.4 + severityWeight * 0.25;
  }

  const recency = recencyFactor(stats.last_hit, now);
  const resolution = resolutionFactor(stats);
  const penalty = doorFailurePenalty(stats);

  // Blend: severity anchors the base; recency, resolution, and penalty scale it.
  // Weights chosen so all four factors matter without any dominating entirely.
  const raw =
    0.25 * severityWeight +
    0.30 * recency +
    0.25 * resolution +
    0.20 * penalty;

  // Clamp to [0, 1]
  return Math.min(1, Math.max(0, raw));
}
