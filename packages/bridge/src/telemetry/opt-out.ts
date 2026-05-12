/**
 * Telemetry opt-out resolution.
 *
 * Precedence (first match wins):
 *   1. DO_NOT_TRACK truthy        → off (industry convention; non-overridable)
 *   2. BROWSEROPS_TELEMETRY=...   → that value
 *   3. ~/.browserops/config.json  → "telemetry" boolean
 *   4. default                    → on
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { STATE_DIR_NAME } from "@browserops/shared";

export const TELEMETRY_ENV = "BROWSEROPS_TELEMETRY";
export const DO_NOT_TRACK_ENV = "DO_NOT_TRACK";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

interface ConfigShape {
  telemetry?: unknown;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export async function isTelemetryEnabled(opts: ResolveOptions = {}): Promise<boolean> {
  const env = opts.env ?? process.env;

  const dnt = (env[DO_NOT_TRACK_ENV] ?? "").trim().toLowerCase();
  if (TRUTHY.has(dnt)) return false;

  const own = env[TELEMETRY_ENV];
  if (own !== undefined) {
    const lower = own.trim().toLowerCase();
    if (FALSY.has(lower)) return false;
    if (TRUTHY.has(lower)) return true;
  }

  try {
    const path = opts.configPath ?? join(homedir(), STATE_DIR_NAME, "config.json");
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ConfigShape;
    if (typeof parsed?.telemetry === "boolean") return parsed.telemetry;
  } catch {
    // ENOENT, parse error, perms — defaults apply.
  }

  return true;
}
