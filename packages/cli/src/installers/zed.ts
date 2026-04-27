import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  parse as parseJsonc,
  modify,
  applyEdits,
  type ParseError,
} from "jsonc-parser";
import { atomicWrite, backup } from "../lib/fs.js";
import type { ClientId, ClientInfo, ClientInstaller, InstallResult, InstallSpec } from "./types.js";

const home = homedir();
const CONFIG_PATH = join(home, ".config", "zed", "settings.json");
const ID: ClientId = "zed";
const LABEL = "Zed";

async function readRaw(): Promise<string> {
  try {
    return await readFile(CONFIG_PATH, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "{}";
    throw new Error(`Cannot read ${CONFIG_PATH}: ${(e as Error).message}`);
  }
}

function parseOrThrow(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const val = parseJsonc(text, errors, { allowTrailingComma: true }) as Record<string, unknown>;
  if (errors.length > 0) {
    throw new Error(`Cannot parse ${CONFIG_PATH}: JSONC parse error`);
  }
  return val;
}

export const zedInstaller: ClientInstaller = {
  id: ID,
  label: LABEL,

  async detect(): Promise<ClientInfo> {
    let detected = false;
    try {
      await access(join(home, ".config", "zed"), constants.F_OK);
      detected = true;
    } catch {
      try {
        await access("/Applications/Zed.app", constants.F_OK);
        detected = true;
      } catch {
        try {
          const { exec } = await import("node:child_process");
          const { promisify } = await import("node:util");
          await promisify(exec)("which zed");
          detected = true;
        } catch {
          // not found
        }
      }
    }

    let alreadyInstalled = false;
    try {
      const text = await readRaw();
      const data = parseOrThrow(text);
      if (typeof data["context_servers"] === "object" && data["context_servers"] !== null) {
        alreadyInstalled = "browserops" in (data["context_servers"] as object);
      }
    } catch {
      // unparseable or missing — not installed
    }

    return { id: ID, label: LABEL, detected, configPath: CONFIG_PATH, alreadyInstalled };
  },

  async install(spec: InstallSpec, opts?: { dryRun?: boolean }): Promise<InstallResult> {
    const dryRun = opts?.dryRun ?? false;
    const rawBefore = await readRaw();

    parseOrThrow(rawBefore);

    const serverEntry = {
      command: {
        path: spec.command,
        args: spec.args ?? [],
      },
    };

    const edits = modify(rawBefore, ["context_servers", "browserops"], serverEntry, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    const rawAfter = applyEdits(rawBefore, edits);

    if (rawBefore === rawAfter) {
      return { changed: false, configPath: CONFIG_PATH, message: "no change" };
    }

    if (dryRun) {
      return { changed: true, configPath: CONFIG_PATH, message: `would merge ${CONFIG_PATH}` };
    }

    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    const backupPath = await backup(CONFIG_PATH);
    await atomicWrite(CONFIG_PATH, rawAfter);
    return { changed: true, configPath: CONFIG_PATH, backupPath, message: `merged ${CONFIG_PATH}` };
  },

  async uninstall(opts?: { dryRun?: boolean }): Promise<InstallResult> {
    const dryRun = opts?.dryRun ?? false;
    const rawBefore = await readRaw();

    const data = parseOrThrow(rawBefore);
    const servers = data["context_servers"];
    if (typeof servers !== "object" || servers === null || !("browserops" in (servers as object))) {
      return { changed: false, configPath: CONFIG_PATH, message: "no change (not found)" };
    }

    const edits = modify(rawBefore, ["context_servers", "browserops"], undefined, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    const rawAfter = applyEdits(rawBefore, edits);

    if (dryRun) {
      return { changed: true, configPath: CONFIG_PATH, message: `would edit ${CONFIG_PATH}` };
    }

    const backupPath = await backup(CONFIG_PATH);
    await atomicWrite(CONFIG_PATH, rawAfter);
    return { changed: true, configPath: CONFIG_PATH, backupPath, message: `removed from ${CONFIG_PATH}` };
  },
};
