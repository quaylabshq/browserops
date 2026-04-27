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
import {
  FEATURES,
  FEATURE_METADATA,
  isFeatureName,
  resolveFeatures,
  type FeatureName,
} from "@browserops/shared";
import { atomicWrite, backup } from "./fs.js";
import { configPath, STATE_DIR } from "./paths.js";

export type LauncherId = "claude" | "codex" | "cursor";

export interface BrowserOpsConfig {
  default_launcher?: LauncherId;
  safe_mode?: boolean;
  /**
   * Gated feature flags. The bridge reads this same file and uses
   * resolveFeatures() to merge against FEATURE_METADATA defaults.
   * Managed via `browserops feature enable/disable`, not `config set`.
   */
  features?: Partial<Record<FeatureName, boolean>>;
}

/**
 * Subset of BrowserOpsConfig keys managed by `browserops config set/get`.
 * `features` is excluded — it has its own dedicated `feature` subcommand
 * because the value is a sub-object, not a single primitive.
 */
export type ConfigKey = Exclude<keyof BrowserOpsConfig, "features">;

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

// ---------------------------------------------------------------------------
// Gated features — managed via `browserops feature enable/disable`
// ---------------------------------------------------------------------------

export interface FeatureState {
  name: FeatureName;
  enabled: boolean;
  /** Reason for the resolved state, useful in `feature list` output. */
  source: "default" | "config";
  description: string;
  stability: "stable" | "experimental";
}

/** Resolve every known feature against the config file + manifest defaults. */
export async function getFeatureStates(): Promise<FeatureState[]> {
  const cfg = await readConfig();
  const partial = cfg.features ?? {};
  return FEATURES.map<FeatureState>((name) => {
    const explicit = partial[name];
    const enabled =
      typeof explicit === "boolean" ? explicit : FEATURE_METADATA[name].default;
    return {
      name,
      enabled,
      source: typeof explicit === "boolean" ? "config" : "default",
      description: FEATURE_METADATA[name].description,
      stability: FEATURE_METADATA[name].stability,
    };
  });
}

/** Same as the bridge's resolveFeatures but reading the CLI's config layer. */
export async function getEnabledFeatureSet(): Promise<Set<FeatureName>> {
  const cfg = await readConfig();
  return resolveFeatures(cfg.features);
}

/** Persist a single feature flag. */
export async function setFeatureEnabled(
  name: FeatureName,
  enabled: boolean,
): Promise<{ changed: boolean; backupPath?: string }> {
  const cfg = await readConfig();
  const current = cfg.features?.[name];
  const desired = enabled;
  if (current === desired) return { changed: false };
  const next: BrowserOpsConfig = {
    ...cfg,
    features: { ...(cfg.features ?? {}), [name]: desired },
  };
  const { backupPath } = await writeConfig(next);
  return { changed: true, ...(backupPath !== undefined ? { backupPath } : {}) };
}

/** Bulk-apply a partial feature record (for the init wizard). */
export async function applyFeaturePartial(
  partial: Partial<Record<FeatureName, boolean>>,
): Promise<{ changed: boolean }> {
  const cfg = await readConfig();
  const merged = { ...(cfg.features ?? {}) };
  let changed = false;
  for (const [k, v] of Object.entries(partial)) {
    if (!isFeatureName(k)) continue;
    if (typeof v !== "boolean") continue;
    if (merged[k] !== v) {
      merged[k] = v;
      changed = true;
    }
  }
  if (!changed) return { changed: false };
  const next: BrowserOpsConfig = { ...cfg, features: merged };
  await writeConfig(next);
  return { changed: true };
}
