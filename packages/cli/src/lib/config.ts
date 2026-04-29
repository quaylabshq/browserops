/**
 * Persisted CLI config at ~/.browserops/config.json.
 *
 * Schema is closed (every key has a known type and validator) so that
 * `browserops config set foo bar` rejects typos at write time rather than
 * silently writing junk that gets ignored at read time.
 */
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWrite, backup } from "./fs.js";
import { configPath, STATE_DIR } from "./paths.js";

export type LauncherId = "claude" | "codex" | "cursor";

export interface BrowserOpsConfig {
  default_launcher?: LauncherId;
  safe_mode?: boolean;
}

export type ConfigKey = keyof BrowserOpsConfig;

const VALID_LAUNCHERS: readonly LauncherId[] = ["claude", "codex", "cursor"];

const TRUTHY = new Set(["true", "1", "yes", "on"]);
const FALSY = new Set(["false", "0", "no", "off"]);

interface KeySpec {
  description: string;
  validate(value: string): { ok: true; value: unknown } | { ok: false; error: string };
}

export const CONFIG_SCHEMA: Record<ConfigKey, KeySpec> = {
  default_launcher: {
    description: `Editor used by \`browserops "task"\` (one of: ${VALID_LAUNCHERS.join(", ")})`,
    validate(value) {
      if ((VALID_LAUNCHERS as readonly string[]).includes(value)) {
        return { ok: true, value: value as LauncherId };
      }
      return { ok: false, error: `must be one of: ${VALID_LAUNCHERS.join(", ")}` };
    },
  },
  safe_mode: {
    description:
      "When true, launchers run with their normal permission prompts. When false (default), claude is invoked with --dangerously-skip-permissions and codex with --full-auto so the agent runs without per-action approvals. Browser-side risky-action gating in the bridge is unaffected.",
    validate(value) {
      const v = value.trim().toLowerCase();
      if (TRUTHY.has(v)) return { ok: true, value: true };
      if (FALSY.has(v)) return { ok: true, value: false };
      return { ok: false, error: "must be true or false" };
    },
  },
};

export const KNOWN_CONFIG_KEYS = Object.keys(CONFIG_SCHEMA) as ConfigKey[];

export function isKnownKey(key: string): key is ConfigKey {
  return key in CONFIG_SCHEMA;
}

export async function readConfig(): Promise<BrowserOpsConfig> {
  const path = configPath();
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as BrowserOpsConfig;
    }
    return {};
  } catch {
    // Don't blow up on a corrupt config — caller can decide what to do.
    return {};
  }
}

export async function writeConfig(cfg: BrowserOpsConfig): Promise<{ backupPath?: string }> {
  await fs.mkdir(dirname(configPath()), { recursive: true });
  await fs.mkdir(STATE_DIR, { recursive: true });
  const backupPath = await backup(configPath());
  await atomicWrite(configPath(), JSON.stringify(cfg, null, 2) + "\n");
  return { backupPath };
}

export async function setConfigValue(
  key: ConfigKey,
  rawValue: string,
): Promise<{ backupPath?: string; coercedValue: unknown }> {
  const spec = CONFIG_SCHEMA[key];
  const result = spec.validate(rawValue);
  if (!result.ok) {
    throw new Error(`invalid value for ${key}: ${result.error}`);
  }
  const cfg = await readConfig();
  const next = { ...cfg, [key]: result.value } as BrowserOpsConfig;
  const { backupPath } = await writeConfig(next);
  return { backupPath, coercedValue: result.value };
}

export async function unsetConfigValue(key: ConfigKey): Promise<{ changed: boolean }> {
  const cfg = await readConfig();
  if (!(key in cfg)) return { changed: false };
  const next = { ...cfg };
  delete next[key];
  await writeConfig(next);
  return { changed: true };
}

/**
 * Resolve the configured default launcher, falling back to "claude" when
 * unset or invalid. The fallback exists so a fresh install can immediately
 * run `browserops "task"` without forcing the user to run `config set` first.
 */
export async function getDefaultLauncher(): Promise<{
  id: LauncherId;
  configured: boolean;
}> {
  const cfg = await readConfig();
  const v = cfg.default_launcher;
  if (v && (VALID_LAUNCHERS as readonly string[]).includes(v)) {
    return { id: v, configured: true };
  }
  return { id: "claude", configured: false };
}

/**
 * Returns true when the user has opted into safe mode (launchers run with
 * their normal per-action approval prompts). Default false: claude gets
 * --dangerously-skip-permissions, codex gets --full-auto.
 */
export async function getSafeMode(): Promise<boolean> {
  const cfg = await readConfig();
  return cfg.safe_mode === true;
}
