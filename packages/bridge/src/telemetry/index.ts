/**
 * Public entry point. initTelemetry() boots the singleton; getTelemetry()
 * returns it (or null when telemetry is disabled / pre-init).
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { STATE_DIR_NAME } from "@browserops/shared";
import { PostHogHttpClient } from "./posthog-http.js";
import { loadOrCreateInstallId } from "./install-id.js";
import { isTelemetryEnabled, isEmailAliasEnabled } from "./opt-out.js";

const DEFAULT_API_KEY = "phc_BNdKUvhapUoZEdt9iXT7eYZgoWrthrZtWuRpPqQ94Nz8";
const DEFAULT_HOST = "https://us.i.posthog.com";

/**
 * Read identity.email from ~/.browserops/config.json. Returns undefined
 * if missing, malformed, or unreadable. Defensive: any IO error falls
 * back to undefined so a corrupt config can't break telemetry boot.
 */
async function readIdentityEmail(): Promise<string | undefined> {
  try {
    const path = join(homedir(), STATE_DIR_NAME, "config.json");
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { identity?: { email?: unknown } };
    const email = parsed?.identity?.email;
    return typeof email === "string" && email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}

export interface TelemetryInitOptions {
  bridgeVersion?: string;
  cliVersion?: string;
  /** Override for tests / staging projects. */
  apiKey?: string;
  host?: string;
  fetchImpl?: typeof fetch;
}

export interface TelemetryInitResult {
  client: PostHogHttpClient;
  enabled: boolean;
  distinctId: string;
  installCreated: boolean;
}

let singleton: PostHogHttpClient | null = null;

/**
 * Boot the telemetry client. Defensive: any failure in opt-out resolution,
 * install-id load, or identify enqueue is swallowed and returns a disabled
 * stub client. Telemetry must never break the daemon or CLI.
 */
export async function initTelemetry(opts: TelemetryInitOptions = {}): Promise<TelemetryInitResult> {
  try {
    const enabled = isTelemetryEnabled();
    const { id: distinctId, created: installCreated } = await loadOrCreateInstallId();

    const apiKey = process.env["BROWSEROPS_POSTHOG_KEY"] || opts.apiKey || DEFAULT_API_KEY;
    const host = process.env["BROWSEROPS_POSTHOG_HOST"] || opts.host || DEFAULT_HOST;

    const client = new PostHogHttpClient({
      apiKey,
      host,
      distinctId,
      enabled,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });

    if (enabled) {
      const set: Record<string, unknown> = {
        last_seen: new Date().toISOString(),
        os_platform: process.platform,
        os_arch: process.arch,
        node_major: Number(process.versions.node.split(".")[0] ?? 0),
      };
      if (opts.bridgeVersion) set["bridge_version"] = opts.bridgeVersion;
      if (opts.cliVersion) set["cli_version"] = opts.cliVersion;
      const emailConsent = isEmailAliasEnabled();
      const email = emailConsent ? await readIdentityEmail() : undefined;
      if (email) set["email"] = email;
      client.identify(set, { first_seen: new Date().toISOString() });
      if (email) client.alias(email);
    }

    singleton = client;
    return { client, enabled, distinctId, installCreated };
  } catch {
    const FALLBACK_ID = "00000000-0000-0000-0000-000000000000";
    const stub = new PostHogHttpClient({
      apiKey: "",
      host: DEFAULT_HOST,
      distinctId: FALLBACK_ID,
      enabled: false,
    });
    singleton = stub;
    return {
      client: stub,
      enabled: false,
      distinctId: FALLBACK_ID,
      installCreated: false,
    };
  }
}

export function getTelemetry(): PostHogHttpClient | null {
  return singleton;
}

export function resetTelemetryForTest(): void {
  singleton = null;
}

export { PostHogHttpClient } from "./posthog-http.js";
export {
  isTelemetryEnabled,
  isEmailAliasEnabled,
  DO_NOT_TRACK_ENV,
  BROWSEROPS_TELEMETRY_ENV,
  BROWSEROPS_ALIAS_EMAIL_ENV,
} from "./opt-out.js";
export { loadOrCreateInstallId, installIdPath, INSTALL_ID_FILENAME } from "./install-id.js";
export { captureEvent, buildCommonProps } from "./events.js";
export type { CommonProps } from "./events.js";
export { redact, isAllowedEvent } from "./redact.js";
export type { AllowedEvent } from "./redact.js";
