import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { atomicWrite, backup } from "../lib/fs.js";
import type { ClientId, ClientInfo, ClientInstaller, InstallResult, InstallSpec } from "./types.js";

const execAsync = promisify(exec);
const home = homedir();
const CONFIG_PATH = join(home, ".claude", "mcp.json");
const ID: ClientId = "claude-code";
const LABEL = "Claude Code";

interface McpJson {
  mcpServers?: Record<string, unknown>;
}

async function readConfig(): Promise<McpJson> {
  try {
    const text = await readFile(CONFIG_PATH, "utf8");
    return JSON.parse(text) as McpJson;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot parse ${CONFIG_PATH}: ${(e as Error).message}`);
  }
}

async function isAlreadyInstalled(): Promise<boolean> {
  try {
    const { stdout } = await execAsync("claude mcp list");
    return stdout.includes("browserops");
  } catch {
    const cfg = await readConfig();
    return Boolean(cfg.mcpServers && "browserops" in cfg.mcpServers);
  }
}

export const claudeCodeInstaller: ClientInstaller = {
  id: ID,
  label: LABEL,

  async detect(): Promise<ClientInfo> {
    let detected = false;
    try {
      await execAsync("which claude");
      detected = true;
    } catch {
      // not on PATH
    }

    const alreadyInstalled = detected ? await isAlreadyInstalled() : false;
    return { id: ID, label: LABEL, detected, configPath: CONFIG_PATH, alreadyInstalled };
  },

  async install(spec: InstallSpec, opts?: { dryRun?: boolean }): Promise<InstallResult> {
    const dryRun = opts?.dryRun ?? false;
    const argsStr = spec.args && spec.args.length > 0 ? ` ${spec.args.join(" ")}` : "";

    if (dryRun) {
      return {
        changed: true,
        configPath: CONFIG_PATH,
        message: `would register browserops via \`claude mcp add\` or write ${CONFIG_PATH}`,
      };
    }

    try {
      const addArgs = spec.args && spec.args.length > 0 ? ` -- ${spec.command}${argsStr}` : ` -- ${spec.command}`;
      await execAsync(`claude mcp add browserops --scope user${addArgs}`);
      return { changed: true, configPath: CONFIG_PATH, message: "registered via `claude mcp add`" };
    } catch {
      // fallback: direct JSON merge
      const existing = await readConfig();
      const before = JSON.stringify(existing);

      existing.mcpServers = existing.mcpServers ?? {};
      const entry: Record<string, unknown> = { command: spec.command };
      if (spec.args && spec.args.length > 0) entry["args"] = spec.args;
      if (spec.env && Object.keys(spec.env).length > 0) entry["env"] = spec.env;
      existing.mcpServers["browserops"] = entry;

      const after = JSON.stringify(existing, null, 2);
      if (before === after) {
        return { changed: false, configPath: CONFIG_PATH, message: "no change" };
      }

      await mkdir(dirname(CONFIG_PATH), { recursive: true });
      const backupPath = await backup(CONFIG_PATH);
      await atomicWrite(CONFIG_PATH, after + "\n");
      return { changed: true, configPath: CONFIG_PATH, backupPath, message: `merged ${CONFIG_PATH}` };
    }
  },

  async uninstall(opts?: { dryRun?: boolean }): Promise<InstallResult> {
    const dryRun = opts?.dryRun ?? false;

    if (dryRun) {
      return {
        changed: true,
        configPath: CONFIG_PATH,
        message: `would remove browserops via \`claude mcp remove\` or edit ${CONFIG_PATH}`,
      };
    }

    try {
      await execAsync("claude mcp remove browserops --scope user");
      return { changed: true, configPath: CONFIG_PATH, message: "removed via `claude mcp remove`" };
    } catch {
      const existing = await readConfig();
      if (!existing.mcpServers || !("browserops" in existing.mcpServers)) {
        return { changed: false, configPath: CONFIG_PATH, message: "no change (not found)" };
      }
      delete existing.mcpServers["browserops"];
      const backupPath = await backup(CONFIG_PATH);
      await atomicWrite(CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n");
      return { changed: true, configPath: CONFIG_PATH, backupPath, message: `removed from ${CONFIG_PATH}` };
    }
  },
};
