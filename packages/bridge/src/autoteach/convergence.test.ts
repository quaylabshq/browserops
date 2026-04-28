import { describe, expect, it } from "vitest";
import type {
  AutoTeachOptimization,
  AutoTeachRun,
  AutoTeachSession,
  ProcedureDef,
} from "@browserops/shared";
import { computeConvergence, pickNextOptimization } from "./convergence.js";

function run(
  index: number,
  outcome: AutoTeachRun["outcome"],
  optTried?: AutoTeachOptimization,
  errors: string[] = [],
  retries = 0,
): AutoTeachRun {
  return {
    run_id: `r_${index}`,
    run_index: index,
    started_at: index * 1000,
    tool_count: 5,
    wall_clock_ms: 1000,
    retries,
    errors,
    outcome,
    trace_ref: `trace.jsonl#run_${index}`,
    ...(optTried !== undefined ? { optimization_tried: optTried } : {}),
  };
}

describe("computeConvergence", () => {
  it("returns improving when no runs yet", () => {
    expect(computeConvergence([]).verdict).toBe("improving");
  });

  it("returns improving when only run 0 is in history", () => {
    expect(computeConvergence([run(0, "improved")]).verdict).toBe("improving");
  });

  it("returns converged after 2 noop runs in a row", () => {
    const v = computeConvergence([
      run(0, "improved"),
      run(1, "improved"),
      run(2, "noop"),
      run(3, "noop"),
    ]);
    expect(v.verdict).toBe("converged");
  });

  it("does NOT converge if a noop run had retries", () => {
    const v = computeConvergence([
      run(0, "improved"),
      run(1, "noop"),
      run(2, "noop", undefined, [], 2),
    ]);
    expect(v.verdict).not.toBe("converged");
  });

  it("returns stalled after 3 regressed runs in a row", () => {
    const v = computeConvergence([
      run(0, "improved"),
      run(1, "regressed"),
      run(2, "regressed"),
      run(3, "regressed"),
    ]);
    expect(v.verdict).toBe("stalled");
  });

  it("returns stalled when no improvement in 5 optimization runs", () => {
    const v = computeConvergence([
      run(0, "improved"),
      run(1, "noop"),
      run(2, "noop"),
      run(3, "regressed"),
      run(4, "noop"),
      run(5, "regressed"),
    ]);
    expect(v.verdict).toBe("stalled");
  });

  it("converged respects session budget", () => {
    const session: Pick<AutoTeachSession, "consent"> = {
      consent: { budget: 2, side_effect_policy: "read_only_only" },
    };
    const v = computeConvergence({
      runs: [run(0, "improved"), run(1, "improved"), run(2, "improved")],
      session,
    });
    expect(v.verdict).toBe("converged");
    expect(v.reasons[0]).toMatch(/budget/);
  });

  it("convergence budget=convergence is treated as no cap", () => {
    const session: Pick<AutoTeachSession, "consent"> = {
      consent: { budget: "convergence", side_effect_policy: "read_only_only" },
    };
    const v = computeConvergence({
      runs: [run(0, "improved"), run(1, "improved")],
      session,
    });
    expect(v.verdict).toBe("improving");
  });
});

describe("pickNextOptimization", () => {
  function leafProc(steps: Array<{ id: string; action: string; selector_tier?: string }>): ProcedureDef {
    return {
      schema_version: 1,
      name: "test.leaf",
      description: "x",
      kind: "leaf",
      steps: steps.map((s) => ({
        id: s.id,
        action: s.action,
        with: { tab_id: "{{tab_id}}" },
        ...(s.selector_tier !== undefined
          ? { selector_tier: s.selector_tier as "id" | "testid" | "role_name" | "text" | "css" | "xpath" }
          : {}),
      })),
    };
  }

  it("returns undefined when there are no candidate optimizations", () => {
    const procs = [leafProc([{ id: "s1", action: "browser_navigate" }])];
    expect(pickNextOptimization({ runs: [], procedures: procs })).toBeUndefined();
  });

  it("suggests cache_selector for a step on tier 'text'", () => {
    const procs = [leafProc([{ id: "click_login", action: "browser_click_by_text", selector_tier: "text" }])];
    const opt = pickNextOptimization({ runs: [], procedures: procs });
    expect(opt?.kind).toBe("cache_selector");
    expect((opt as { step_id: string }).step_id).toBe("click_login");
  });

  it("suggests swap_to_execute_js for a click step that hasn't been swapped", () => {
    const procs = [leafProc([{ id: "click_btn", action: "browser_click", selector_tier: "role_name" }])];
    const opt = pickNextOptimization({ runs: [], procedures: procs });
    expect(opt?.kind).toBe("swap_to_execute_js");
    expect((opt as { step_id: string }).step_id).toBe("click_btn");
  });

  it("does not re-suggest an optimization that's already been tried", () => {
    const procs = [leafProc([{ id: "click_btn", action: "browser_click", selector_tier: "role_name" }])];
    const tried: AutoTeachOptimization = { kind: "swap_to_execute_js", step_id: "click_btn" };
    const opt = pickNextOptimization({
      runs: [run(1, "regressed", tried)],
      procedures: procs,
    });
    // The picker has nothing else applicable for this single click step.
    expect(opt).toBeUndefined();
  });

  it("skips browser_type for swap_to_execute_js (rich-editor risk)", () => {
    const procs = [leafProc([{ id: "type_msg", action: "browser_type" }])];
    expect(pickNextOptimization({ runs: [], procedures: procs })).toBeUndefined();
  });

  it("priority order: cache_selector beats swap_to_execute_js when both apply", () => {
    const procs = [
      leafProc([
        { id: "click_a", action: "browser_click_by_text", selector_tier: "text" },
        { id: "click_b", action: "browser_click", selector_tier: "role_name" },
      ]),
    ];
    const opt = pickNextOptimization({ runs: [], procedures: procs });
    expect(opt?.kind).toBe("cache_selector");
  });
});
