import { describe, it, expect } from "vitest";
import {
  emptyHealth,
  recordResolution,
  shouldDemoteFromHealth,
  type ResolutionRecord,
} from "./health.js";
import type { HealthDef } from "@browserops/shared";

/**
 * Pure-function tests for the drift-health recorder. The recorder takes
 * the previous HealthDef + a ResolutionRecord and returns the
 * updated HealthDef. No side effects, no I/O.
 *
 * Auto-demote contract:
 *   - relocate-rate > 0.4 across at least 5 runs → demote
 *   - target_changed > 0 (any) across at least 3 runs → demote
 *   - last_tier === 3 (fragile) AND relocate-rate > 0.1 → demote
 *   - everything else → keep trusted
 */

const t0 = "2026-05-24T00:00:00Z";
const t1 = "2026-05-25T00:00:00Z";

function recordN(
  start: HealthDef,
  step: string,
  record: ResolutionRecord,
  n: number,
  at: string = t1,
): HealthDef {
  let out = start;
  for (let i = 0; i < n; i++) out = recordResolution(out, step, record, at);
  return out;
}

describe("emptyHealth", () => {
  it("returns a well-formed empty health block with the given timestamp", () => {
    const h = emptyHealth(t0);
    expect(h.updated).toBe(t0);
    expect(h.steps).toEqual({});
  });
});

describe("recordResolution — first run for a step", () => {
  it("creates a fresh step entry initialised to runs=1", () => {
    const before = emptyHealth(t0);
    const after = recordResolution(
      before,
      "open_compose",
      { matched_ref: 12, match_count: 1, tier: 1, used_relocate: false },
      t1,
    );
    expect(after.steps["open_compose"]).toEqual({
      runs: 1,
      relocates: 0,
      ambiguous_resolves: 0,
      target_changed: 0,
      avg_match_count: 1,
      last_tier: 1,
      last_ref: 12,
    });
    expect(after.updated).toBe(t1);
  });
});

describe("recordResolution — incremental updates", () => {
  it("increments runs and averages match_count across calls", () => {
    let h = emptyHealth(t0);
    h = recordResolution(h, "s1", { matched_ref: 5, match_count: 1, tier: 1, used_relocate: false }, t1);
    h = recordResolution(h, "s1", { matched_ref: 5, match_count: 3, tier: 1, used_relocate: false }, t1);
    expect(h.steps["s1"]!.runs).toBe(2);
    expect(h.steps["s1"]!.avg_match_count).toBe(2);
  });

  it("flags ambiguous_resolves when match_count > 1", () => {
    let h = emptyHealth(t0);
    h = recordResolution(h, "s1", { matched_ref: 5, match_count: 4, tier: 1, used_relocate: false }, t1);
    expect(h.steps["s1"]!.ambiguous_resolves).toBe(1);
  });

  it("flags target_changed when matched_ref differs from last_ref", () => {
    let h = emptyHealth(t0);
    h = recordResolution(h, "s1", { matched_ref: 5, match_count: 1, tier: 1, used_relocate: false }, t1);
    h = recordResolution(h, "s1", { matched_ref: 7, match_count: 1, tier: 1, used_relocate: false }, t1);
    expect(h.steps["s1"]!.target_changed).toBe(1);
    expect(h.steps["s1"]!.last_ref).toBe(7);
  });

  it("does NOT flag target_changed on the first run (no prior ref)", () => {
    const h = recordResolution(
      emptyHealth(t0),
      "s1",
      { matched_ref: 5, match_count: 1, tier: 1, used_relocate: false },
      t1,
    );
    expect(h.steps["s1"]!.target_changed).toBe(0);
  });

  it("increments relocates when used_relocate is true", () => {
    let h = emptyHealth(t0);
    h = recordResolution(h, "s1", { matched_ref: 5, match_count: 1, tier: 2, used_relocate: true }, t1);
    expect(h.steps["s1"]!.relocates).toBe(1);
  });
});

describe("shouldDemoteFromHealth", () => {
  it("does not demote a fresh-from-bump_success procedure (no health yet)", () => {
    expect(shouldDemoteFromHealth(undefined)).toBe(false);
  });

  it("does not demote when each step is clean", () => {
    let h = emptyHealth(t0);
    h = recordN(h, "s1", { matched_ref: 5, match_count: 1, tier: 1, used_relocate: false }, 10);
    expect(shouldDemoteFromHealth(h)).toBe(false);
  });

  it("demotes when any step's relocate-rate > 0.4 across >=5 runs", () => {
    let h = emptyHealth(t0);
    h = recordN(h, "s1", { matched_ref: 5, match_count: 1, tier: 2, used_relocate: true }, 3);
    h = recordN(h, "s1", { matched_ref: 5, match_count: 1, tier: 1, used_relocate: false }, 2);
    // 3/5 = 0.6 > 0.4
    expect(shouldDemoteFromHealth(h)).toBe(true);
  });

  it("does NOT demote on relocate signal until at least 5 runs accumulated", () => {
    let h = emptyHealth(t0);
    h = recordN(h, "s1", { matched_ref: 5, match_count: 1, tier: 2, used_relocate: true }, 2);
    h = recordN(h, "s1", { matched_ref: 5, match_count: 1, tier: 1, used_relocate: false }, 2);
    // 2/4 above ratio but below minimum run count
    expect(shouldDemoteFromHealth(h)).toBe(false);
  });

  it("demotes when target_changed > 0 after >=3 runs", () => {
    let h = emptyHealth(t0);
    h = recordResolution(h, "s1", { matched_ref: 5, match_count: 1, tier: 1, used_relocate: false }, t1);
    h = recordResolution(h, "s1", { matched_ref: 5, match_count: 1, tier: 1, used_relocate: false }, t1);
    h = recordResolution(h, "s1", { matched_ref: 9, match_count: 1, tier: 1, used_relocate: false }, t1);
    expect(shouldDemoteFromHealth(h)).toBe(true);
  });

  it("demotes when last_tier=3 AND relocate-rate > 0.1 (fragile + actually drifting)", () => {
    let h = emptyHealth(t0);
    h = recordN(h, "s1", { matched_ref: 5, match_count: 1, tier: 3, used_relocate: true }, 1);
    h = recordN(h, "s1", { matched_ref: 5, match_count: 1, tier: 3, used_relocate: false }, 9);
    // 1/10 = 0.1 — not > 0.1, should NOT demote yet
    expect(shouldDemoteFromHealth(h)).toBe(false);
    h = recordResolution(h, "s1", { matched_ref: 5, match_count: 1, tier: 3, used_relocate: true }, t1);
    // 2/11 > 0.1 AND last_tier=3 — demote
    expect(shouldDemoteFromHealth(h)).toBe(true);
  });
});
