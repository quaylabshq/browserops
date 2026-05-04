import { exec } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ClientId, ClientInfo } from "./types.js";

const execAsync = promisify(exec);

async function dirExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function onPath(bin: string): Promise<boolean> {
  try {
    await execAsync(`which ${bin}`);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonLoose(p: string): Promise<Record<string, unknown> | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(p, "utf8");
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const home = homedir();

async function detectClaudeCode(): Promise<ClientInfo> {
  const id: ClientId = "claude-code";
  const label = "Claude Code";
  const configPath = join(home, ".claude", "mcp.json");
  const detected = await onPath("claude");

  let alreadyInstalled = false;
  if (detected) {
    try {
      const { stdout } = await execAsync("claude mcp list");
      alreadyInstalled = stdout.includes("browserops");
    } catch {
      const data = await readJsonLoose(configPath);
      if (data && typeof data["mcpServers"] === "object" && data["mcpServers"] !== null) {
        alreadyInstalled = "browserops" in (data["mcpServers"] as object);
      }
    }
  }

  return { id, label, detected, configPath, alreadyInstalled };
}

async function detectCursor(): Promise<ClientInfo> {
  const id: ClientId = "cursor";
  const label = "Cursor";
  const configPath = join(home, ".cursor", "mcp.json");
  const detected = (await dirExists(join(home, ".cursor"))) || (await onPath("cursor"));

  let alreadyInstalled = false;
  const data = await readJsonLoose(configPath);
  if (data && typeof data["mcpServers"] === "object" && data["mcpServers"] !== null) {
    alreadyInstalled = "browserops" in (data["mcpServers"] as object);
  }

  return { id, label, detected, configPath, alreadyInstalled };
}

async function detectZed(): Promise<ClientInfo> {
  const id: ClientId = "zed";
  const label = "Zed";
  const configPath = join(home, ".config", "zed", "settings.json");
  const detected =
    (await dirExists(join(home, ".config", "zed"))) ||
    (await dirExists("/Applications/Zed.app")) ||
    (await onPath("zed"));

  let alreadyInstalled = false;
  if (await fileExists(configPath)) {
    try {
      const { readFile } = await import("node:fs/promises");
      const { parse } = await import("jsonc-parser");
      const text = await readFile(configPath, "utf8");
      const data = parse(text) as Record<string, unknown>;
      if (typeof data["context_servers"] === "object" && data["context_servers"] !== null) {
        alreadyInstalled = "browserops" in (data["context_servers"] as object);
      }
    } catch {
      // unparseable — conservatively report not installed
    }
  }

  return { id, label, detected, configPath, alreadyInstalled };
}

async function detectContinue(): Promise<ClientInfo> {
  const id: ClientId = "continue";
  const label = "Continue";
  const continueDir = join(home, ".continue");
  const jsonPath = join(continueDir, "config.json");
  const detected = await dirExists(continueDir);

  const configPath = jsonPath;

  let alreadyInstalled = false;
  if (await fileExists(jsonPath)) {
    const data = await readJsonLoose(jsonPath);
    if (data) {
      const exp = data["experimental"] as Record<string, unknown> | undefined;
      const servers = exp?.["modelContextProtocolServers"];
      if (Array.isArray(servers)) {
        alreadyInstalled = (servers as unknown[]).some((s) => {
          if (typeof s !== "object" || s === null) return false;
          const transport = (s as Record<string, unknown>)["transport"] as Record<string, unknown> | undefined;
          const cmd = transport?.["command"];
          if (typeof cmd === "string" && cmd.includes("browserops-shim")) return true;
          const args = transport?.["args"];
          if (Array.isArray(args)) {
            return args.some((a) => typeof a === "string" && a.includes("browserops"));
          }
          return false;
        });
      }
    }
  }

  return { id, label, detected, configPath, alreadyInstalled };
}

async function detectWindsurf(): Promise<ClientInfo> {
  const id: ClientId = "windsurf";
  const label = "Windsurf";
  const windsurfDir = join(home, ".codeium", "windsurf");
  const configPath = join(windsurfDir, "mcp_config.json");
  const detected = await dirExists(windsurfDir);

  let alreadyInstalled = false;
  const data = await readJsonLoose(configPath);
  if (data && typeof data["mcpServers"] === "object" && data["mcpServers"] !== null) {
    alreadyInstalled = "browserops" in (data["mcpServers"] as object);
  }

  return { id, label, detected, configPath, alreadyInstalled };
}

async function detectCodex(): Promise<ClientInfo> {
  const id: ClientId = "codex";
  const label = "Codex CLI";
  const configPath = join(home, ".codex", "config.toml");
  const detected = await onPath("codex");

  let alreadyInstalled = false;
  if (await fileExists(configPath)) {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(configPath, "utf8");
    alreadyInstalled = /^\[mcp_servers\.browserops\]/m.test(text);
  }

  return { id, label, detected, configPath, alreadyInstalled };
}

export async function detectClients(): Promise<ClientInfo[]> {
  const results = await Promise.all([
    detectClaudeCode(),
    detectCursor(),
    detectZed(),
    detectContinue(),
    detectWindsurf(),
    detectCodex(),
  ]);
  return results;
}
