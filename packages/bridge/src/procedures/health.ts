/**
 * Pure-function locator drift health recorder + auto-demote check.
 *
 * The execute loop calls `recordResolution` after each successful step
 * resolve to fold the result into `meta.health`. The save handler calls
 * `shouldDemoteFromHealth` to decide whether to flip
 * `status: trusted → status: draft` when persisting.
 *
 * No I/O. The caller threads the resulting HealthDef back into
 * the procedure YAML when it writes to disk.
 */
import type {
  HealthDef,
  StepHealth,
  LocatorStabilityTier,
} from "@browserops/shared";

export interface ResolutionRecord {
  /** ref the locator resolved to this attempt. */
  matched_ref: number;
  /** Number of matches browser_locate returned (we pick [0]). */
  match_count: number;
  /** Stability tier of the descriptor that produced this match. */
  tier: LocatorStabilityTier;
  /** True when the original locator missed and a relocate-widened one was used. */
  used_relocate: boolean;
}

/** Auto-demote thresholds. */
const RELOCATE_RATE_THRESHOLD = 0.4;
const RELOCATE_MIN_RUNS = 5;
const FRAGILE_RELOCATE_RATE_THRESHOLD = 0.1;
const TARGET_CHANGE_MIN_RUNS = 3;

export function emptyHealth(updated: string): HealthDef {
  return { updated, steps: {} };
}

/**
 * Fold a single ResolutionRecord into the health block for `stepId`.
 * Returns a new HealthDef — the input is not mutated.
 */
export function recordResolution(
  prev: HealthDef,
  stepId: string,
  record: ResolutionRecord,
  at: string,
): HealthDef {
  const existing = prev.steps[stepId];
  const prevRuns = existing?.runs ?? 0;
  const prevAvg = existing?.avg_match_count ?? record.match_count;

  const nextRuns = prevRuns + 1;
  const nextAvg =
    prevRuns === 0
      ? record.match_count
      : (prevAvg * prevRuns + record.match_count) / nextRuns;

  const ambiguousInc = record.match_count > 1 ? 1 : 0;
  const relocateInc = record.used_relocate ? 1 : 0;
  const targetChangedInc =
    existing?.last_ref !== undefined && existing.last_ref !== record.matched_ref
      ? 1
      : 0;

  const next: StepHealth = {
    runs: nextRuns,
    relocates: (existing?.relocates ?? 0) + relocateInc,
    ambiguous_resolves: (existing?.ambiguous_resolves ?? 0) + ambiguousInc,
    target_changed: (existing?.target_changed ?? 0) + targetChangedInc,
    avg_match_count: round(nextAvg, 3),
    last_tier: record.tier,
    last_ref: record.matched_ref,
  };

  return {
    updated: at,
    steps: { ...prev.steps, [stepId]: next },
  };
}

/**
 * True when at least one step's health signals warrant demoting the
 * procedure from trusted to draft on the next save. Pure rule-based check
 * over the health block.
 */
export function shouldDemoteFromHealth(
  health: HealthDef | undefined,
): boolean {
  if (health === undefined) return false;
  for (const step of Object.values(health.steps)) {
    if (isStepDegraded(step)) return true;
  }
  return false;
}

function isStepDegraded(step: StepHealth): boolean {
  // Relocate-rate signal — primary metric of drift.
  if (step.runs >= RELOCATE_MIN_RUNS) {
    const rate = step.relocates / step.runs;
    if (rate > RELOCATE_RATE_THRESHOLD) return true;
  }

  // Target-change signal — even a single drift is a strong negative
  // signal once we've seen a few runs.
  if (step.runs >= TARGET_CHANGE_MIN_RUNS && step.target_changed > 0) {
    return true;
  }

  // Fragile + drifting combo — tier-3 (nth) descriptors degrade faster.
  if (step.last_tier === 3 && step.runs > 0) {
    const rate = step.relocates / step.runs;
    if (rate > FRAGILE_RELOCATE_RATE_THRESHOLD) return true;
  }

  return false;
}

function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
