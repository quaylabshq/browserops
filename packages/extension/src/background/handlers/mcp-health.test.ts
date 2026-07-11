import { afterEach, describe, expect, it, vi } from "vitest";
import { Router, type Context } from "../router.js";
import { MCP_HEALTH_STORAGE_KEY, registerMcpHealthHandlers } from "./mcp-health.js";

describe("MCP health bridge handler", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("persists only recognised provider handshake records sent by the daemon", async () => {
    const set = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", { storage: { local: { set } } });
    const router = new Router();
    registerMcpHealthHandlers(router);

    const response = await router.dispatch(
      {
        type: "request",
        id: "health-1",
        method: "mcp_connection_state",
        params: {
          providers: [
            { agent: "codex", activeSessions: 1, lastConnectedAt: 123 },
            { agent: "unknown", activeSessions: 9 },
            { agent: "cursor", activeSessions: -3 },
          ],
        },
        timeout_ms: 1_000,
      },
      { emitEvent: () => {}, refCache: {} as Context["refCache"] },
    );

    expect(response.ok).toBe(true);
    expect(set).toHaveBeenCalledWith({
      [MCP_HEALTH_STORAGE_KEY]: [
        { agent: "codex", activeSessions: 1, lastConnectedAt: 123 },
        { agent: "cursor", activeSessions: 0 },
      ],
    });
  });
});
