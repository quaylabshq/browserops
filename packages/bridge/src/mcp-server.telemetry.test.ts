/**
 * End-to-end check that dispatch goes through captureToolCalled →
 * captureEvent → redact → posthog-http on the failure path. The redact
 * unit tests cover the allowlist; this confirms the wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  McpBridgeServer,
  type McpBridgeDeps,
  type WSBridgeLike,
} from "./mcp-server.js";
import { RateLimiter } from "./rate-limiter.js";
import { TabRegistry } from "./tab-registry.js";
import type { Safety } from "./safety.js";
import type { Logger } from "./logger.js";
import { initTelemetry, resetTelemetryForTest } from "./telemetry/index.js";

interface FetchCall {
  url: string;
  body: string;
}

function makeFetchSpy(): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("", { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeDeps(overrides: Partial<McpBridgeDeps> = {}): McpBridgeDeps {
  const logger = {
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  } as unknown as Logger;
  const wsBridge: WSBridgeLike = {
    isConnected: () => true,
    callExtension: vi.fn().mockResolvedValue({ ok: true }),
  };
  const safety = {
    checkRisky: vi.fn().mockReturnValue({ risky: false }),
    requireApproval: vi.fn().mockResolvedValue({ allow: true }),
  } as unknown as Safety;
  return {
    wsBridge,
    rateLimiter: new RateLimiter(100, 1000),
    safety,
    tabs: new TabRegistry(),
    logger,
    version: "0.0.0-test",
    sessionId: "",
    gatedMatcher: { patterns: [], matches: () => false },
    enabledFeatures: new Set(["procedures"]),
    clientName: "Cursor",
    ...overrides,
  };
}

interface Dispatchable {
  dispatch(
    req: { params: { name: string; arguments?: Record<string, unknown> } },
    extra: { signal?: AbortSignal; requestId?: string | number },
  ): Promise<unknown>;
}

describe("McpBridgeServer telemetry wiring", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env["BROWSEROPS_TELEMETRY"];
    process.env["BROWSEROPS_TELEMETRY"] = "1";
    resetTelemetryForTest();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env["BROWSEROPS_TELEMETRY"];
    else process.env["BROWSEROPS_TELEMETRY"] = savedEnv;
    resetTelemetryForTest();
  });

  it("emits mcp.<tool> with allowlisted fields on INVALID_PARAMS", async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    const { client } = await initTelemetry({
      bridgeVersion: "0.0.0-test",
      apiKey: "phc_test",
      host: "https://t.example",
      fetchImpl,
    });
    expect(client.enabled).toBe(true);

    const deps = makeDeps();
    const srv = new McpBridgeServer(deps) as unknown as Dispatchable;
    await srv.dispatch(
      { params: { name: "browser_navigate", arguments: { tab_id: "t_1" } } },
      { requestId: "req-1" },
    );

    await client.shutdown(1000);
    expect(calls.length).toBeGreaterThan(0);
    const body = JSON.parse(calls[calls.length - 1]!.body) as {
      batch: Array<{ event: string; properties: Record<string, unknown> }>;
    };
    const event = body.batch.find((e) => e.event === "mcp.browser_navigate");
    expect(event).toBeDefined();
    const props = event!.properties;
    expect(props["tool_name"]).toBe("browser_navigate");
    expect(props["ok"]).toBe(false);
    expect(props["error_code"]).toBe("INVALID_PARAMS");
    expect(props["client_name"]).toBe("Cursor");
    expect(props["param_keys"]).toEqual(["tab_id"]);
    expect(props["bridge_version"]).toBe("0.0.0-test");
    expect(props["os_platform"]).toBe(process.platform);

    const serialised = JSON.stringify(props);
    expect(serialised).not.toContain("https://");
  });

  it("emits mcp.browser_navigate with tab_hostname + is_external_url on success", async () => {
    const { fetchImpl, calls } = makeFetchSpy();
    const { client } = await initTelemetry({
      bridgeVersion: "0.0.0-test",
      apiKey: "phc_test",
      host: "https://t.example",
      fetchImpl,
    });

    const tabs = new TabRegistry();
    const minted = tabs.mint(123, {
      url: "https://docs.google.com/document/d/secret123/edit?token=abc",
      active: true,
      window_id: 1,
    });

    const wsBridge: WSBridgeLike = {
      isConnected: () => true,
      callExtension: vi.fn().mockResolvedValue({ url: "https://docs.google.com/document/d/secret123/edit" }),
    };

    const deps = makeDeps({ tabs, wsBridge });
    const srv = new McpBridgeServer(deps) as unknown as Dispatchable;
    await srv.dispatch(
      {
        params: {
          name: "browser_navigate",
          arguments: { tab_id: minted.tab_id, url: "https://example.com/" }, // different hostname → external
        },
      },
      { requestId: "req-2" },
    );

    await client.shutdown(1000);
    const body = JSON.parse(calls[calls.length - 1]!.body) as {
      batch: Array<{ event: string; properties: Record<string, unknown> }>;
    };
    const event = body.batch.find((e) => e.event === "mcp.browser_navigate");
    expect(event).toBeDefined();
    const props = event!.properties;
    expect(props["tool_name"]).toBe("browser_navigate");
    expect(props["ok"]).toBe(true);
    expect(props["tab_hostname"]).toBe("docs.google.com");
    expect(props["is_external_url"]).toBe(true);
    expect(props["param_keys"]).toEqual(["tab_id", "url"]);

    const serialised = JSON.stringify(props);
    expect(serialised).not.toContain("secret123");
    expect(serialised).not.toContain("token=abc");
    expect(serialised).not.toContain("/document/");
  });
});
