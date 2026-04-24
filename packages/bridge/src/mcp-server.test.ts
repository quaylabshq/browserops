/**
 * Tests for TraceEvent emission in McpBridgeServer.dispatch.
 *
 * Each test constructs a minimal McpBridgeDeps, invokes the server's
 * CallToolRequest handler by calling the internal dispatch path via the
 * public server.setRequestHandler callback, then inspects what was passed
 * to traceWriter.append.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  McpBridgeServer,
  TabHostnameCache,
  computeObservedHints,
  ESCALATE_MIN_SYNTHETIC_SAMPLES,
  ESCALATE_MAX_SYNTHETIC_EFFECT_RATE,
  ESCALATE_MIN_TRUSTED_EFFECT_RATE,
  type McpBridgeDeps,
  type WSBridgeLike,
  type ObservedHints,
} from "./mcp-server.js";
import { RateLimiter } from "./rate-limiter.js";
import { TabRegistry } from "./tab-registry.js";
import type { Safety } from "./safety.js";
import type { Logger } from "./logger.js";
import type { TraceWriter } from "./trace-writer.js";
import type { ObservedFactsStore, ObservedFact } from "./observed-facts.js";
import type { TraceEvent } from "@browserops/shared";

// ---------------------------------------------------------------------------
// Minimal mock factory helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return { write: vi.fn().mockResolvedValue(undefined), close: vi.fn() } as unknown as Logger;
}

function makeConnectedBridge(result: unknown = { ok: true }): WSBridgeLike {
  return {
    isConnected: () => true,
    callExtension: vi.fn().mockResolvedValue(result),
  };
}

function makeDisconnectedBridge(): WSBridgeLike {
  return {
    isConnected: () => false,
    callExtension: vi.fn(),
  };
}

function makeFailingBridge(err: Error): WSBridgeLike {
  return {
    isConnected: () => true,
    callExtension: vi.fn().mockRejectedValue(err),
  };
}

function makeSafety(): Safety {
  return {
    checkRisky: vi.fn().mockReturnValue({ risky: false }),
    requireApproval: vi.fn().mockResolvedValue({ allow: true }),
  } as unknown as Safety;
}

function makeEnabledTraceWriter(): { writer: TraceWriter; calls: TraceEvent[] } {
  const calls: TraceEvent[] = [];
  const writer: TraceWriter = {
    enabled: true,
    append: vi.fn((ev: TraceEvent) => calls.push(ev)),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { writer, calls };
}

function makeDisabledTraceWriter(): TraceWriter {
  return {
    enabled: false,
    append: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeObservedFacts(): ObservedFactsStore {
  return {
    getFacts: vi.fn().mockReturnValue([]),
    recordObservation: vi.fn(),
    snapshot: vi.fn().mockReturnValue([]),
    save: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** Minimal PageEffect-shaped object with controllable "activity". */
function makePageEffect(opts: {
  domAdded?: number;
  domRemoved?: number;
  attrChanges?: number;
  textChanges?: number;
  urlChanged?: boolean;
  focusChanged?: boolean;
  networkStarted?: number;
} = {}) {
  return {
    dom: {
      added: opts.domAdded ?? 0,
      removed: opts.domRemoved ?? 0,
      attr_changes: opts.attrChanges ?? 0,
      text_changes: opts.textChanges ?? 0,
    },
    url: { changed: opts.urlChanged ?? false },
    focus: { changed: opts.focusChanged ?? false },
    network: {
      requests_started: opts.networkStarted ?? 0,
      requests_completed: 0,
      in_flight_at_end: 0,
    },
    console_errors: 0,
    window_ms: 100,
  };
}

function makeDeps(overrides: Partial<McpBridgeDeps> = {}): McpBridgeDeps {
  return {
    wsBridge: makeConnectedBridge(),
    rateLimiter: new RateLimiter(100, 1000),
    safety: makeSafety(),
    tabs: new TabRegistry(),
    logger: makeLogger(),
    version: "0.0.0-test",
    ...overrides,
  };
}

/**
 * Drive a tools/call by accessing the server's private dispatch via a small
 * wrapper: build the server, then invoke the CallToolRequest handler directly
 * via the SDK internals. We do this by accessing the underlying Server's
 * internal `_requestHandlers` map which is available in the MCP SDK.
 *
 * Simpler approach: expose `dispatch` through a thin test helper that calls
 * `server["dispatch"]` using bracket notation (TypeScript allows this on
 * `McpBridgeServer` via `as any`).
 */
