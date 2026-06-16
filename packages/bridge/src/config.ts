/**
 * Bridge config loader.
 *
 * Source of truth for feature flags is ~/.browserops/config.json:
 *   {
 *     "features": { "procedures": true, "lore": true }
 *   }
 *
 * The BROWSEROPS_FEATURES env var (comma-separated names) overrides the
 * file when explicitly set — useful for one-shot CI runs and the
 * `browserops --features=...` CLI flag.
 *
 * The CLI's `browserops feature enable/disable` mutates the file via
 * writeConfigFeatures and then signals the running daemon over the
 * existing control socket so it can re-read without a restart.
 */
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { ENV, type FeatureName, parseFeaturesEnv, resolveFeatures } from "@browserops/shared";
import { configPath } from "./paths.js";

interface ConfigFileShape {
  features?: Partial<Record<FeatureName, boolean>>;
  /**
   * When true, launchers (the CLI `--claude` flag and the extension's
   * "Launch Claude here" button) start `claude` WITHOUT
   * `--dangerously-skip-permissions`, so Claude prompts for each action.
   * Absent/false (the default) means danger mode. Written by the CLI's
   * `browserops config set safe_mode <bool>`; mirrors the CLI's getSafeMode.
   */
  safe_mode?: boolean;
}

export interface FeatureResolution {
  enabled: Set<FeatureName>;
  /** Source label for logs / diagnostics. */
  source: "env" | "config_file" | "defaults";
  /** Names in BROWSEROPS_FEATURES we couldn't recognise. Logged at boot. */
  unknownEnv: string[];
}

export async function loadConfigFeatures(): Promise<FeatureResolution> {
  const envRaw = process.env[ENV.FEATURES];
  // env explicitly set (even to empty string) wins over the file.
  if (envRaw !== undefined) {
    const parsed = parseFeaturesEnv(envRaw);
    return { enabled: parsed.enabled, source: "env", unknownEnv: parsed.unknown };
  }

  let fileShape: ConfigFileShape | null = null;
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw) as ConfigFileShape;
    if (parsed !== null && typeof parsed === "object") fileShape = parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return {
    enabled: resolveFeatures(fileShape?.features),
    source: fileShape !== null ? "config_file" : "defaults",
    unknownEnv: [],
  };
}

/**
 * Read the `safe_mode` flag from the config file. Defaults to `false`
 * (danger mode) when the file is missing, unreadable, or malformed —
 * matching the CLI launcher's getSafeMode so the daemon-side launch path
 * and `browserops --claude` agree on the danger flag.
 *
 * The path is injectable for hermetic tests; production callers use the
 * default `configPath()` (`~/.browserops/config.json`).
 */
export async function loadSafeMode(path: string = configPath()): Promise<boolean> {
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ConfigFileShape;
    return parsed?.safe_mode === true;
  } catch {
    // ENOENT, parse error, or anything else → default to danger mode.
    return false;
  }
}

/**
 * Merge `updates` into the config file, creating it if absent. Used by the
 * CLI's `feature enable / disable` commands. Atomic write via temp-file
 * rename so a crash mid-write can't leave a half-baked JSON document.
 */
export async function writeConfigFeatures(
  updates: Partial<Record<FeatureName, boolean>>,
): Promise<void> {
  const path = configPath();
  let current: ConfigFileShape = {};
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ConfigFileShape;
    if (parsed !== null && typeof parsed === "object") current = parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  current.features = { ...(current.features ?? {}), ...updates };

  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(current, null, 2) + "\n", "utf8");
  await fs.rename(tmp, path);
}
