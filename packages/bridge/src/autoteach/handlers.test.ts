import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WSBridgeLike } from "../mcp-server.js";
import { TabRegistry } from "../tab-registry.js";
import { AutoTeachStore } from "./store.js";
import { AutoTeachBindings } from "./bindings.js";
import { buildAutoteachHandlers } from "./handlers.js";

let dir: string;
let proceduresDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "autoteach-handlers-test-"));
  proceduresDir = await fs.mkdtemp(join(tmpdir(), "autoteach-procedures-test-"));
  process.env["BROWSEROPS_AUTOTEACH_DIR"] = dir;
  process.env["BROWSEROPS_PROCEDURES_DIR"] = proceduresDir;
});

afterEach(async () => {
  delete process.env["BROWSEROPS_AUTOTEACH_DIR"];
  delete process.env["BROWSEROPS_PROCEDURES_DIR"];
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(proceduresDir, { recursive: true, force: true });
});

function makeBridge(opts?: {
  impl?: (method: string, params: Record<string, unknown>) => unknown;
  connected?: boolean;
}): WSBridgeLike {
  const callExtension = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (opts?.impl) return opts.impl(method, params);
    if (method === "teach_start") {
      return { session_id: "ts_test", started_at: Date.now() };
    }
    if (method === "browser_new_tab") {
      return { tab_id: "t_demo", url: typeof params["url"] === "string" ? params["url"] : "about:blank" };
    }
    return {};
  });
  return {
    isConnected: () => opts?.connected !== false,
    callExtension: callExtension as unknown as WSBridgeLike["callExtension"],
  };
}

function makeHandlers(opts?: {
  features?: ReadonlySet<"teach" | "procedures" | "autoteach" | "gated-domains">;
  bridge?: WSBridgeLike;
  mcpSessionId?: string;
  renameSession?: (name: string) => string | undefined;
}) {
  const store = new AutoTeachStore();
  const bindings = new AutoTeachBindings();
  const tabs = new TabRegistry();
  const features =
    opts?.features ?? new Set(["procedures", "teach", "autoteach"] as const);
  const handlers = buildAutoteachHandlers({
    wsBridge: opts?.bridge ?? makeBridge(),
    store,
    bindings,
    tabs,
    mcpSessionId: opts?.mcpSessionId ?? "",
    enabledFeatures: features,
    ...(opts?.renameSession !== undefined ? { renameSession: opts.renameSession } : {}),
  });
  return { store, bindings, tabs, handlers };
}

