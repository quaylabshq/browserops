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

/**
 * Which transport the in-panel chat engine uses to drive Claude:
 *  - `terminal` (default): a real INTERACTIVE `claude` session on a pty — input
 *    injected at the TTY, output read from Claude's own transcript — which is
 *    indistinguishable from hand-usage (no `--print`, no skip-permissions).
 *  - `headless`: the `claude --print` stream-json driver (one process per turn).
 * Driver selection degrades `terminal` → `headless` automatically when node-pty
 * can't load, so this is a preference, not a hard requirement.
 */
export type ChatTransport = "terminal" | "headless";

const CHAT_TRANSPORTS: readonly ChatTransport[] = ["terminal", "headless"];

function isChatTransport(value: unknown): value is ChatTransport {
  return typeof value === "string" && (CHAT_TRANSPORTS as readonly string[]).includes(value);
}

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
  /** In-panel chat transport. See {@link ChatTransport}. */
  chat_transport?: ChatTransport;
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
 * Resolve the in-panel chat transport. Resolution order:
 *   1. the `BROWSEROPS_CHAT_TRANSPORT` env override (one-shot runs / E2E),
 *   2. the config file's `chat_transport`,
 *   3. the `"terminal"` default.
 * Unknown / malformed values fall through to the default rather than throwing —
 * driver selection then degrades to headless at runtime if node-pty is missing.
 * The path is injectable for hermetic tests.
 */
export async function loadChatTransport(path: string = configPath()): Promise<ChatTransport> {
  const envOverride = process.env["BROWSEROPS_CHAT_TRANSPORT"];
  if (isChatTransport(envOverride)) return envOverride;
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ConfigFileShape | null;
    const fromFile = parsed?.chat_transport;
    if (isChatTransport(fromFile)) return fromFile;
  } catch {
    // ENOENT, parse error, or anything else → default.
  }
  return "terminal";
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
