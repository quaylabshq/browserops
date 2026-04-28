/**
 * Convergence verdict + next-optimization picker.
 *
 * Phase 1 stub: implements the noise-floor and improvement window so the
 * loop end-to-end terminates correctly. The next-optimization picker
 * returns undefined for now — Phase 3 fills it in once the distiller
 * (Phase 2) emits step IDs the picker can act on.
 */
import type {
  AutoTeachConvergence,
  AutoTeachOptimization,
  AutoTeachRun,
} from "@browserops/shared";

const STALL_REGRESSION_STREAK = 3;
const STALL_NO_IMPROVEMENT_WINDOW = 5;
const CONVERGE_NOOP_STREAK = 2;

export function computeConvergence(runs: AutoTeachRun[]): AutoTeachConvergence {
  if (runs.length === 0) {
    return {
      verdict: "improving",
      reasons: ["no runs yet — loop hasn't started"],
    };
  }

  const optimizations = runs.filter((r) => r.run_index > 0);
  if (optimizations.length === 0) {
    return {
      verdict: "improving",
      reasons: ["only run 0 captured — no optimization runs to evaluate"],
    };
  }

  // Stalled if the last STALL_REGRESSION_STREAK runs all regressed.
  const tail = optimizations.slice(-STALL_REGRESSION_STREAK);
  if (
    tail.length >= STALL_REGRESSION_STREAK &&
    tail.every((r) => r.outcome === "regressed" || r.outcome === "failed")
  ) {
    return {
      verdict: "stalled",
      reasons: [
        `last ${STALL_REGRESSION_STREAK} optimization runs regressed or failed`,
      ],
    };
  }

  // Stalled if no improvement in STALL_NO_IMPROVEMENT_WINDOW runs.
  const window = optimizations.slice(-STALL_NO_IMPROVEMENT_WINDOW);
  if (
    window.length >= STALL_NO_IMPROVEMENT_WINDOW &&
    !window.some((r) => r.outcome === "improved")
  ) {
    return {
      verdict: "stalled",
      reasons: [
        `no improvement in the last ${STALL_NO_IMPROVEMENT_WINDOW} optimization runs`,
      ],
    };
  }

  // Converged if the last CONVERGE_NOOP_STREAK runs were all noop with no
  // retries and the most recent run had no errors.
  const convTail = optimizations.slice(-CONVERGE_NOOP_STREAK);
  if (
    convTail.length >= CONVERGE_NOOP_STREAK &&
    convTail.every((r) => r.outcome === "noop" && r.retries === 0 && r.errors.length === 0)
  ) {
    return {
      verdict: "converged",
      reasons: [
        `last ${CONVERGE_NOOP_STREAK} optimization runs were noop with no retries`,
      ],
    };
  }

  // Otherwise still climbing.
  const lastOutcome = optimizations[optimizations.length - 1]?.outcome ?? "noop";
  return {
    verdict: "improving",
    reasons: [`most recent optimization run was ${lastOutcome}`],
  };
}

/**
 * Pick the next optimization for the loop to try, given the current run
 * history and the IDs of steps in the current best draft.
 *
 * Phase 1: returns undefined when there are no candidate optimizations
 * the bridge can produce without distiller-emitted selector_tier
 * metadata. Phase 3 will pick from the ordered list:
 *
 *   1. drop_dead_read
 *   2. cache_selector
 *   3. lift_to_bind
 *   4. tighten_wait
 *   5. swap_to_execute_js
 *   6. split_leaf
 *   7. reuse_existing
 */
export function pickNextOptimization(
  runs: AutoTeachRun[],
  _currentBestStepIds: string[],
): AutoTeachOptimization | undefined {
  void runs;
  return undefined;
}
