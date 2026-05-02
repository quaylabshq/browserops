import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { exec } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { atomicWrite, backup } from "../lib/fs.js";
import type { ClientId, ClientInfo, ClientInstaller, InstallResult, InstallSpec } from "./types.js";

const execAsync = promisify(exec);
const home = homedir();
const CONFIG_PATH = join(home, ".codex", "config.toml");
const ID: ClientId = "codex";
const LABEL = "Codex CLI";

const SECTION_REGEX = /^\[mcp_servers\.browserops\]/m;
const NEXT_SECTION_REGEX = /^\[/m;

function buildBlock(spec: InstallSpec): string {
  const args = spec.args && spec.args.length > 0
    ? `[${spec.args.map((a) => JSON.stringify(a)).join(", ")}]`
    : "[]";
  return `[mcp_servers.browserops]\ncommand = ${JSON.stringify(spec.command)}\nargs = ${args}\n`;
}

async function readRaw(): Promise<string> {
  try {
    return await readFile(CONFIG_PATH, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error(`Cannot read ${CONFIG_PATH}: ${(e as Error).message}`);
  }
}

function replaceOrAppendBlock(raw: string, block: string): string {
  if (!SECTION_REGEX.test(raw)) {
    const base = raw.endsWith("\n") || raw.length === 0 ? raw : raw + "\n";
    return base + block;
  }

  const start = raw.search(SECTION_REGEX);
  const afterHeader = raw.indexOf("\n", start);
  if (afterHeader === -1) {
    return raw.slice(0, start) + block;
  }

  const rest = raw.slice(afterHeader + 1);
  const nextSection = rest.search(NEXT_SECTION_REGEX);
  const end = nextSection === -1 ? raw.length : afterHeader + 1 + nextSection;

  return raw.slice(0, start) + block + raw.slice(end);
}

export const codexInstaller: ClientInstaller = {
  id: ID,
  label: LABEL,

  async detect(): Promise<ClientInfo> {
    let detected = false;
    try {
      await execAsync("which codex");
      detected = true;
    } catch {
      // not on PATH
    }

    let alreadyInstalled = false;
    try {
      await access(CONFIG_PATH, constants.F_OK);
      const text = await readFile(CONFIG_PATH, "utf8");
      alreadyInstalled = SECTION_REGEX.test(text);
    } catch {
      // file missing
    }

    return { id: ID, label: LABEL, detected, configPath: CONFIG_PATH, alreadyInstalled };
  },

  async install(spec: InstallSpec, opts?: { dryRun?: boolean }): Promise<InstallResult> {
    const dryRun = opts?.dryRun ?? false;
    const rawBefore = await readRaw();
    const block = buildBlock(spec);
    const rawAfter = replaceOrAppendBlock(rawBefore, block);

    const normalized = rawAfter.endsWith("\n") ? rawAfter : rawAfter + "\n";

    if (rawBefore === normalized) {
      return { changed: false, configPath: CONFIG_PATH, message: "no change" };
    }

    if (dryRun) {
      return { changed: true, configPath: CONFIG_PATH, message: `would merge ${CONFIG_PATH}` };
    }

    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    const backupPath = rawBefore.length > 0 ? await backup(CONFIG_PATH) : undefined;
    await atomicWrite(CONFIG_PATH, normalized);
    return { changed: true, configPath: CONFIG_PATH, backupPath, message: `merged ${CONFIG_PATH}` };
  },

  async uninstall(opts?: { dryRun?: boolean }): Promise<InstallResult> {
    const dryRun = opts?.dryRun ?? false;
    const rawBefore = await readRaw();

    if (!SECTION_REGEX.test(rawBefore)) {
      return { changed: false, configPath: CONFIG_PATH, message: "no change (not found)" };
    }

    const start = rawBefore.search(SECTION_REGEX);
    const afterHeader = rawBefore.indexOf("\n", start);
    if (afterHeader === -1) {
      const rawAfter = (rawBefore.slice(0, start) || "").trimEnd() + "\n";
      if (dryRun) {
        return { changed: true, configPath: CONFIG_PATH, message: `would edit ${CONFIG_PATH}` };
      }
      const backupPath = await backup(CONFIG_PATH);
      await atomicWrite(CONFIG_PATH, rawAfter || "\n");
      return { changed: true, configPath: CONFIG_PATH, backupPath, message: `removed from ${CONFIG_PATH}` };
    }

    const rest = rawBefore.slice(afterHeader + 1);
    const nextSection = rest.search(NEXT_SECTION_REGEX);
    const end = nextSection === -1 ? rawBefore.length : afterHeader + 1 + nextSection;

    let rawAfter = rawBefore.slice(0, start) + rawBefore.slice(end);
    if (!rawAfter.endsWith("\n")) rawAfter += "\n";

    if (dryRun) {
      return { changed: true, configPath: CONFIG_PATH, message: `would edit ${CONFIG_PATH}` };
    }

    const backupPath = await backup(CONFIG_PATH);
    await atomicWrite(CONFIG_PATH, rawAfter);
    return { changed: true, configPath: CONFIG_PATH, backupPath, message: `removed from ${CONFIG_PATH}` };
  },
};
