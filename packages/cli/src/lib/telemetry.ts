/**
 * CLI-side telemetry. The CLI is a short-lived process so it gets a
 * minimal client (single in-memory queue, single fire-and-forget HTTP
 * POST on flush). The persistent state — install-id and the opt-out
 * config — is shared with the daemon so distinct_id and on/off match
 * across both processes.
 *
 * Kept deliberately small (no class hierarchy, no batching loop) so it
 * doesn't drift far from packages/bridge/src/telemetry/. Keys and
 * allowed event names mirror the bridge allowlist exactly.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { STATE_DIR_NAME } from "@browserops/shared";

const POSTHOG_KEY = "phc_BNdKUvhapUoZEdt9iXT7eYZgoWrthrZtWuRpPqQ94Nz8";
const POSTHOG_HOST = "https://us.i.posthog.com";
const FLUSH_TIMEOUT_MS = 1_500;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COMMON_PROPS = new Set([
  "bridge_version",
  "cli_version",
  "os_platform",
  "os_arch",
  "node_major",
]);

const ALLOWED: Record<string, ReadonlySet<string>> = {
  "cli.init_completed": new Set([
    "clients_installed",
    "features_enabled",
    "interactive",
    "email_provided",
    "exit_code",
    "duration_ms",
  ]),
  "cli.start_invoked": new Set(["exit_code", "duration_ms"]),
  "cli.stop_invoked": new Set(["exit_code", "duration_ms"]),
  "cli.restart_invoked": new Set(["exit_code", "duration_ms"]),
  "cli.status_checked": new Set(["daemon_running", "exit_code", "duration_ms"]),
  "cli.doctor_ran": new Set([
    "checks_passed",
    "checks_failed",
    "exit_code",
    "duration_ms",
  ]),
  "cli.logs_tailed": new Set(["follow", "lines", "exit_code", "duration_ms"]),
  "cli.feature_listed": new Set(["enabled_count", "exit_code", "duration_ms"]),
  "cli.feature_enabled": new Set(["feature_name", "exit_code", "duration_ms"]),
  "cli.feature_disabled": new Set(["feature_name", "exit_code", "duration_ms"]),
  "cli.config_get": new Set(["key", "exit_code", "duration_ms"]),
  "cli.config_set": new Set([
    "key",
    "coerced_value",
    "exit_code",
    "duration_ms",
  ]),
  "cli.config_unset": new Set(["key", "exit_code", "duration_ms"]),
  "cli.upgrade_completed": new Set([
    "from_version",
    "install_method",
    "exit_code",
    "duration_ms",
  ]),
  "cli.upgrade_failed": new Set([
    "from_version",
    "install_method",
    "stage",
    "exit_code",
    "duration_ms",
  ]),
  "cli.sync_ran": new Set(["targets", "force", "exit_code", "duration_ms"]),
  "cli.install_rules_ran": new Set(["clients", "exit_code", "duration_ms"]),
  "cli.install_skill_ran": new Set(["scope", "exit_code", "duration_ms"]),
  "cli.identify_set": new Set(["via", "exit_code", "duration_ms"]),
  "cli.identify_cleared": new Set(["exit_code", "duration_ms"]),
  "cli.launcher_invoked": new Set([
    "launcher_id",
    "exit_code",
    "duration_ms",
  ]),
  "cli.help_shown": new Set(["exit_code", "duration_ms"]),
  "cli.unknown_command": new Set(["exit_code", "duration_ms"]),
};

export function installIdFilePath(): string {
  return join(homedir(), STATE_DIR_NAME, "install-id");
}

/** DO_NOT_TRACK env truthy → off. Anything else → on. */
export function isCliTelemetryEnabled(): boolean {
  const dnt = (process.env["DO_NOT_TRACK"] ?? "").trim().toLowerCase();
  if (TRUTHY.has(dnt)) return false;
  return true;
}

export async function loadOrCreateCliInstallId(): Promise<{ id: string; created: boolean }> {
  const path = installIdFilePath();
  try {
    const raw = (await fs.readFile(path, "utf8")).trim();
    if (UUID_RE.test(raw)) return { id: raw, created: false };
  } catch {
    /* fall through to create */
  }
  const id = randomUUID();
  try {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.writeFile(path, id + "\n", { mode: 0o600 });
    return { id, created: true };
  } catch {
    return { id, created: true };
  }
}

function redact(event: string, props: Record<string, unknown>): Record<string, unknown> {
  const allowed = ALLOWED[event];
  if (!allowed) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (allowed.has(k) || COMMON_PROPS.has(k)) out[k] = v;
  }
  return out;
}

interface QueuedEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

export class CliTelemetry {
  private queue: QueuedEvent[] = [];
  private distinctId = "";
  private enabled = false;
  private cliVersion: string;

  constructor(cliVersion: string) {
    this.cliVersion = cliVersion;
  }

  async init(): Promise<{ enabled: boolean; installCreated: boolean }> {
    try {
      this.enabled = isCliTelemetryEnabled();
      if (!this.enabled) return { enabled: false, installCreated: false };
      const r = await loadOrCreateCliInstallId();
      this.distinctId = r.id;
      return { enabled: true, installCreated: r.created };
    } catch {
      this.enabled = false;
      return { enabled: false, installCreated: false };
    }
  }

  capture(event: string, props: Record<string, unknown> = {}): void {
    if (!this.enabled || !this.distinctId) return;
    const allowed = ALLOWED[event];
    if (!allowed) return;
    const merged: Record<string, unknown> = {
      cli_version: this.cliVersion,
      os_platform: process.platform,
      os_arch: process.arch,
      node_major: Number(process.versions.node.split(".")[0] ?? 0),
      ...props,
    };
    this.queue.push({
      event,
      properties: redact(event, merged),
      timestamp: new Date().toISOString(),
    });
  }

  async flush(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
    if (!this.enabled || this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    const body = JSON.stringify({
      api_key: process.env["BROWSEROPS_POSTHOG_KEY"] || POSTHOG_KEY,
      batch: batch.map((e) => ({
        event: e.event,
        distinct_id: this.distinctId,
        properties: e.properties,
        timestamp: e.timestamp,
      })),
    });
    try {
      const host = (process.env["BROWSEROPS_POSTHOG_HOST"] || POSTHOG_HOST).replace(/\/+$/, "");
      await fetch(`${host}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      /* swallow */
    }
  }
}

let singleton: CliTelemetry | null = null;

export async function initCliTelemetry(cliVersion: string): Promise<{
  client: CliTelemetry;
  enabled: boolean;
  installCreated: boolean;
}> {
  const client = new CliTelemetry(cliVersion);
  const r = await client.init();
  singleton = client;
  return { client, ...r };
}

export function getCliTelemetry(): CliTelemetry | null {
  return singleton;
}

export function resetCliTelemetryForTest(): void {
  singleton = null;
}
