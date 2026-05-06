/**
 * Public entry point. initTelemetry() boots the singleton; getTelemetry()
 * returns it (or null when telemetry is disabled / pre-init).
 */
import { PostHogHttpClient } from "./posthog-http.js";
import { loadOrCreateInstallId } from "./install-id.js";
import { isTelemetryEnabled } from "./opt-out.js";
import { buildCommonProps, captureEvent } from "./events.js";

const DEFAULT_API_KEY = "phc_BNdKUvhapUoZEdt9iXT7eYZgoWrthrZtWuRpPqQ94Nz8";
const DEFAULT_HOST = "https://us.i.posthog.com";

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
export async function initTelemetry(
  opts: TelemetryInitOptions = {},
): Promise<TelemetryInitResult> {
  try {
    const enabled = await isTelemetryEnabled();
    const { id: distinctId, created: installCreated } = await loadOrCreateInstallId();

    const apiKey =
      process.env["BROWSEROPS_POSTHOG_KEY"] || opts.apiKey || DEFAULT_API_KEY;
    const host =
      process.env["BROWSEROPS_POSTHOG_HOST"] || opts.host || DEFAULT_HOST;

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
      client.identify(set, { first_seen: new Date().toISOString() });
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
export { isTelemetryEnabled, TELEMETRY_ENV, DO_NOT_TRACK_ENV } from "./opt-out.js";
export {
  loadOrCreateInstallId,
  installIdPath,
  INSTALL_ID_FILENAME,
} from "./install-id.js";
export { captureEvent, buildCommonProps } from "./events.js";
export type { CommonProps } from "./events.js";
export { redact, isAllowedEvent } from "./redact.js";
export type { AllowedEvent } from "./redact.js";
