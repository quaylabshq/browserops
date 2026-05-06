/**
 * Telemetry opt-out resolution.
 *
 * Single signal: DO_NOT_TRACK env. Industry-standard convention,
 * silently honoured (not advertised in the CLI). On = telemetry off.
 * Anything else = telemetry on.
 */
export const DO_NOT_TRACK_ENV = "DO_NOT_TRACK";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
}

export function isTelemetryEnabled(opts: ResolveOptions = {}): boolean {
  const env = opts.env ?? process.env;
  const dnt = (env[DO_NOT_TRACK_ENV] ?? "").trim().toLowerCase();
  if (TRUTHY.has(dnt)) return false;
  return true;
}
