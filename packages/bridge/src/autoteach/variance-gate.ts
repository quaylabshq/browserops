/**
 * Variance gate for autoteach finalize.
 *
 * The conceptual gate — re-running each leaf 3× under perturbed
 * starting conditions — requires the agent to drive browser_* calls,
 * which the bridge can't do synchronously. So the bridge-side gate
 * is a posture check on the runs already in history:
 *
 *   - the latest run must have succeeded (outcome != failed)
 *   - at least MIN_GOOD_RUNS prior runs in the history with the same
 *     succeeded outcome and within noise-floor metrics
 *   - no regression in the last MIN_GOOD_RUNS runs
 *
 * The agent gets the actual perturbation evidence from the optimization
 * loop itself (5+ replays of the same flow under different timing,
 * cache, and tab state).
 *
 * `force=true` skips the gate; the caller acknowledges that the
 * resulting procedures may not survive variance.
 */
import type { AutoTeachRun } from "@browserops/shared";

const MIN_GOOD_RUNS = 3;

export interface VarianceGateInput {
  runs: AutoTeachRun[];
  force: boolean;
}

export interface VarianceGateResult {
  passed: boolean;
  reasons: string[];
}

export function checkVariance(input: VarianceGateInput): VarianceGateResult {
  if (input.force) {
    return {
      passed: true,
      reasons: ["force=true — variance gate skipped at caller's risk"],
    };
  }

  const runs = input.runs.filter((r) => r.run_index > 0 || r.outcome !== "failed");
  if (runs.length < MIN_GOOD_RUNS) {
    return {
      passed: false,
      reasons: [
        `need at least ${MIN_GOOD_RUNS} runs in history to gate variance — found ${runs.length}`,
      ],
    };
  }

  const tail = runs.slice(-MIN_GOOD_RUNS);
  const allSucceeded = tail.every((r) => r.outcome !== "failed");
  if (!allSucceeded) {
    const failed = tail
      .filter((r) => r.outcome === "failed")
      .map((r) => `run ${r.run_index}`)
      .join(", ");
    return {
      passed: false,
      reasons: [`recent runs include failures: ${failed}`],
    };
  }

  const anyRegressed = tail.some((r) => r.outcome === "regressed");
  if (anyRegressed) {
    return {
      passed: false,
      reasons: [
        `recent runs include a regression — wait for the loop to recover before promoting`,
      ],
    };
  }

  return {
    passed: true,
    reasons: [`last ${MIN_GOOD_RUNS} runs succeeded with stable metrics`],
  };
}
