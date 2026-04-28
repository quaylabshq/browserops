import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWrite, backup } from "../lib/fs.js";
import type { ClientId, ClientInfo, ClientInstaller, InstallResult, InstallSpec } from "./types.js";

const home = homedir();
const CONTINUE_DIR = join(home, ".continue");
const JSON_PATH = join(CONTINUE_DIR, "config.json");
const ID: ClientId = "continue";
const LABEL = "Continue";

interface ContinueConfig {
  experimental?: {
    modelContextProtocolServers?: Array<Record<string, unknown>>;
  };
  [key: string]: unknown;
}

async function resolveConfigPath(): Promise<string> {
  try {
    await access(JSON_PATH, constants.F_OK);
    return JSON_PATH;
  } catch {
    return JSON_PATH;
  }
}

async function readConfig(path: string): Promise<ContinueConfig> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as ContinueConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot parse ${path}: ${(e as Error).message}`);
  }
}

function isBrowseropsEntry(s: unknown, specCommand: string): boolean {
  if (typeof s !== "object" || s === null) return false;
  const transport = (s as Record<string, unknown>)["transport"] as Record<string, unknown> | undefined;
  const cmd = transport?.["command"];
  if (typeof cmd !== "string") return false;
  if (cmd.includes("browserops-shim") || cmd.includes("browserops-bridge") || cmd === specCommand) return true;
  // command may be "node" with args pointing at the bridge dist
  const args = transport?.["args"];
  if (Array.isArray(args)) {
    return args.some((a) => typeof a === "string" && a.includes("browserops"));
  }
  return false;
}

export const continueInstaller: ClientInstaller = {
  id: ID,
  label: LABEL,

  async detect(): Promise<ClientInfo> {
    let detected = false;
    try {
      await access(CONTINUE_DIR, constants.F_OK);
      detected = true;
    } catch {
      // not found
    }

    const configPath = await resolveConfigPath();
    let alreadyInstalled = false;
    const cfg = await readConfig(configPath);
    const servers = cfg.experimental?.modelContextProtocolServers;
    if (Array.isArray(servers)) {
      alreadyInstalled = servers.some((s) => isBrowseropsEntry(s, "browserops-shim"));
    }

    return { id: ID, label: LABEL, detected, configPath, alreadyInstalled };
  },

  async install(spec: InstallSpec, opts?: { dryRun?: boolean }): Promise<InstallResult> {
    const dryRun = opts?.dryRun ?? false;
    const configPath = await resolveConfigPath();
    const existing = await readConfig(configPath);
    const before = JSON.stringify(existing);

    existing.experimental = existing.experimental ?? {};
    const servers: Array<Record<string, unknown>> = existing.experimental.modelContextProtocolServers ?? [];

    const newEntry: Record<string, unknown> = {
      transport: {
        type: "stdio",
        command: spec.command,
        args: spec.args ?? [],
      },
    };

    const idx = servers.findIndex((s) => isBrowseropsEntry(s, spec.command));
    if (idx >= 0) {
      servers[idx] = newEntry;
    } else {
      servers.push(newEntry);
    }

    existing.experimental.modelContextProtocolServers = servers;
    const after = JSON.stringify(existing, null, 2);

    if (before === after) {
      return { changed: false, configPath, message: "no change" };
    }

    if (dryRun) {
      return { changed: true, configPath, message: `would merge ${configPath}` };
    }

    await mkdir(dirname(configPath), { recursive: true });
    const backupPath = await backup(configPath);
    await atomicWrite(configPath, after + "\n");
    return { changed: true, configPath, backupPath, message: `merged ${configPath}` };
  },

  async uninstall(opts?: { dryRun?: boolean }): Promise<InstallResult> {
    const dryRun = opts?.dryRun ?? false;
    const configPath = await resolveConfigPath();
    const existing = await readConfig(configPath);

    const servers = existing.experimental?.modelContextProtocolServers;
    if (!Array.isArray(servers)) {
      return { changed: false, configPath, message: "no change (not found)" };
    }

    const filtered = servers.filter((s) => !isBrowseropsEntry(s, "browserops-shim"));
    if (filtered.length === servers.length) {
      return { changed: false, configPath, message: "no change (not found)" };
    }

    if (dryRun) {
      return { changed: true, configPath, message: `would edit ${configPath}` };
    }

    existing.experimental!.modelContextProtocolServers = filtered;
    const backupPath = await backup(configPath);
    await atomicWrite(configPath, JSON.stringify(existing, null, 2) + "\n");
    return { changed: true, configPath, backupPath, message: `removed from ${configPath}` };
  },
};
