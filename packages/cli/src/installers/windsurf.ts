import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWrite, backup } from "../lib/fs.js";
import type { ClientId, ClientInfo, ClientInstaller, InstallResult, InstallSpec } from "./types.js";

const home = homedir();
const WINDSURF_DIR = join(home, ".codeium", "windsurf");
const CONFIG_PATH = join(WINDSURF_DIR, "mcp_config.json");
const ID: ClientId = "windsurf";
const LABEL = "Windsurf";

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

export const windsurfInstaller: ClientInstaller = {
  id: ID,
  label: LABEL,

  async detect(): Promise<ClientInfo> {
    let detected = false;
    try {
      await access(WINDSURF_DIR, constants.F_OK);
      detected = true;
    } catch {
      // not found
    }

    let alreadyInstalled = false;
    const cfg = await readConfig();
    if (cfg.mcpServers && "browserops" in cfg.mcpServers) {
      alreadyInstalled = true;
    }

    return { id: ID, label: LABEL, detected, configPath: CONFIG_PATH, alreadyInstalled };
  },

  async install(spec: InstallSpec, opts?: { dryRun?: boolean }): Promise<InstallResult> {
    const dryRun = opts?.dryRun ?? false;
    const existing = await readConfig();
    const before = JSON.stringify(existing);

    existing.mcpServers = existing.mcpServers ?? {};
    const entry: Record<string, unknown> = { command: spec.command };
    if (spec.args && spec.args.length > 0) entry["args"] = spec.args;
    if (spec.env && Object.keys(spec.env).length > 0) entry["env"] = spec.env;
    existing.mcpServers["browserops"] = entry;

    // Compare with the same serializer used for `before`. Pretty-printing
    // here made the equality check unreachable, so every re-run of
    // `browserops sync mcp` / init rewrote mcp_config.json and dropped a .bak.
    if (before === JSON.stringify(existing)) {
      return { changed: false, configPath: CONFIG_PATH, message: "no change" };
    }

    const after = JSON.stringify(existing, null, 2);

    if (dryRun) {
      return { changed: true, configPath: CONFIG_PATH, message: `would merge ${CONFIG_PATH}` };
    }

    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    const backupPath = await backup(CONFIG_PATH);
    await atomicWrite(CONFIG_PATH, after + "\n");
    return { changed: true, configPath: CONFIG_PATH, backupPath, message: `merged ${CONFIG_PATH}` };
  },

  async uninstall(opts?: { dryRun?: boolean }): Promise<InstallResult> {
    const dryRun = opts?.dryRun ?? false;
    const existing = await readConfig();

    if (!existing.mcpServers || !("browserops" in existing.mcpServers)) {
      return { changed: false, configPath: CONFIG_PATH, message: "no change (not found)" };
    }

    if (dryRun) {
      return { changed: true, configPath: CONFIG_PATH, message: `would edit ${CONFIG_PATH}` };
    }

    delete existing.mcpServers["browserops"];
    const backupPath = await backup(CONFIG_PATH);
    await atomicWrite(CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n");
    return {
      changed: true,
      configPath: CONFIG_PATH,
      backupPath,
      message: `removed from ${CONFIG_PATH}`,
    };
  },
};