describe("autoteach handlers — start", () => {
  it("opens an explore-mode session without calling teach_start", async () => {
    const bridge = makeBridge();
    const { handlers } = makeHandlers({ bridge });
    const startResult = (await handlers["procedures_autoteach_start"]!({
      goal: "scrape a wiki page",
      mode: "explore",
      consent: { budget: 5, side_effect_policy: "read_only_only" },
    })) as { session_id: string; teach_session_id?: string; state: string };
    expect(startResult.session_id).toMatch(/^at_/);
    expect(startResult.teach_session_id).toBeUndefined();
    expect(startResult.state).toBe("exploring");
    expect(bridge.callExtension).not.toHaveBeenCalled();
  });

  it("opens an explore-mode session WITHOUT acquiring (legacy path)", async () => {
    const bridge = makeBridge();
    const { handlers } = makeHandlers({ bridge });
    const result = (await handlers["procedures_autoteach_start"]!({
      goal: "scrape a wiki page",
      mode: "explore",
      consent: { budget: 5, side_effect_policy: "read_only_only" },
    })) as { session_id: string; teach_session_id?: string; state: string };
    expect(result.session_id).toMatch(/^at_/);
    expect(result.teach_session_id).toBeUndefined();
    expect(result.state).toBe("exploring");
    expect(bridge.callExtension).not.toHaveBeenCalled();
  });

  it("acquires + binds a tab when start_url is provided", async () => {
    const bridge = makeBridge();
    const { handlers, store, bindings } = makeHandlers({ bridge });
    const result = (await handlers["procedures_autoteach_start"]!({
      goal: "open slack",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
      start_url: "https://app.slack.com",
    })) as { session_id: string; tab_id?: string };
    expect(result.tab_id).toBe("t_demo");
    expect(bridge.callExtension).toHaveBeenCalledWith(
      "browser_new_tab",
      expect.objectContaining({ url: "https://app.slack.com", active: true }),
      expect.any(Number),
    );
    const session = await store.get(result.session_id);
    expect(session?.attached_tab_id).toBe("t_demo");
    // run_index 0 is bound automatically — no need for explicit attach
    expect(bindings.get("t_demo")?.run_index).toBe(0);
  });

  it("acquires a blank tab when acquire_tab=true without start_url", async () => {
    const bridge = makeBridge();
    const { handlers } = makeHandlers({ bridge });
    const result = (await handlers["procedures_autoteach_start"]!({
      goal: "x",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
      acquire_tab: true,
    })) as { tab_id?: string };
    expect(result.tab_id).toBe("t_demo");
  });

  it("refuses tab acquisition when extension is disconnected", async () => {
    const bridge = makeBridge({ connected: false });
    const { handlers } = makeHandlers({ bridge });
    await expect(
      handlers["procedures_autoteach_start"]!({
        goal: "x",
        mode: "explore",
        consent: { budget: 1, side_effect_policy: "read_only_only" },
        start_url: "https://example.com",
      }),
    ).rejects.toThrow(/extension is not connected/);
  });

  it("applies session_name through renameSession when both are provided", async () => {
    const renameSession = vi.fn((name: string) => name + "-canonical");
    const { handlers } = makeHandlers({
      mcpSessionId: "owner_a",
      renameSession,
    });
    const result = (await handlers["procedures_autoteach_start"]!({
      goal: "x",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
      session_name: "auto-teach: send slack",
    })) as { session_name?: string };
    expect(renameSession).toHaveBeenCalledWith("auto-teach: send slack");
    expect(result.session_name).toBe("auto-teach: send slack-canonical");
  });

  it("opens a demo-mode session and threads the teach_session_id", async () => {
    const bridge = makeBridge();
    const { handlers, store } = makeHandlers({ bridge });
    const result = (await handlers["procedures_autoteach_start"]!({
      goal: "send a slack DM to dummy_user",
      mode: "demo",
      consent: { budget: "convergence", side_effect_policy: "use_dummies" },
    })) as { session_id: string; teach_session_id?: string; state: string };
    expect(result.teach_session_id).toBe("ts_test");
    expect(result.state).toBe("capturing_demo");
    expect(bridge.callExtension).toHaveBeenCalledWith(
      "teach_start",
      expect.objectContaining({ scope: "all_tabs" }),
      expect.any(Number),
    );
    const session = await store.get(result.session_id);
    expect(session?.teach_session_id).toBe("ts_test");
  });

  it("rejects demo mode when teach feature is off", async () => {
    const { handlers } = makeHandlers({
      features: new Set(["procedures", "autoteach"] as const),
    });
    await expect(
      handlers["procedures_autoteach_start"]!({
        goal: "test",
        mode: "demo",
        consent: { budget: 1, side_effect_policy: "use_dummies" },
      }),
    ).rejects.toThrow(/teach feature/);
  });

  it("rejects when procedures feature is off", async () => {
    const { handlers } = makeHandlers({
      features: new Set(["teach", "autoteach"] as const),
    });
    await expect(
      handlers["procedures_autoteach_start"]!({
        goal: "test",
        mode: "explore",
        consent: { budget: 1, side_effect_policy: "read_only_only" },
      }),
    ).rejects.toThrow(/procedures/);
  });

  it("rejects bad consent shape", async () => {
    const { handlers } = makeHandlers();
    await expect(
      handlers["procedures_autoteach_start"]!({
        goal: "test",
        mode: "explore",
        consent: { budget: 0, side_effect_policy: "read_only_only" },
      }),
    ).rejects.toThrow(/budget/);
  });
});

