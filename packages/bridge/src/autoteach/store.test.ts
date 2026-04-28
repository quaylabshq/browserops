import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutoTeachStore, computeOutcome } from "./store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "autoteach-test-"));
  process.env["BROWSEROPS_AUTOTEACH_DIR"] = dir;
});

afterEach(async () => {
  delete process.env["BROWSEROPS_AUTOTEACH_DIR"];
  await fs.rm(dir, { recursive: true, force: true });
});

describe("AutoTeachStore", () => {
  it("creates and reloads a session", async () => {
    const store = new AutoTeachStore();
    const created = await store.create({
      goal: "send a slack DM to a dummy",
      mode: "demo",
      consent: { budget: "convergence", side_effect_policy: "use_dummies" },
      owner_session_id: "owner_1",
      teach_session_id: "ts_abc",
    });
    expect(created.session_id).toMatch(/^at_/);
    expect(created.state).toBe("capturing_demo");
    expect(created.teach_session_id).toBe("ts_abc");
    expect(created.draft_version).toBe(0);

    const reloaded = await store.get(created.session_id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.goal).toBe("send a slack DM to a dummy");
    expect(reloaded?.owner_session_id).toBe("owner_1");
  });

  it("explore mode lands in 'exploring' state", async () => {
    const store = new AutoTeachStore();
    const s = await store.create({
      goal: "scrape a page",
      mode: "explore",
      consent: { budget: 5, side_effect_policy: "read_only_only" },
      owner_session_id: "",
    });
    expect(s.state).toBe("exploring");
    expect(s.owner_session_id).toBeUndefined();
  });

  it("appends and reads trace records filtered by run_index", async () => {
    const store = new AutoTeachStore();
    const s = await store.create({
      goal: "x",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
      owner_session_id: "",
    });
    await store.appendTrace(s.session_id, {
      ts: 1,
      run_index: 0,
      method: "browser_navigate",
      params: { url: "https://example.com" },
      ok: true,
      duration_ms: 100,
    });
    await store.appendTrace(s.session_id, {
      ts: 2,
      run_index: 1,
      method: "browser_click",
      params: { ref: 1 },
      ok: true,
      duration_ms: 50,
    });
    const all = await store.readTrace(s.session_id);
    expect(all).toHaveLength(2);
    const onlyRun1 = await store.readTrace(s.session_id, 1);
    expect(onlyRun1).toHaveLength(1);
    expect(onlyRun1[0]?.method).toBe("browser_click");
  });

  it("appends runs and picks the best one", async () => {
    const store = new AutoTeachStore();
    const s = await store.create({
      goal: "x",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
      owner_session_id: "",
    });
    await store.appendRun(s.session_id, {
      run_id: "r0",
      run_index: 0,
      started_at: 1,
      tool_count: 10,
      wall_clock_ms: 1000,
      retries: 0,
      errors: [],
      outcome: "improved",
      trace_ref: "trace.jsonl#run_0",
    });
    await store.appendRun(s.session_id, {
      run_id: "r1",
      run_index: 1,
      started_at: 2,
      tool_count: 8,
      wall_clock_ms: 900,
      retries: 0,
      errors: [],
      outcome: "improved",
      trace_ref: "trace.jsonl#run_1",
    });
    await store.appendRun(s.session_id, {
      run_id: "r2",
      run_index: 2,
      started_at: 3,
      tool_count: 100,
      wall_clock_ms: 5000,
      retries: 1,
      errors: ["TIMEOUT"],
      outcome: "failed",
      trace_ref: "trace.jsonl#run_2",
    });
    const best = await store.bestRun(s.session_id);
    expect(best?.run_index).toBe(1);
    expect(best?.tool_count).toBe(8);
  });

  it("writes drafts and bumps draft_version", async () => {
    const store = new AutoTeachStore();
    const s = await store.create({
      goal: "x",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
      owner_session_id: "",
    });
    expect(s.draft_version).toBe(0);
    const v1 = await store.writeDraft(s.session_id, "schema_version: 1\n");
    expect(v1).toBe(1);
    const v2 = await store.writeDraft(s.session_id, "schema_version: 1\n# v2\n");
    expect(v2).toBe(2);
    const reloaded = await store.get(s.session_id);
    expect(reloaded?.draft_version).toBe(2);
    const latest = await store.readDraft(s.session_id);
    expect(latest).toContain("# v2");
  });

  it("require() throws PROC_NOT_FOUND for missing session", async () => {
    const store = new AutoTeachStore();
    await expect(store.require("at_nope")).rejects.toThrow(/not found/);
  });

  it("list filters by owner_session_id", async () => {
    const store = new AutoTeachStore();
    await store.create({
      goal: "alice",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
      owner_session_id: "alice",
    });
    await store.create({
      goal: "bob",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
      owner_session_id: "bob",
    });
    const aliceOnly = await store.list("alice");
    expect(aliceOnly).toHaveLength(1);
    expect(aliceOnly[0]?.goal).toBe("alice");
    const all = await store.list();
    expect(all.length).toBe(2);
  });
});

describe("computeOutcome", () => {
  it("first successful run is 'improved'", () => {
    const r = computeOutcome(
      { tool_count: 10, wall_clock_ms: 1000, succeeded: true },
      null,
    );
    expect(r.outcome).toBe("improved");
  });

  it("identical metrics → noop", () => {
    const r = computeOutcome(
      { tool_count: 10, wall_clock_ms: 1000, succeeded: true },
      { tool_count: 10, wall_clock_ms: 1000 },
    );
    expect(r.outcome).toBe("noop");
  });

  it("fewer tool calls → improved", () => {
    const r = computeOutcome(
      { tool_count: 8, wall_clock_ms: 1000, succeeded: true },
      { tool_count: 10, wall_clock_ms: 1000 },
    );
    expect(r.outcome).toBe("improved");
    expect(r.delta.tool_count).toBe(-2);
  });

  it("more tool calls → regressed", () => {
    const r = computeOutcome(
      { tool_count: 12, wall_clock_ms: 1000, succeeded: true },
      { tool_count: 10, wall_clock_ms: 1000 },
    );
    expect(r.outcome).toBe("regressed");
  });

  it("same tool count, wall-clock under 5% noise floor → noop", () => {
    const r = computeOutcome(
      { tool_count: 10, wall_clock_ms: 1040, succeeded: true },
      { tool_count: 10, wall_clock_ms: 1000 },
    );
    expect(r.outcome).toBe("noop");
  });

  it("same tool count, wall-clock improvement above noise floor → improved", () => {
    const r = computeOutcome(
      { tool_count: 10, wall_clock_ms: 800, succeeded: true },
      { tool_count: 10, wall_clock_ms: 1000 },
    );
    expect(r.outcome).toBe("improved");
  });

  it("succeeded=false short-circuits to failed", () => {
    const r = computeOutcome(
      { tool_count: 0, wall_clock_ms: 0, succeeded: false },
      { tool_count: 10, wall_clock_ms: 1000 },
    );
    expect(r.outcome).toBe("failed");
  });
});
