/**
 * Phase 4.5 — Memory tool dispatch and default-on gating tests.
 *
 * Covers:
 * 1. tools/list exposes all 6 memory tools when memory feature is on.
 * 2. memory_save is NOT FEATURE_DISABLED when memory is default-on.
 * 3. memory_save IS FEATURE_DISABLED when memory is explicitly disabled.
 * 4. resolveFeatures honours memory.default = true.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  McpBridgeServer,
  type McpBridgeDeps,
  type WSBridgeLike,
} from "../mcp-server.js";
import { RateLimiter } from "../rate-limiter.js";
import { TabRegistry } from "../tab-registry.js";
import type { Safety } from "../safety.js";
import type { Logger } from "../logger.js";
import { TOOL_DEFS } from "@browserops/shared";
import { resolveFeatures, FEATURE_METADATA } from "@browserops/shared";

// ---------------------------------------------------------------------------
// Minimal mock factory helpers (mirrors mcp-server.test.ts style)
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return { write: vi.fn().mockResolvedValue(undefined), close: vi.fn() } as unknown as Logger;
}

function makeConnectedBridge(): WSBridgeLike {
  return {
    isConnected: () => true,
    callExtension: vi.fn().mockResolvedValue({}),
  };
}

function makeSafety(): Safety {
  return {
    checkRisky: vi.fn().mockReturnValue({ risky: false }),
    requireApproval: vi.fn().mockResolvedValue({ allow: true }),
  } as unknown as Safety;
}

function makeDeps(overrides: Partial<McpBridgeDeps> = {}): McpBridgeDeps {
  return {
    wsBridge: makeConnectedBridge(),
    rateLimiter: new RateLimiter(100, 1000),
    safety: makeSafety(),
    tabs: new TabRegistry(),
    logger: makeLogger(),
    version: "0.0.0-test",
    sessionId: "",
    enabledFeatures: new Set(["memory"]),
    ...overrides,
  };
}

async function callTool(
  deps: McpBridgeDeps,
  name: string,
  args: Record<string, unknown> = {},
  requestId = "req-test-1",
) {
  const srv = new McpBridgeServer(deps);
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

function errorCodeOf(result: unknown): string | undefined {
  const r = result as { content?: Array<{ text?: string }>; isError?: boolean };
  if (r.isError !== true) return undefined;
  const text = r.content?.[0]?.text ?? "";
  try {
    return (JSON.parse(text) as { code?: string }).code;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory feature default-on (resolveFeatures)", () => {
  it("memory.default is true in FEATURE_METADATA", () => {
    expect(FEATURE_METADATA["memory"].default).toBe(true);
  });

  it("resolveFeatures enables memory with no explicit override", () => {
    const features = resolveFeatures(undefined);
    expect(features.has("memory")).toBe(true);
  });

  it("resolveFeatures disables memory when explicitly set to false", () => {
    const features = resolveFeatures({ memory: false });
    expect(features.has("memory")).toBe(false);
  });

  it("resolveFeatures can explicitly enable memory", () => {
    const features = resolveFeatures({ memory: true });
    expect(features.has("memory")).toBe(true);
  });
});

describe("TOOL_DEFS — 6 memory tools present", () => {
  const memoryTools = TOOL_DEFS.filter((t) => t.feature === "memory").map((t) => t.name);

  it("exposes all 6 memory tool names", () => {
    expect(memoryTools).toContain("memory_save");
    expect(memoryTools).toContain("memory_search");
    expect(memoryTools).toContain("memory_get");
    expect(memoryTools).toContain("memory_delete");
    expect(memoryTools).toContain("memory_session_trace");
    expect(memoryTools).toContain("memory_list_for_origin");
    expect(memoryTools).toHaveLength(6);
  });
});

describe("McpBridgeServer — memory tool dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Default-on: memory feature enabled → calls reach handlers (not gated)
  // -------------------------------------------------------------------------

  it("memory_save is NOT FEATURE_DISABLED when memory feature is on", async () => {
    const deps = makeDeps({ enabledFeatures: new Set(["memory"]) });
    // Pass a valid v2 record — result should not be FEATURE_DISABLED
    // (it may error due to schema/PII, but not because the feature is off).
    const result = await callTool(deps, "memory_save", {
      record: {
        schema_version: 1,
        name: "test.lesson",
        scope: "global",
        kind: "lesson",
        title: "A test lesson",
        detail: { note: "This is a test note." },
      },
    });
    expect(errorCodeOf(result)).not.toBe("FEATURE_DISABLED");
  });

  it("memory_search is NOT FEATURE_DISABLED when memory feature is on", async () => {
    const deps = makeDeps({ enabledFeatures: new Set(["memory"]) });
    const result = await callTool(deps, "memory_search", { query: "test" });
    expect(errorCodeOf(result)).not.toBe("FEATURE_DISABLED");
  });

  it("memory_session_trace returns stub entries when memory is on", async () => {
    const deps = makeDeps({ enabledFeatures: new Set(["memory"]) });
    const result = await callTool(deps, "memory_session_trace", { session_id: "s_test" });
    // Stub returns {entries:[]} — should succeed without FEATURE_DISABLED
    expect(errorCodeOf(result)).not.toBe("FEATURE_DISABLED");
  });

  it("memory_list_for_origin is callable when memory is on", async () => {
    const deps = makeDeps({ enabledFeatures: new Set(["memory"]) });
    const result = await callTool(deps, "memory_list_for_origin", {
      origin: "https://example.com",
    });
    expect(errorCodeOf(result)).not.toBe("FEATURE_DISABLED");
  });

  // -------------------------------------------------------------------------
  // Explicitly disabled: memory feature off → FEATURE_DISABLED
  // -------------------------------------------------------------------------

  it("memory_save returns FEATURE_DISABLED when memory is explicitly disabled", async () => {
    const deps = makeDeps({ enabledFeatures: new Set([]) });
    const result = await callTool(deps, "memory_save", {
      record: {
        schema_version: 1,
        name: "test.lesson",
        scope: "global",
        kind: "lesson",
        title: "A test lesson",
        detail: { note: "This is a test note." },
      },
    });
    expect(errorCodeOf(result)).toBe("FEATURE_DISABLED");
  });

  it("memory_search returns FEATURE_DISABLED when memory is explicitly disabled", async () => {
    const deps = makeDeps({ enabledFeatures: new Set([]) });
    const result = await callTool(deps, "memory_search", { query: "gmail" });
    expect(errorCodeOf(result)).toBe("FEATURE_DISABLED");
  });

  it("memory_session_trace returns FEATURE_DISABLED when memory is off", async () => {
    const deps = makeDeps({ enabledFeatures: new Set([]) });
    const result = await callTool(deps, "memory_session_trace", { session_id: "s_test" });
    expect(errorCodeOf(result)).toBe("FEATURE_DISABLED");
  });

  it("memory_list_for_origin returns FEATURE_DISABLED when memory is off", async () => {
    const deps = makeDeps({ enabledFeatures: new Set([]) });
    const result = await callTool(deps, "memory_list_for_origin", {
      origin: "https://example.com",
    });
    expect(errorCodeOf(result)).toBe("FEATURE_DISABLED");
  });

  // -------------------------------------------------------------------------
  // Default-on via resolveFeatures: calling with no explicit feature set
  // should result in memory being on (since default=true)
  // -------------------------------------------------------------------------

  it("resolveFeatures default enables memory: calling memory_search with default features works", async () => {
    // Simulate what the daemon does: no explicit config → use resolveFeatures(undefined)
    const defaultFeatures = resolveFeatures(undefined);
    const deps = makeDeps({ enabledFeatures: defaultFeatures });
    const result = await callTool(deps, "memory_search", { query: "test" });
    expect(errorCodeOf(result)).not.toBe("FEATURE_DISABLED");
  });
});