describe("autoteach handlers — attach + record_trace", () => {
  it("attach binds, record_trace returns the count and detaches", async () => {
    const { handlers, store, bindings } = makeHandlers();
    const startResult = (await handlers["procedures_autoteach_start"]!({
      goal: "x",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
    })) as { session_id: string };
    await handlers["procedures_autoteach_attach"]!({
      session_id: startResult.session_id,
      tab_id: "t_1",
      run_index: 0,
    });
    expect(bindings.size()).toBe(1);
    // Append two trace records as the dispatch path would.
    await store.appendTrace(startResult.session_id, {
      ts: 1,
      run_index: 0,
      method: "browser_navigate",
      params: { url: "https://example.com" },
      ok: true,
      duration_ms: 100,
    });
    await store.appendTrace(startResult.session_id, {
      ts: 2,
      run_index: 0,
      method: "browser_click",
      params: { ref: 1 },
      ok: true,
      duration_ms: 50,
    });
    const recordResult = (await handlers["procedures_autoteach_record_trace"]!({
      session_id: startResult.session_id,
      run_index: 0,
    })) as { record_count: number };
    expect(recordResult.record_count).toBe(2);
    expect(bindings.size()).toBe(0);
  });

  it("attach refuses cross-MCP-session binding", async () => {
    const { handlers } = makeHandlers({ mcpSessionId: "owner_a" });
    const result = (await handlers["procedures_autoteach_start"]!({
      goal: "x",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
    })) as { session_id: string };
    const otherSession = makeHandlers({ mcpSessionId: "owner_b" });
    await expect(
      otherSession.handlers["procedures_autoteach_attach"]!({
        session_id: result.session_id,
        tab_id: "t_x",
        run_index: 0,
      }),
    ).rejects.toThrow(/different MCP session/);
  });
});

describe("autoteach handlers — distill + record_run + status", () => {
  it("end-to-end: distill writes a draft; record_run logs metrics; status returns convergence", async () => {
    const { handlers, store } = makeHandlers();
    const start = (await handlers["procedures_autoteach_start"]!({
      goal: "open hacker news",
      mode: "explore",
      consent: { budget: "convergence", side_effect_policy: "read_only_only" },
    })) as { session_id: string };
    // Seed a synthetic trace for run 0.
    await store.appendTrace(start.session_id, {
      ts: 1,
      run_index: 0,
      method: "browser_navigate",
      params: { url: "https://news.ycombinator.com" },
      ok: true,
      duration_ms: 500,
      page_effect: {
        dom: { added: 12, removed: 0, attr_changes: 0, text_changes: 0 },
        url: { changed: true, after: "https://news.ycombinator.com" },
        focus: { changed: false },
        network: { requests_started: 5, requests_completed: 5, in_flight_at_end: 0 },
        console_errors: 0,
        window_ms: 300,
      },
    });
    const distill = (await handlers["procedures_autoteach_distill"]!({
      session_id: start.session_id,
    })) as { draft_version: number; leaves: Array<{ name: string; fragility: string }>; yaml: string };
    expect(distill.draft_version).toBe(1);
    expect(distill.leaves[0]?.name).toMatch(/^ycombinator\./);
    expect(distill.yaml).toContain("schema_version: 1");

    const r0 = (await handlers["procedures_autoteach_record_run"]!({
      session_id: start.session_id,
      run_index: 0,
      metrics: { tool_count: 1, wall_clock_ms: 500 },
    })) as { outcome: string };
    expect(r0.outcome).toBe("improved");

    const r1 = (await handlers["procedures_autoteach_record_run"]!({
      session_id: start.session_id,
      run_index: 1,
      metrics: { tool_count: 1, wall_clock_ms: 500 },
    })) as { outcome: string };
    expect(r1.outcome).toBe("noop");

    const status = (await handlers["procedures_autoteach_status"]!({
      session_id: start.session_id,
    })) as { history: unknown[]; convergence: { verdict: string }; leaves: unknown[] };
    expect(status.history).toHaveLength(2);
    expect(["improving", "converged", "stalled"]).toContain(status.convergence.verdict);
    expect(status.leaves).toHaveLength(1);
  });

  it("regressed run is reported correctly", async () => {
    const { handlers, store } = makeHandlers();
    const start = (await handlers["procedures_autoteach_start"]!({
      goal: "x",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
    })) as { session_id: string };
    await store.appendRun(start.session_id, {
      run_id: "r0",
      run_index: 0,
      started_at: 1,
      tool_count: 5,
      wall_clock_ms: 1000,
      retries: 0,
      errors: [],
      outcome: "improved",
      trace_ref: "trace.jsonl#run_0",
    });
    const r1 = (await handlers["procedures_autoteach_record_run"]!({
      session_id: start.session_id,
      run_index: 1,
      metrics: { tool_count: 8, wall_clock_ms: 1500 },
    })) as { outcome: string };
    expect(r1.outcome).toBe("regressed");
  });
});

