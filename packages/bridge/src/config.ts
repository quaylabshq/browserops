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
import {
  DEFAULT_CHAT_SETTINGS,
  canChatAgent,
  type AgentId,
  type ChatSettings,
  ENV,
  type FeatureName,
  parseFeaturesEnv,
  resolveFeatures,
} from "@browserops/shared";
import { configPath } from "./paths.js";

/**
 * Which transport the in-panel chat engine uses for every provider:
 *  - `terminal` (default): a real INTERACTIVE provider TUI on a hidden PTY —
 *    input injected at the TTY, output read from the provider's own transcript.
 *  - `headless`: one non-interactive stream process per turn.
 * Driver selection degrades `terminal` → `headless` per provider when node-pty
 * can't load or start, so this is a preference, not a hard requirement.
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
  /** Sidebar chat defaults. These are deliberately separate from CLI launchers. */
  chat_default_agent?: AgentId;
  chat_models?: Partial<Record<AgentId, string>>;
  chat_reasoning_efforts?: Partial<Record<AgentId, string>>;
}

function asAgentStringMap(value: unknown): Partial<Record<AgentId, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Partial<Record<AgentId, string>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (canChatAgent(key) && typeof raw === "string" && raw.trim().length > 0) {
      out[key] = raw.trim().slice(0, 160);
    }
  }
  return out;
}

function chatSettingsFromFile(file: ConfigFileShape | null): ChatSettings {
  const defaultAgent = file?.chat_default_agent;
  return {
    defaultAgent:
      defaultAgent && canChatAgent(defaultAgent)
        ? defaultAgent
        : DEFAULT_CHAT_SETTINGS.defaultAgent,
    models: asAgentStringMap(file?.chat_models),
    reasoningEfforts: asAgentStringMap(file?.chat_reasoning_efforts),
    safeMode: file?.safe_mode === true,
    transport: isChatTransport(file?.chat_transport)
      ? file.chat_transport
      : DEFAULT_CHAT_SETTINGS.transport,
  };
}

async function readConfigFile(path: string): Promise<ConfigFileShape | null> {
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as ConfigFileShape)
      : null;
  } catch {
    return null;
  }
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

/** Read non-secret sidebar chat preferences from the shared BrowserOps config. */
export async function loadChatSettings(path: string = configPath()): Promise<ChatSettings> {
  return chatSettingsFromFile(await readConfigFile(path));
}

/**
 * Persist a validated partial settings update. Transport is written for the
 * next daemon boot; model/default/safety settings are read for every new chat.
 */
export async function updateChatSettings(
  updates: Partial<ChatSettings>,
  path: string = configPath(),
): Promise<ChatSettings> {
  const current = (await readConfigFile(path)) ?? {};
  const previous = chatSettingsFromFile(current);
  const next: ChatSettings = {
    defaultAgent:
      updates.defaultAgent && canChatAgent(updates.defaultAgent)
        ? updates.defaultAgent
        : previous.defaultAgent,
    models: updates.models === undefined ? previous.models : asAgentStringMap(updates.models),
    reasoningEfforts:
      updates.reasoningEfforts === undefined
        ? previous.reasoningEfforts
        : asAgentStringMap(updates.reasoningEfforts),
    safeMode: updates.safeMode === undefined ? previous.safeMode : updates.safeMode === true,
    transport:
      updates.transport !== undefined && isChatTransport(updates.transport)
        ? updates.transport
        : previous.transport,
  };
  const out: ConfigFileShape = {
    ...current,
    safe_mode: next.safeMode,
    chat_transport: next.transport,
    chat_default_agent: next.defaultAgent,
    chat_models: next.models,
    chat_reasoning_efforts: next.reasoningEfforts,
  };
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(out, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, path);
  return next;
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
