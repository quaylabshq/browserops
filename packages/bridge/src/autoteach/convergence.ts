/**
 * Convergence verdict + next-optimization picker.
 *
 * Convergence rules:
 *   - converged: ≥2 consecutive optimization runs in the tail are
 *                noop with no retries and no errors
 *   - stalled:  ≥3 consecutive regressed/failed runs in the tail
 *               OR no improved run in the last 5 optimization runs
 *               OR the session's budget is exhausted
 *   - improving: anything else
 *
 * The next-optimization picker returns the first applicable
 * optimization from an ordered priority list, skipping anything
 * already tried (read from runs[].optimization_tried). Returns
 * undefined when no further optimization is available — the loop
 * then converges naturally on the next noop run.
 */
import type {
  AutoTeachOptimization,
  AutoTeachRun,
  ProcedureDef,
  SelectorTier,
} from "@browserops/shared";
import type { AutoTeachConvergence, AutoTeachSession } from "@browserops/shared";

const STALL_REGRESSION_STREAK = 3;
const STALL_NO_IMPROVEMENT_WINDOW = 5;
const CONVERGE_NOOP_STREAK = 2;

export interface ComputeConvergenceInput {
  runs: AutoTeachRun[];
  /** When set, used to honour the session budget cap. */
  session?: Pick<AutoTeachSession, "consent">;
}