describe("autoteach handlers — list + resume", () => {
  it("list returns sessions for the calling MCP owner only", async () => {
    const a = makeHandlers({ mcpSessionId: "owner_a" });
    const b = makeHandlers({ mcpSessionId: "owner_b" });
    await a.handlers["procedures_autoteach_start"]!({
      goal: "alice",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
    });
    await b.handlers["procedures_autoteach_start"]!({
      goal: "bob",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
    });
    const aList = (await a.handlers["procedures_autoteach_list"]!({})) as {
      sessions: Array<{ goal: string }>;
    };
    expect(aList.sessions).toHaveLength(1);
    expect(aList.sessions[0]?.goal).toBe("alice");
  });

  it("resume rehydrates a session by id", async () => {
    const { handlers } = makeHandlers();
    const start = (await handlers["procedures_autoteach_start"]!({
      goal: "later",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
    })) as { session_id: string };
    const resumed = (await handlers["procedures_autoteach_resume"]!({
      session_id: start.session_id,
    })) as { session: { session_id: string }; convergence: { verdict: string } };
    expect(resumed.session.session_id).toBe(start.session_id);
    expect(resumed.convergence.verdict).toBe("improving");
  });
});

describe("autoteach handlers — finalize", () => {
  it("variance gate fails for sessions without enough runs", async () => {
    const { handlers, store } = makeHandlers();
    const start = (await handlers["procedures_autoteach_start"]!({
      goal: "x",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
    })) as { session_id: string };
    await store.appendTrace(start.session_id, {
      ts: 1,
      run_index: 0,
      method: "browser_navigate",
      params: { url: "https://example.com" },
      ok: true,
      duration_ms: 50,
    });
    await handlers["procedures_autoteach_distill"]!({ session_id: start.session_id });
    const result = (await handlers["procedures_autoteach_finalize"]!({
      session_id: start.session_id,
    })) as { saved: string[]; failed: Array<{ reason: string }> };
    expect(result.saved).toHaveLength(0);
    expect(result.failed[0]?.reason).toMatch(/variance gate/);
  });

  it("force=true skips the gate and promotes the draft", async () => {
    const { handlers, store } = makeHandlers();
    const start = (await handlers["procedures_autoteach_start"]!({
      goal: "scrape something",
      mode: "explore",
      consent: { budget: 1, side_effect_policy: "read_only_only" },
    })) as { session_id: string };
    await store.appendTrace(start.session_id, {
      ts: 1,
      run_index: 0,
      method: "browser_navigate",
      params: { url: "https://example.com/path" },
      ok: true,
      duration_ms: 50,
    });
    await handlers["procedures_autoteach_distill"]!({ session_id: start.session_id });
    const result = (await handlers["procedures_autoteach_finalize"]!({
      session_id: start.session_id,
      force: true,
    })) as { saved: string[]; failed: unknown[] };
    expect(result.saved.length).toBeGreaterThanOrEqual(1);
    expect(result.failed).toHaveLength(0);
  });
});
