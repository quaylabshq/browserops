import { describe, expect, it, beforeEach } from "vitest";
import type { ProcedureDef } from "@browserops/shared";
import {
  EXECUTION_TTL_MS,
  _activeStateCount,
  _resetForTests,
  createState,
  dropState,
  getState,
} from "./state.js";

const procedure: ProcedureDef = {
  schema_version: 1,
  name: "demo.test",
  description: "Test procedure",
  kind: "leaf",
  steps: [{ id: "s1", do: "navigate", with: { url: "x" } }],
};

beforeEach(() => {
  _resetForTests();
});

describe("execution state", () => {
  it("createState stores and returns a fresh state", () => {
    const s = createState({
      procedure: procedure,
      tab_id: "t_1",
      inputs: {},
      paused_at: 0,
      step_results: [],
      divergence: { step_id: "s1", step_index: 0, reason: "test" },
      strict: true,
    });
    expect(s.execution_id).toMatch(/^ex_/);
    expect(_activeStateCount()).toBe(1);
  });

  it("getState returns by id", () => {
    const s = createState({
      procedure: procedure,
      tab_id: "t_1",
      inputs: {},
      paused_at: 0,
      step_results: [],
      divergence: { step_id: "s1", step_index: 0, reason: "test" },
      strict: true,
    });
    expect(getState(s.execution_id)?.execution_id).toBe(s.execution_id);
  });

  it("dropState removes the entry", () => {
    const s = createState({
      procedure: procedure,
      tab_id: "t_1",
      inputs: {},
      paused_at: 0,
      step_results: [],
      divergence: { step_id: "s1", step_index: 0, reason: "test" },
      strict: true,
    });
    expect(dropState(s.execution_id)).toBe(true);
    expect(getState(s.execution_id)).toBeUndefined();
  });

  it("evicts entries past their TTL on access", () => {
    const s = createState({
      procedure: procedure,
      tab_id: "t_1",
      inputs: {},
      paused_at: 0,
      step_results: [],
      divergence: { step_id: "s1", step_index: 0, reason: "test" },
      strict: true,
    });
    // Backdate expiration
    s.expires_at = Date.now() - 1;
    const after = getState(s.execution_id);
    expect(after).toBeUndefined();
    expect(_activeStateCount()).toBe(0);
  });

  it("TTL is 5 minutes by default", () => {
    const s = createState({
      procedure: procedure,
      tab_id: "t_1",
      inputs: {},
      paused_at: 0,
      step_results: [],
      divergence: { step_id: "s1", step_index: 0, reason: "test" },
      strict: true,
    });
    expect(s.expires_at - s.created_at).toBe(EXECUTION_TTL_MS);
  });
});
