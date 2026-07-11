import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentId, ChatAgentStatus } from "@browserops/shared";
import { configureChatAgent, inspectChatAgent } from "./provider-setup.js";

const shim = { command: "/usr/local/bin/node", args: ["/opt/browserops/shim.js"] };

function status(agent: AgentId, available = true): ChatAgentStatus {
  return { agent, available, ...(available ? {} : { reason: "agent_not_found" }) };
}

describe("provider setup preflight", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(join(tmpdir(), "browserops-provider-setup-"));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("separates a missing CLI from a missing BrowserOps MCP registration", async () => {
    const noCli = await inspectChatAgent(status("claude", false), { home });
    expect(noCli).toMatchObject({
      available: false,
      setupState: "cli_missing",
      canConfigure: false,
      configPath: join(home, ".claude.json"),
    });

    for (const agent of ["claude", "codex", "cursor"] as const) {
      const missingMcp = await inspectChatAgent(status(agent), { home });
      expect(missingMcp).toMatchObject({
        agent,
        available: false,
        setupState: "mcp_missing",
        canConfigure: true,
      });
    }
  });

  it("registers the packaged shim for JSON-backed providers without dropping existing settings", async () => {
    const path = join(home, ".claude.json");
    await fs.writeFile(path, JSON.stringify({ theme: "dark" }) + "\n");

    const configured = await configureChatAgent(status("claude"), { home, shim });
    expect(configured).toMatchObject({
      available: true,
      setupState: "ready",
      canConfigure: false,
    });
    await expect(fs.readFile(path, "utf8")).resolves.toContain('"theme": "dark"');
    await expect(fs.readFile(path, "utf8")).resolves.toContain('"browserops"');
    await expect(fs.readFile(path, "utf8")).resolves.toContain('"/opt/browserops/shim.js"');
  });

  it("writes Codex's mcp_servers.browserops TOML section and keeps surrounding config", async () => {
    const path = join(home, ".codex", "config.toml");
    await fs.mkdir(join(home, ".codex"), { recursive: true });
    await fs.writeFile(path, 'model = "gpt-test"\n');

    const configured = await configureChatAgent(status("codex"), { home, shim });
    expect(configured).toMatchObject({ available: true, setupState: "ready" });
    const raw = await fs.readFile(path, "utf8");
    expect(raw).toContain('model = "gpt-test"');
    expect(raw).toContain("[mcp_servers.browserops]");
    expect(raw).toContain('command = "/usr/local/bin/node"');
  });

  it("reports malformed existing config without overwriting it", async () => {
    const path = join(home, ".cursor", "mcp.json");
    await fs.mkdir(join(home, ".cursor"), { recursive: true });
    await fs.writeFile(path, "{ not json");

    const inspected = await inspectChatAgent(status("cursor"), { home });
    expect(inspected).toMatchObject({
      available: false,
      setupState: "config_invalid",
      canConfigure: false,
    });
    const result = await configureChatAgent(status("cursor"), { home, shim });
    expect(result).toMatchObject({ setupState: "config_invalid" });
    await expect(fs.readFile(path, "utf8")).resolves.toBe("{ not json");
  });
});