async function callTool(
  deps: McpBridgeDeps,
  name: string,
  args: Record<string, unknown> = {},
  requestId: string = "req-test-1",
) {
  const srv = new McpBridgeServer(deps);
  // Access the private dispatch method via type cast — this avoids needing
  // a real MCP transport while still exercising the full dispatch pipeline.
  type Dispatchable = {
    dispatch(
      req: { params: { name: string; arguments?: Record<string, unknown> } },
      extra: { signal?: AbortSignal; requestId?: string | number },
    ): Promise<unknown>;
  };
  return (srv as unknown as Dispatchable).dispatch(
    { params: { name, arguments: args } },
    { requestId },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("McpBridgeServer — TraceEvent emission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Successful tool call → event written
  // -------------------------------------------------------------------------

  it("emits a TraceEvent on a successful tool call", async () => {
    const extResponse = { tab_id: "t_1", url: "https://example.com" };
    const { writer, calls } = makeEnabledTraceWriter();
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResponse),
      traceWriter: writer,
    });

    await callTool(deps, "browser_navigate", { tab_id: "t_1", url: "https://example.com" }, "req-1");

    expect(calls).toHaveLength(1);
    const ev = calls[0]!;
    expect(ev.id).toBe("req-1");
    expect(ev.tool_name).toBe("browser_navigate");
    expect(ev.result.ok).toBe(true);
    if (ev.result.ok) {
      expect(ev.result.value).toMatchObject(extResponse);
    }
    expect(typeof ev.duration_ms).toBe("number");
    expect(ev.duration_ms).toBeGreaterThanOrEqual(0);
    expect(ev.input).toMatchObject({ tab_id: "t_1", url: "https://example.com" });
    expect(ev.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // -------------------------------------------------------------------------
  // Failed tool call → error event with code + message
  // -------------------------------------------------------------------------

  it("emits a TraceEvent with structured error when the extension call throws", async () => {
    const err = Object.assign(new Error("element not found"), { code: "REF_NOT_FOUND" });
    const { writer, calls } = makeEnabledTraceWriter();
    const deps = makeDeps({
      wsBridge: makeFailingBridge(err),
      traceWriter: writer,
    });

    // ref is an integer per refSchema (minimum: 1)
    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 42 }, "req-err");

    expect(calls).toHaveLength(1);
    const ev = calls[0]!;
    expect(ev.id).toBe("req-err");
    expect(ev.tool_name).toBe("browser_click");
    expect(ev.result.ok).toBe(false);
    if (!ev.result.ok) {
      expect(ev.result.error_code).toBe("REF_NOT_FOUND");
      expect(ev.result.error_message).toBe("element not found");
    }
  });

  it("emits a TraceEvent with EXTENSION_DISCONNECTED when bridge is offline", async () => {
    const { writer, calls } = makeEnabledTraceWriter();
    const deps = makeDeps({
      wsBridge: makeDisconnectedBridge(),
      traceWriter: writer,
    });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 42 }, "req-disc");

    expect(calls).toHaveLength(1);
    const ev = calls[0]!;
    expect(ev.result.ok).toBe(false);
    if (!ev.result.ok) {
      expect(ev.result.error_code).toBe("EXTENSION_DISCONNECTED");
    }
  });

  it("emits a TraceEvent with RATE_LIMITED when rate limit is exceeded", async () => {
    const { writer, calls } = makeEnabledTraceWriter();
    // Use a limiter with 0 capacity so first call is denied.
    const limiter = new RateLimiter(0, 0);
    const deps = makeDeps({
      rateLimiter: limiter,
      traceWriter: writer,
    });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 42 }, "req-rl");

    expect(calls).toHaveLength(1);
    const ev = calls[0]!;
    expect(ev.result.ok).toBe(false);
    if (!ev.result.ok) {
      expect(ev.result.error_code).toBe("RATE_LIMITED");
    }
  });

  // -------------------------------------------------------------------------
  // Tracing disabled → no event written
  // -------------------------------------------------------------------------

  it("does not write any event when traceWriter is disabled", async () => {
    const disabledWriter = makeDisabledTraceWriter();
    // Use a connected bridge so the call reaches the extension path, not a
    // validation short-circuit.
    const deps = makeDeps({ traceWriter: disabledWriter, wsBridge: makeConnectedBridge({ final_url: "https://example.com" }) });

    await callTool(deps, "browser_navigate", { tab_id: "t_1", url: "https://example.com" });

    expect(disabledWriter.append).not.toHaveBeenCalled();
  });

  it("does not write any event when traceWriter is absent (undefined)", async () => {
    const deps = makeDeps(); // no traceWriter field → undefined
    // Should complete without error and no crash.
    await expect(
      callTool(deps, "browser_navigate", { tab_id: "t_1", url: "https://example.com" }),
    ).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // procedures_* meta RPC → no event written
  // -------------------------------------------------------------------------

  it("does not emit a TraceEvent for procedures_list (meta RPC)", async () => {
    const { writer, calls } = makeEnabledTraceWriter();
    const deps = makeDeps({ traceWriter: writer });

    // procedures_list takes no required arguments — pass empty object.
    await callTool(deps, "procedures_list", {}, "req-plist");

    // Procedure handlers are in-process and intentionally not traced.
    expect(calls).toHaveLength(0);
  });

  it("does not emit a TraceEvent for procedures_search (meta RPC)", async () => {
    const { writer, calls } = makeEnabledTraceWriter();
    const deps = makeDeps({ traceWriter: writer });

    await callTool(deps, "procedures_search", { query: "gmail" }, "req-psearch");

    expect(calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Event shape validation
  // -------------------------------------------------------------------------

  it("TraceEvent id matches the MCP request id", async () => {
    const { writer, calls } = makeEnabledTraceWriter();
    const deps = makeDeps({ traceWriter: writer });

    await callTool(deps, "browser_navigate", { tab_id: "t_1", url: "https://example.com" }, "my-unique-req-id");

    expect(calls[0]?.id).toBe("my-unique-req-id");
  });

  it("TraceEvent input captures the full params object", async () => {
    const { writer, calls } = makeEnabledTraceWriter();
    const inputParams = { tab_id: "t_2", url: "https://example.com/path?q=1" };
    const deps = makeDeps({ traceWriter: writer });

    await callTool(deps, "browser_navigate", inputParams, "req-input");

    expect(calls[0]?.input).toEqual(inputParams);
  });
});

// ---------------------------------------------------------------------------
// ObservedFacts recording
// ---------------------------------------------------------------------------

describe("McpBridgeServer — ObservedFacts recording", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // browser_click — had_effect derivation
  // -------------------------------------------------------------------------

  it("records observation with had_effect:true for browser_click with DOM changes", async () => {
    const store = makeObservedFacts();
    const extResult = {
      clicked: true,
      mode: "synthetic",
      mode_used: "synthetic",
      site: "example.com",
      page_effect: makePageEffect({ domAdded: 3 }),
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 42 }, "req-obs-1");

    expect(store.recordObservation).toHaveBeenCalledOnce();
    expect(store.recordObservation).toHaveBeenCalledWith({
      hostname: "example.com",
      action_class: "click",
      dispatch_mode: "synthetic",
      had_effect: true,
    });
  });

  it("records observation with had_effect:false for browser_click with zero-effect page_effect", async () => {
    const store = makeObservedFacts();
    const extResult = {
      clicked: true,
      mode: "synthetic",
      mode_used: "synthetic",
      site: "example.com",
      page_effect: makePageEffect(),
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    // Pin mode:"synthetic" explicitly so the auto-retry-on-zero-effect
    // path is suppressed — this test is specifically about the observation
    // recording for a single synthetic attempt. Auto-retry behaviour has
    // its own tests below.
    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 42, mode: "synthetic" }, "req-obs-2");

    expect(store.recordObservation).toHaveBeenCalledOnce();
    expect(store.recordObservation).toHaveBeenCalledWith({
      hostname: "example.com",
      action_class: "click",
      dispatch_mode: "synthetic",
      had_effect: false,
    });
  });

  it("does not record when page_effect is absent from browser_click result", async () => {
    const store = makeObservedFacts();
    const extResult = {
      clicked: true,
      mode: "synthetic",
      mode_used: "synthetic",
      site: "example.com",
      // No page_effect field — observe_effects:false or observation failure.
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 42 }, "req-obs-3");

    expect(store.recordObservation).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Failed tool call → no recording
  // -------------------------------------------------------------------------

  it("does not record observation when the extension call fails", async () => {
    const store = makeObservedFacts();
    const err = Object.assign(new Error("element not found"), { code: "REF_NOT_FOUND" });
    const deps = makeDeps({
      wsBridge: makeFailingBridge(err),
      observedFacts: store,
    });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 42 }, "req-obs-fail");

    expect(store.recordObservation).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // browser_navigate — excluded from this phase
  // -------------------------------------------------------------------------

  it("does not record observation for browser_navigate", async () => {
    const store = makeObservedFacts();
    const extResult = {
      navigated: true,
      final_url: "https://example.com",
      site: "example.com",
      page_effect: makePageEffect({ urlChanged: true }),
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    await callTool(deps, "browser_navigate", { tab_id: "t_1", url: "https://example.com" }, "req-obs-nav");

    expect(store.recordObservation).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // observedFacts disabled (absent) → no recording
  // -------------------------------------------------------------------------

  it("does not record observation when observedFacts is absent from deps", async () => {
    const extResult = {
      clicked: true,
      mode: "synthetic",
      mode_used: "synthetic",
      site: "example.com",
      page_effect: makePageEffect({ domAdded: 1 }),
    };
    // makeDeps does not include observedFacts by default.
    const deps = makeDeps({ wsBridge: makeConnectedBridge(extResult) });

    // Should resolve without error.
    await expect(
      callTool(deps, "browser_click", { tab_id: "t_1", ref: 42 }, "req-obs-absent"),
    ).resolves.not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Dispatch mode mapping — browser_click
  // -------------------------------------------------------------------------

  it("maps mode_used:trusted → dispatch_mode:trusted for browser_click", async () => {
    const store = makeObservedFacts();
    const extResult = {
      clicked: true,
      mode: "trusted",
      mode_used: "trusted",
      site: "github.com",
      page_effect: makePageEffect({ focusChanged: true }),
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 7 }, "req-obs-click-trusted");

    expect(store.recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({ dispatch_mode: "trusted", had_effect: true }),
    );
  });

  // -------------------------------------------------------------------------
  // Dispatch mode mapping — browser_type
  // -------------------------------------------------------------------------

  it("maps mode_used:insertText → dispatch_mode:insertText for browser_type", async () => {
    const store = makeObservedFacts();
    const extResult = {
      typed: true,
      mode: "paste",
      mode_used: "insertText",
      site: "notion.so",
      page_effect: makePageEffect({ textChanges: 5 }),
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    await callTool(deps, "browser_type", { tab_id: "t_1", ref: 3, text: "hello" }, "req-obs-type-insert");

    expect(store.recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        action_class: "type",
        dispatch_mode: "insertText",
        had_effect: true,
      }),
    );
  });

  it("maps mode_used:keystroke → dispatch_mode:synthetic for browser_type", async () => {
    const store = makeObservedFacts();
    const extResult = {
      typed: true,
      mode: "keystroke",
      mode_used: "keystroke",
      site: "app.example.com",
      page_effect: makePageEffect({ textChanges: 2 }),
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    await callTool(deps, "browser_type", { tab_id: "t_1", ref: 3, text: "hi" }, "req-obs-type-keystroke");

    expect(store.recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({ action_class: "type", dispatch_mode: "synthetic" }),
    );
  });

  it("maps mode_used:paste → dispatch_mode:synthetic for browser_type", async () => {
    const store = makeObservedFacts();
    const extResult = {
      typed: true,
      mode: "paste",
      mode_used: "paste",
      site: "app.example.com",
      page_effect: makePageEffect({ textChanges: 1 }),
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    await callTool(deps, "browser_type", { tab_id: "t_1", ref: 3, text: "pasted" }, "req-obs-type-paste");

    expect(store.recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({ action_class: "type", dispatch_mode: "synthetic" }),
    );
  });

  it("maps mode_used:trusted → dispatch_mode:trusted for browser_type", async () => {
    const store = makeObservedFacts();
    const extResult = {
      typed: true,
      mode: "trusted",
      mode_used: "trusted",
      site: "gmail.com",
      page_effect: makePageEffect({ textChanges: 3 }),
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    await callTool(deps, "browser_type", { tab_id: "t_1", ref: 3, text: "body text" }, "req-obs-type-trusted");

    expect(store.recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({ action_class: "type", dispatch_mode: "trusted" }),
    );
  });

  // -------------------------------------------------------------------------
  // Dispatch mode mapping — browser_press
  // -------------------------------------------------------------------------

  it("maps dispatch:trusted → dispatch_mode:trusted for browser_press", async () => {
    const store = makeObservedFacts();
    const extResult = {
      pressed: true,
      dispatch: "trusted",
      site: "notion.so",
      page_effect: makePageEffect({ networkStarted: 1 }),
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    await callTool(
      deps,
      "browser_press",
      { tab_id: "t_1", keys: ["Enter"] },
      "req-obs-press-trusted",
    );

    expect(store.recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        action_class: "press",
        dispatch_mode: "trusted",
        had_effect: true,
      }),
    );
  });

  it("maps dispatch:synthetic → dispatch_mode:synthetic for browser_press", async () => {
    const store = makeObservedFacts();
    const extResult = {
      pressed: true,
      dispatch: "synthetic",
      site: "example.com",
      page_effect: makePageEffect(),
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    await callTool(
      deps,
      "browser_press",
      { tab_id: "t_1", keys: ["Escape"] },
      "req-obs-press-synthetic",
    );

    expect(store.recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        action_class: "press",
        dispatch_mode: "synthetic",
        had_effect: false,
      }),
    );
  });

  // -------------------------------------------------------------------------
  // had_effect derivation — individual signals
  // -------------------------------------------------------------------------

  it("had_effect:true when url.changed is true", async () => {
    const store = makeObservedFacts();
    const extResult = {
      clicked: true,
      mode: "synthetic",
      mode_used: "synthetic",
      site: "example.com",
      page_effect: makePageEffect({ urlChanged: true }),
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 1 }, "req-obs-url");

    expect(store.recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({ had_effect: true }),
    );
  });

  it("had_effect:true when focus.changed is true", async () => {
    const store = makeObservedFacts();
    const extResult = {
      clicked: true,
      mode: "synthetic",
      mode_used: "synthetic",
      site: "example.com",
      page_effect: makePageEffect({ focusChanged: true }),
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 1 }, "req-obs-focus");

    expect(store.recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({ had_effect: true }),
    );
  });

  it("had_effect:true when network.requests_started > 0", async () => {
    const store = makeObservedFacts();
    const extResult = {
      clicked: true,
      mode: "synthetic",
      mode_used: "synthetic",
      site: "api.example.com",
      page_effect: makePageEffect({ networkStarted: 2 }),
    };
    const deps = makeDeps({
      wsBridge: makeConnectedBridge(extResult),
      observedFacts: store,
    });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 1 }, "req-obs-network");

    expect(store.recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({ had_effect: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// TabHostnameCache
// ---------------------------------------------------------------------------

describe("TabHostnameCache", () => {
  it("set and get returns the stored hostname", () => {
    const cache = new TabHostnameCache();
    cache.set("t_1", "example.com");
    expect(cache.get("t_1")).toBe("example.com");
  });

  it("get returns undefined for unknown tab", () => {
    const cache = new TabHostnameCache();
    expect(cache.get("t_unknown")).toBeUndefined();
  });

  it("set overwrites an existing entry", () => {
    const cache = new TabHostnameCache();
    cache.set("t_1", "old.com");
    cache.set("t_1", "new.com");
    expect(cache.get("t_1")).toBe("new.com");
  });
});

// ---------------------------------------------------------------------------
// computeObservedHints
// ---------------------------------------------------------------------------

function makeFact(overrides: Partial<ObservedFact>): ObservedFact {
  return {
    hostname: "example.com",
    action_class: "click",
    dispatch_mode: "synthetic",
    samples: 1,
    effect_count: 0,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("computeObservedHints", () => {
  // -------------------------------------------------------------------------
  // Threshold satisfied → escalate
  // -------------------------------------------------------------------------

  it("returns {clickMode:'trusted'} when synthetic failed and trusted succeeded (click)", () => {
    const facts: ObservedFact[] = [
      makeFact({
        action_class: "click",
        dispatch_mode: "synthetic",
        samples: ESCALATE_MIN_SYNTHETIC_SAMPLES,
        effect_count: 0, // 0% effect rate
      }),
      makeFact({
        action_class: "click",
        dispatch_mode: "trusted",
        samples: 2,
        effect_count: 2, // 100% effect rate
      }),
    ];
    const hints = computeObservedHints(facts, "click");
    expect(hints).toEqual({ clickMode: "trusted" });
  });

  it("returns {semanticKeyMode:'trusted'} for press action class", () => {
    const facts: ObservedFact[] = [
      makeFact({
        action_class: "press",
        dispatch_mode: "synthetic",
        samples: ESCALATE_MIN_SYNTHETIC_SAMPLES,
        effect_count: 0,
      }),
      makeFact({
        action_class: "press",
        dispatch_mode: "trusted",
        samples: 2,
        effect_count: 2,
      }),
    ];
    const hints = computeObservedHints(facts, "press");
    expect(hints).toEqual({ semanticKeyMode: "trusted" });
  });

  it("returns {typeMode:'trusted'} for type action class", () => {
    const facts: ObservedFact[] = [
      makeFact({
        action_class: "type",
        dispatch_mode: "synthetic",
        samples: ESCALATE_MIN_SYNTHETIC_SAMPLES,
        effect_count: 0,
      }),
      makeFact({
        action_class: "type",
        dispatch_mode: "trusted",
        samples: 4,
        effect_count: 3, // 75% — above threshold
      }),
    ];
    const hints = computeObservedHints(facts, "type");
    expect(hints).toEqual({ typeMode: "trusted" });
  });

  // -------------------------------------------------------------------------
  // Below threshold → null
  // -------------------------------------------------------------------------

  it("returns null when synthetic samples < minimum", () => {
    const facts: ObservedFact[] = [
      makeFact({
        action_class: "click",
        dispatch_mode: "synthetic",
        samples: ESCALATE_MIN_SYNTHETIC_SAMPLES - 1, // one short
        effect_count: 0,
      }),
      makeFact({
        action_class: "click",
        dispatch_mode: "trusted",
        samples: 2,
        effect_count: 2,
      }),
    ];
    expect(computeObservedHints(facts, "click")).toBeNull();
  });

  it("returns null when synthetic effect rate >= threshold (synthetic is working)", () => {
    const facts: ObservedFact[] = [
      makeFact({
        action_class: "click",
        dispatch_mode: "synthetic",
        samples: ESCALATE_MIN_SYNTHETIC_SAMPLES,
        // effect_count = samples * 0.5 — above the 0.2 max
        effect_count: Math.ceil(ESCALATE_MIN_SYNTHETIC_SAMPLES * 0.5),
      }),
      makeFact({
        action_class: "click",
        dispatch_mode: "trusted",
        samples: 2,
        effect_count: 2,
      }),
    ];
    expect(computeObservedHints(facts, "click")).toBeNull();
  });

  it("returns null when trusted effect rate < minimum (trusted not reliable)", () => {
    const facts: ObservedFact[] = [
      makeFact({
        action_class: "click",
        dispatch_mode: "synthetic",
        samples: ESCALATE_MIN_SYNTHETIC_SAMPLES,
        effect_count: 0,
      }),
      makeFact({
        action_class: "click",
        dispatch_mode: "trusted",
        samples: 4,
        effect_count: 1, // 25% — below ESCALATE_MIN_TRUSTED_EFFECT_RATE (0.5)
      }),
    ];
    expect(computeObservedHints(facts, "click")).toBeNull();
  });

  it("returns null when there is no trusted observation at all", () => {
    const facts: ObservedFact[] = [
      makeFact({
        action_class: "click",
        dispatch_mode: "synthetic",
        samples: ESCALATE_MIN_SYNTHETIC_SAMPLES,
        effect_count: 0,
      }),
    ];
    expect(computeObservedHints(facts, "click")).toBeNull();
  });

  it("returns null when facts array is empty", () => {
    expect(computeObservedHints([], "click")).toBeNull();
  });

  it("filters facts by action_class — ignores facts from other action classes", () => {
    // Only 'type' facts exist; querying 'click' should return null.
    const facts: ObservedFact[] = [
      makeFact({
        action_class: "type",
        dispatch_mode: "synthetic",
        samples: ESCALATE_MIN_SYNTHETIC_SAMPLES,
        effect_count: 0,
      }),
      makeFact({
        action_class: "type",
        dispatch_mode: "trusted",
        samples: 2,
        effect_count: 2,
      }),
    ];
    expect(computeObservedHints(facts, "click")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// observed_hints injection in dispatch pipeline
// ---------------------------------------------------------------------------

describe("McpBridgeServer — observed_hints injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeObservedFactsWithData(facts: ObservedFact[]): ObservedFactsStore {
    return {
      getFacts: vi.fn((hostname: string) => facts.filter((f) => f.hostname === hostname)),
      recordObservation: vi.fn(),
      snapshot: vi.fn().mockReturnValue(facts),
      save: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  function makeTabCacheWithEntry(tabId: string, hostname: string): TabHostnameCache {
    const cache = new TabHostnameCache();
    cache.set(tabId, hostname);
    return cache;
  }

  function makeEscalationFacts(hostname: string, actionClass: ObservedFact["action_class"]): ObservedFact[] {
    return [
      makeFact({
        hostname,
        action_class: actionClass,
        dispatch_mode: "synthetic",
        samples: ESCALATE_MIN_SYNTHETIC_SAMPLES,
        effect_count: 0, // synthetic never works
      }),
      makeFact({
        hostname,
        action_class: actionClass,
        dispatch_mode: "trusted",
        samples: 2,
        effect_count: 2, // trusted always works
      }),
    ];
  }

  it("injects observed_hints into forwarded params for browser_click when hostname is cached and threshold is met", async () => {
    const hostname = "slack.com";
    const facts = makeEscalationFacts(hostname, "click");
    const store = makeObservedFactsWithData(facts);
    const cache = makeTabCacheWithEntry("t_1", hostname);

    const bridge = makeConnectedBridge({ clicked: true, mode_used: "synthetic", site: hostname, page_effect: makePageEffect() });
    const deps = makeDeps({
      wsBridge: bridge,
      observedFacts: store,
      tabHostnameCache: cache,
    });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 42 }, "req-inject-1");

    // The bridge's callExtension was called with observed_hints injected.
    expect(bridge.callExtension).toHaveBeenCalledWith(
      "browser_click",
      expect.objectContaining({ observed_hints: { clickMode: "trusted" } }),
      expect.any(Number),
      undefined,
    );
  });

  it("does NOT inject observed_hints when tab has no cached hostname", async () => {
    const hostname = "slack.com";
    const facts = makeEscalationFacts(hostname, "click");
    const store = makeObservedFactsWithData(facts);
    const cache = new TabHostnameCache(); // empty — no entry for t_unknown

    const bridge = makeConnectedBridge({ clicked: true, mode_used: "synthetic", site: hostname, page_effect: makePageEffect() });
    const deps = makeDeps({
      wsBridge: bridge,
      observedFacts: store,
      tabHostnameCache: cache,
    });

    await callTool(deps, "browser_click", { tab_id: "t_unknown", ref: 42 }, "req-no-inject");

    // callExtension was called WITHOUT observed_hints.
    const callArgs = (bridge.callExtension as ReturnType<typeof vi.fn>).mock.calls[0];
    const forwardedParams = callArgs?.[1] as Record<string, unknown>;
    expect(forwardedParams?.["observed_hints"]).toBeUndefined();
  });

  it("does NOT inject observed_hints when threshold is not met (few synthetic samples)", async () => {
    const hostname = "example.com";
    const facts: ObservedFact[] = [
      makeFact({
        hostname,
        action_class: "click",
        dispatch_mode: "synthetic",
        samples: 1, // below ESCALATE_MIN_SYNTHETIC_SAMPLES
        effect_count: 0,
      }),
      makeFact({
        hostname,
        action_class: "click",
        dispatch_mode: "trusted",
        samples: 1,
        effect_count: 1,
      }),
    ];
    const store = makeObservedFactsWithData(facts);
    const cache = makeTabCacheWithEntry("t_1", hostname);

    const bridge = makeConnectedBridge({ clicked: true, mode_used: "synthetic", site: hostname, page_effect: makePageEffect() });
    const deps = makeDeps({
      wsBridge: bridge,
      observedFacts: store,
      tabHostnameCache: cache,
    });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 42 }, "req-below-threshold");

    const callArgs = (bridge.callExtension as ReturnType<typeof vi.fn>).mock.calls[0];
    const forwardedParams = callArgs?.[1] as Record<string, unknown>;
    expect(forwardedParams?.["observed_hints"]).toBeUndefined();
  });

  it("populates hostname cache from browser_navigate final_url", async () => {
    const cache = new TabHostnameCache();
    const bridge = makeConnectedBridge({ final_url: "https://notion.so/page", tab_id: "t_2" });
    const deps = makeDeps({ wsBridge: bridge, tabHostnameCache: cache });

    await callTool(deps, "browser_navigate", { tab_id: "t_2", url: "https://notion.so" }, "req-nav");

    expect(cache.get("t_2")).toBe("notion.so");
  });

  it("does NOT inject observed_hints for browser_navigate (not an input tool)", async () => {
    const hostname = "notion.so";
    const facts = makeEscalationFacts(hostname, "click");
    const store = makeObservedFactsWithData(facts);
    const cache = makeTabCacheWithEntry("t_2", hostname);

    const bridge = makeConnectedBridge({ final_url: "https://notion.so", tab_id: "t_2" });
    const deps = makeDeps({ wsBridge: bridge, observedFacts: store, tabHostnameCache: cache });

    await callTool(deps, "browser_navigate", { tab_id: "t_2", url: "https://notion.so" }, "req-nav-nohints");

    const callArgs = (bridge.callExtension as ReturnType<typeof vi.fn>).mock.calls[0];
    const forwardedParams = callArgs?.[1] as Record<string, unknown>;
    expect(forwardedParams?.["observed_hints"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// In-call auto-retry on zero-effect browser_click
// ---------------------------------------------------------------------------

describe("McpBridgeServer — browser_click auto-retry on zero-effect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * A WSBridge that returns different results on 1st vs subsequent calls.
   * Models the realistic case where synthetic fails silently but trusted
   * succeeds with a measurable effect.
   */
  function makeSequencedBridge(first: unknown, second: unknown): WSBridgeLike & { calls: Array<{ params: Record<string, unknown> }> } {
    const calls: Array<{ params: Record<string, unknown> }> = [];
    const fn = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      calls.push({ params });
      return calls.length === 1 ? first : second;
    });
    return {
      isConnected: () => true,
      callExtension: fn as unknown as WSBridgeLike["callExtension"],
      calls,
    };
  }

  it("retries browser_click with mode:trusted when synthetic returns zero page_effect", async () => {
    const store = makeObservedFacts();
    const first = {
      clicked: true,
      mode: "synthetic",
      mode_used: "synthetic",
      site: "web.whatsapp.com",
      page_effect: makePageEffect(),
    };
    const second = {
      clicked: true,
      mode: "trusted",
      mode_used: "trusted",
      site: "web.whatsapp.com",
      page_effect: makePageEffect({ domAdded: 12 }),
    };
    const bridge = makeSequencedBridge(first, second);
    const deps = makeDeps({ wsBridge: bridge, observedFacts: store });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 5 });

    // Two dispatches to the extension.
    expect(bridge.calls.length).toBe(2);
    // First used whatever the schema default was (synthetic); second was forced trusted.
    expect(bridge.calls[1]?.params["mode"]).toBe("trusted");
    // Both observations recorded: first synthetic/no-effect, second trusted/has-effect.
    expect(store.recordObservation).toHaveBeenCalledTimes(2);
    expect(store.recordObservation).toHaveBeenCalledWith({
      hostname: "web.whatsapp.com",
      action_class: "click",
      dispatch_mode: "synthetic",
      had_effect: false,
    });
    expect(store.recordObservation).toHaveBeenCalledWith({
      hostname: "web.whatsapp.com",
      action_class: "click",
      dispatch_mode: "trusted",
      had_effect: true,
    });
  });

  it("includes auto_retry telemetry in the returned result when retry fires", async () => {
    const first = { clicked: true, mode: "synthetic", mode_used: "synthetic", site: "web.whatsapp.com", page_effect: makePageEffect() };
    const second = { clicked: true, mode: "trusted", mode_used: "trusted", site: "web.whatsapp.com", page_effect: makePageEffect({ domAdded: 1 }) };
    const bridge = makeSequencedBridge(first, second);
    const deps = makeDeps({ wsBridge: bridge });

    const res = (await callTool(deps, "browser_click", { tab_id: "t_1", ref: 5 })) as {
      structuredContent?: { auto_retry?: { attempted: boolean; first_mode: string; final_mode: string; first_effect_empty: boolean } };
      content: Array<{ type: "text"; text: string }>;
    };

    // Result payload is in content[0].text as JSON.
    const body = JSON.parse(res.content[0]?.text ?? "{}") as {
      auto_retry?: { attempted: boolean; first_mode: string; final_mode: string; first_effect_empty: boolean };
    };
    expect(body.auto_retry).toBeDefined();
    expect(body.auto_retry?.attempted).toBe(true);
    expect(body.auto_retry?.first_mode).toBe("synthetic");
    expect(body.auto_retry?.final_mode).toBe("trusted");
    expect(body.auto_retry?.first_effect_empty).toBe(true);
  });

  it("does NOT retry when agent explicitly pinned mode:synthetic", async () => {
    const first = { clicked: true, mode: "synthetic", mode_used: "synthetic", site: "web.whatsapp.com", page_effect: makePageEffect() };
    const second = { clicked: true, mode: "trusted", mode_used: "trusted", site: "web.whatsapp.com", page_effect: makePageEffect({ domAdded: 1 }) };
    const bridge = makeSequencedBridge(first, second);
    const deps = makeDeps({ wsBridge: bridge });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 5, mode: "synthetic" });

    expect(bridge.calls.length).toBe(1);
  });

  it("does NOT retry when first attempt used mode:trusted (nothing stronger to escalate to)", async () => {
    const first = { clicked: true, mode: "trusted", mode_used: "trusted", site: "web.whatsapp.com", page_effect: makePageEffect() };
    const second = { clicked: true, mode: "trusted", mode_used: "trusted", site: "web.whatsapp.com", page_effect: makePageEffect({ domAdded: 1 }) };
    const bridge = makeSequencedBridge(first, second);
    const deps = makeDeps({ wsBridge: bridge });

    // First attempt already trusted (via SITE_REGISTRY or explicit). Retry would be pointless.
    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 5, mode: "trusted" });

    expect(bridge.calls.length).toBe(1);
  });

  it("does NOT retry when expect_effect is 'none'", async () => {
    const first = { clicked: true, mode: "synthetic", mode_used: "synthetic", site: "example.com", page_effect: makePageEffect() };
    const second = { clicked: true, mode: "trusted", mode_used: "trusted", site: "example.com", page_effect: makePageEffect({ domAdded: 1 }) };
    const bridge = makeSequencedBridge(first, second);
    const deps = makeDeps({ wsBridge: bridge });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 5, expect_effect: "none" });

    expect(bridge.calls.length).toBe(1);
  });

  it("does NOT retry when observe_effects is false (no effect data to decide from)", async () => {
    // No page_effect field when observe_effects:false.
    const first = { clicked: true, mode: "synthetic", mode_used: "synthetic", site: "example.com" };
    const second = { clicked: true, mode: "trusted", mode_used: "trusted", site: "example.com", page_effect: makePageEffect({ domAdded: 1 }) };
    const bridge = makeSequencedBridge(first, second);
    const deps = makeDeps({ wsBridge: bridge });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 5, observe_effects: false });

    expect(bridge.calls.length).toBe(1);
  });

  it("does NOT retry when first attempt returned clicked:false (addressing bug, not dispatch bug)", async () => {
    const first = {
      clicked: false,
      occluded: true,
      suggestion: "dismiss_overlay",
      page_effect: makePageEffect(),
    };
    const second = { clicked: true, mode: "trusted", mode_used: "trusted", site: "example.com", page_effect: makePageEffect({ domAdded: 1 }) };
    const bridge = makeSequencedBridge(first, second);
    const deps = makeDeps({ wsBridge: bridge });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 5 });

    expect(bridge.calls.length).toBe(1);
  });

  it("does NOT retry when first attempt had a measurable effect", async () => {
    const first = {
      clicked: true,
      mode: "synthetic",
      mode_used: "synthetic",
      site: "example.com",
      page_effect: makePageEffect({ domAdded: 3 }),
    };
    const second = { clicked: true, mode: "trusted", mode_used: "trusted", site: "example.com", page_effect: makePageEffect({ domAdded: 1 }) };
    const bridge = makeSequencedBridge(first, second);
    const deps = makeDeps({ wsBridge: bridge });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 5 });

    expect(bridge.calls.length).toBe(1);
  });

  it("does NOT retry for non-click tools (browser_type, browser_press)", async () => {
    // browser_type with synthetic + zero effect is intentionally NOT
    // auto-retried — trusted-type has known WRITE_AMPLIFIED risk on
    // Quill/ProseMirror/Slate.
    const typeFirst = {
      typed: 0,
      mode: "keystroke",
      mode_used: "keystroke",
      site: "example.com",
      page_effect: makePageEffect(),
    };
    const typeBridge = makeSequencedBridge(typeFirst, typeFirst);
    const typeDeps = makeDeps({ wsBridge: typeBridge });
    await callTool(typeDeps, "browser_type", { tab_id: "t_1", ref: 5, text: "hello" });
    expect(typeBridge.calls.length).toBe(1);

    const pressFirst = { pressed: true, dispatch: "synthetic", page_effect: makePageEffect() };
    const pressBridge = makeSequencedBridge(pressFirst, pressFirst);
    const pressDeps = makeDeps({ wsBridge: pressBridge });
    await callTool(pressDeps, "browser_press", { tab_id: "t_1", keys: ["Enter"] });
    expect(pressBridge.calls.length).toBe(1);
  });

  it("falls back to the original synthetic result when the retry itself errors", async () => {
    const first = { clicked: true, mode: "synthetic", mode_used: "synthetic", site: "example.com", page_effect: makePageEffect() };
    const callFn = vi.fn(async (_method: string, _params: Record<string, unknown>) => {
      if (callFn.mock.calls.length === 1) return first;
      throw new Error("retry network error");
    });
    const bridge: WSBridgeLike = {
      isConnected: () => true,
      callExtension: callFn as unknown as WSBridgeLike["callExtension"],
    };
    const deps = makeDeps({ wsBridge: bridge });

    const res = (await callTool(deps, "browser_click", { tab_id: "t_1", ref: 5 })) as {
      content: Array<{ type: "text"; text: string }>;
      isError: boolean;
    };

    expect(res.isError).toBe(false);
    const body = JSON.parse(res.content[0]?.text ?? "{}") as { clicked?: boolean; auto_retry?: unknown };
    expect(body.clicked).toBe(true);
    // Fall-back must not claim the retry worked.
    expect(body.auto_retry).toBeUndefined();
  });

  it("does NOT double-charge the rate limiter on retry", async () => {
    const first = { clicked: true, mode: "synthetic", mode_used: "synthetic", site: "example.com", page_effect: makePageEffect() };
    const second = { clicked: true, mode: "trusted", mode_used: "trusted", site: "example.com", page_effect: makePageEffect({ domAdded: 1 }) };
    const bridge = makeSequencedBridge(first, second);
    const limiter = new RateLimiter(100, 100);
    const spy = vi.spyOn(limiter, "tryConsume");
    const deps = makeDeps({ wsBridge: bridge, rateLimiter: limiter });

    await callTool(deps, "browser_click", { tab_id: "t_1", ref: 5 });

    // Retry still reaches the extension a second time...
    expect(bridge.calls.length).toBe(2);
    // ...but the rate limiter was charged only once for the logical action.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
