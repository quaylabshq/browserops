import type { AgentId } from "@browserops/shared";
import type { Router } from "../router.js";

export const MCP_HEALTH_STORAGE_KEY = "mcpHealth";

interface McpHealthRecord {
  agent: AgentId;
  activeSessions: number;
  lastConnectedAt?: number;
}

function isAgentId(value: unknown): value is AgentId {
  return value === "claude" || value === "codex" || value === "cursor";
}

function readHealthRecord(value: unknown): McpHealthRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!isAgentId(candidate["agent"]) || typeof candidate["activeSessions"] !== "number") {
    return undefined;
  }
  return {
    agent: candidate["agent"],
    activeSessions: Math.max(0, Math.floor(candidate["activeSessions"])),
    ...(typeof candidate["lastConnectedAt"] === "number"
      ? { lastConnectedAt: candidate["lastConnectedAt"] }
      : {}),
  };
}

/**
 * Receives live provider-MCP state from the daemon. It is deliberately a
 * bridge request, not a UI guess: the only producer is the shim lifecycle
 * after a provider has connected to BrowserOps.
 */
export function registerMcpHealthHandlers(router: Router): void {
  router.register("mcp_connection_state", async (params) => {
    const raw = params["providers"];
    const providers = Array.isArray(raw)
      ? raw
          .map(readHealthRecord)
          .filter((record): record is McpHealthRecord => record !== undefined)
      : [];
    await chrome.storage.local.set({ [MCP_HEALTH_STORAGE_KEY]: providers });
    return { ok: true };
  });
}