export function computeConvergence(
  runsOrInput: AutoTeachRun[] | ComputeConvergenceInput,
): AutoTeachConvergence {
  const runs = Array.isArray(runsOrInput) ? runsOrInput : runsOrInput.runs;
  const session = Array.isArray(runsOrInput) ? undefined : runsOrInput.session;

  if (runs.length === 0) {
    return {
      verdict: "improving",
      reasons: ["no runs yet — loop hasn't started"],
    };
  }

  const optimizations = runs.filter((r) => r.run_index > 0);

  // Budget cap: when the session sets a numeric budget and we've hit it,
  // declare the loop converged so the agent moves on to finalize.
  const budget = session?.consent.budget;
  if (typeof budget === "number" && optimizations.length >= budget) {
    return {
      verdict: "converged",
      reasons: [`reached session budget of ${budget} optimization runs`],
    };
  }

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
 * Optimization priority order — first applicable + not-yet-tried wins.
 * The numbers correspond to the loop's discrete "gradient descent" axes;
 * the picker returns the cheapest, most-likely-to-help change first.
 */
const PRIORITY: AutoTeachOptimization["kind"][] = [
  "cache_selector",
  "swap_to_execute_js",
  "tighten_wait",
  "split_leaf",
];

export interface PickInput {
  runs: AutoTeachRun[];
  /** Parsed leaves+composite from the current best draft. */
  procedures: ProcedureDef[];
}

export function pickNextOptimization(
  input: PickInput,
): AutoTeachOptimization | undefined {
  const tried = collectTried(input.runs);
  for (const kind of PRIORITY) {
    const candidate = candidateFor(kind, input.procedures, tried);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

interface TriedSet {
  /** Keys: `<kind>:<step_id>` — coarse uniqueness. */
  pairs: Set<string>;
}

function collectTried(runs: AutoTeachRun[]): TriedSet {
  const pairs = new Set<string>();
  for (const r of runs) {
    const opt = r.optimization_tried;
    if (opt === undefined) continue;
    pairs.add(triedKey(opt));
  }
  return { pairs };
}

function triedKey(opt: AutoTeachOptimization): string {
  switch (opt.kind) {
    case "drop_dead_read":
    case "cache_selector":
    case "lift_to_bind":
    case "tighten_wait":
    case "swap_to_execute_js":
      return `${opt.kind}:${opt.step_id}`;
    case "split_leaf":
      return `split_leaf:${opt.at_step_id}`;
    case "reuse_existing":
      return `reuse_existing:${opt.leaf_name}`;
  }
}

function candidateFor(
  kind: AutoTeachOptimization["kind"],
  procedures: ProcedureDef[],
  tried: TriedSet,
): AutoTeachOptimization | undefined {
  switch (kind) {
    case "cache_selector":
      return pickCacheSelector(procedures, tried);
    case "swap_to_execute_js":
      return pickSwapToExecuteJs(procedures, tried);
    case "tighten_wait":
      return pickTightenWait(procedures, tried);
    case "split_leaf":
      return pickSplitLeaf(procedures, tried);
    default:
      return undefined;
  }
}

interface FlattenedStep {
  step_id: string;
  action: string;
  selector_tier?: SelectorTier;
}

function flattenSteps(procedures: ProcedureDef[]): FlattenedStep[] {
  const out: FlattenedStep[] = [];
  for (const p of procedures) {
    if (p.kind !== "leaf") continue;
    for (const s of p.steps) {
      const id = (s as { id?: unknown }).id;
      const action = (s as { action?: unknown }).action;
      if (typeof id !== "string" || typeof action !== "string") continue;
      const tier = (s as { selector_tier?: SelectorTier }).selector_tier;
      out.push({
        step_id: id,
        action,
        ...(tier !== undefined ? { selector_tier: tier } : {}),
      });
    }
  }
  return out;
}

function pickCacheSelector(
  procedures: ProcedureDef[],
  tried: TriedSet,
): AutoTeachOptimization | undefined {
  // Only fires when an existing step is on the lowest tiers (text / css /
  // xpath) AND the suggestion has somewhere stabler to go. We don't know
  // the actual selector at distill time without page_effect metadata,
  // so the picker only emits the *intent* here — the runtime applies it
  // on replay using whatever the live page exposes. Phase 6 wires this
  // to the runtime; Phase 3 returns the candidate so the loop counts it
  // as attempted (and won't re-emit it).
  for (const f of flattenSteps(procedures)) {
    if (f.selector_tier === "text" || f.selector_tier === "css" || f.selector_tier === "xpath") {
      const key = `cache_selector:${f.step_id}`;
      if (tried.pairs.has(key)) continue;
      return {
        kind: "cache_selector",
        step_id: f.step_id,
        new_tier: "id",
        new_selector: "",
      };
    }
  }
  return undefined;
}

function pickSwapToExecuteJs(
  procedures: ProcedureDef[],
  tried: TriedSet,
): AutoTeachOptimization | undefined {
  // Reads → safe to swap. Plain clicks → swap candidate. Don't suggest
  // for browser_type (rich editors break) or browser_navigate (no win).
  const SAFE_TO_SWAP: ReadonlySet<string> = new Set([
    "browser_click",
    "browser_click_by_text",
    "browser_read",
    "browser_quick_read",
    "browser_describe_ref",
    "browser_query_selector",
  ]);
  for (const f of flattenSteps(procedures)) {
    if (!SAFE_TO_SWAP.has(f.action)) continue;
    if (f.action === "browser_execute_js") continue;
    const key = `swap_to_execute_js:${f.step_id}`;
    if (tried.pairs.has(key)) continue;
    return { kind: "swap_to_execute_js", step_id: f.step_id };
  }
  return undefined;
}

function pickTightenWait(
  procedures: ProcedureDef[],
  tried: TriedSet,
): AutoTeachOptimization | undefined {
  for (const p of procedures) {
    if (p.kind !== "leaf") continue;
    for (const s of p.steps) {
      const id = (s as { id?: unknown }).id;
      if (typeof id !== "string") continue;
      const wf = (s as { wait_for?: { selector?: unknown } }).wait_for;
      if (!wf) continue;
      const key = `tighten_wait:${id}`;
      if (tried.pairs.has(key)) continue;
      return { kind: "tighten_wait", step_id: id, new_timeout_ms: 5000 };
    }
  }
  return undefined;
}

function pickSplitLeaf(
  procedures: ProcedureDef[],
  tried: TriedSet,
): AutoTeachOptimization | undefined {
  // Only suggest a split if a leaf has > 12 steps and we haven't already
  // tried at this step boundary.
  const SPLIT_THRESHOLD = 12;
  for (const p of procedures) {
    if (p.kind !== "leaf") continue;
    if ((p.steps?.length ?? 0) <= SPLIT_THRESHOLD) continue;
    const midIdx = Math.floor(p.steps.length / 2);
    const midStep = p.steps[midIdx];
    const id = (midStep as { id?: unknown }).id;
    if (typeof id !== "string") continue;
    const key = `split_leaf:${id}`;
    if (tried.pairs.has(key)) continue;
    return {
      kind: "split_leaf",
      at_step_id: id,
      reason: "modal_open",
    };
  }
  return undefined;
}
