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
  type McpBridgeDeps,
  type WSBridgeLike,
} from "./mcp-server.js";
import { RateLimiter } from "./rate-limiter.js";
import { TabRegistry } from "./tab-registry.js";
import type { Safety } from "./safety.js";
import type { Logger } from "./logger.js";
import type { TraceWriter } from "./trace-writer.js";
import type { TraceEvent } from "@browserops/shared";
import { TeachSessionStore } from "./teach/session-store.js";

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

function makeDeps(overrides: Partial<McpBridgeDeps> = {}): McpBridgeDeps {
  return {
    wsBridge: makeConnectedBridge(),
    rateLimiter: new RateLimiter(100, 1000),
    safety: makeSafety(),
    tabs: new TabRegistry(),
    logger: makeLogger(),
    version: "0.0.0-test",
    teachStore: new TeachSessionStore(),
    // Test default: every gated feature on, so existing tool-call tests
    // (which call browser_* + procedures_* tools) keep working without
    // needing to reason about the feature gate per case. Gate-specific
    // tests pass an explicit empty / scoped set in their overrides.
    enabledFeatures: new Set(["teach", "procedures"]),
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

describe("McpBridgeServer — feature gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function errorCodeOf(result: unknown): string | undefined {
    const r = result as { content?: Array<{ text?: string }>; isError?: boolean };
    if (r.isError !== true) return undefined;
    const text = r.content?.[0]?.text ?? "";
    try {
      const parsed = JSON.parse(text) as { code?: string };
      return parsed.code;
    } catch {
      return undefined;
    }
  }

  it("returns FEATURE_DISABLED when calling a procedures_* tool with procedures off", async () => {
    const deps = makeDeps({ enabledFeatures: new Set([]) });
    const result = await callTool(deps, "procedures_list", {});
    expect(errorCodeOf(result)).toBe("FEATURE_DISABLED");
  });

  it("returns FEATURE_DISABLED when calling a procedures_teach_* tool with teach off", async () => {
    const deps = makeDeps({ enabledFeatures: new Set(["procedures"]) });
    const result = await callTool(deps, "procedures_teach_list", {});
    expect(errorCodeOf(result)).toBe("FEATURE_DISABLED");
  });

  it("permits a procedures_* tool when procedures is enabled", async () => {
    const deps = makeDeps({ enabledFeatures: new Set(["procedures"]) });
    const result = await callTool(deps, "procedures_list", {});
    // Real handler runs; whatever it returns isn't FEATURE_DISABLED.
    expect(errorCodeOf(result)).not.toBe("FEATURE_DISABLED");
  });
});

