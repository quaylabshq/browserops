import { describe, expect, it } from "vitest";
import { agentFromClientName, McpConnectionMonitor } from "./mcp-connection-monitor.js";

describe("McpConnectionMonitor", () => {
  it("attributes live shim connections to known providers and retains the last handshake", () => {
    let now = 100;
    const monitor = new McpConnectionMonitor(() => now);

    expect(monitor.markConnected("s-1", "codex-mcp-client")).toBe("codex");
    expect(monitor.activeSessions("codex")).toBe(1);
    expect(monitor.lastSeen("codex")).toBe(100);

    now = 200;
    expect(monitor.markDisconnected("s-1")).toBe("codex");
    expect(monitor.activeSessions("codex")).toBe(0);
    expect(monitor.lastSeen("codex")).toBe(100);
  });

  it("does not call unrecognised MCP clients provider connections", () => {
    const monitor = new McpConnectionMonitor();
    expect(monitor.markConnected("s-1", "Some Other Client")).toBeUndefined();
    expect(monitor.snapshot()).toEqual([
      { agent: "claude", activeSessions: 0 },
      { agent: "codex", activeSessions: 0 },
      { agent: "cursor", activeSessions: 0 },
    ]);
  });

  it("recognises the provider clientInfo variants seen in BrowserOps shims", () => {
    expect(agentFromClientName("Claude Code")).toBe("claude");
    expect(agentFromClientName("codex-mcp-client")).toBe("codex");
    expect(agentFromClientName("Cursor")).toBe("cursor");
  });
});
