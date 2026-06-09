/**
 * Telemetry opt-out resolution.
 *
 * Two signals, both honoured (either disables telemetry):
 *   - `DO_NOT_TRACK`  — industry-standard convention; on = telemetry off.
 *   - `BROWSEROPS_TELEMETRY=0` — browserops-specific explicit disable.
 *
 * Both are advertised in the README's Telemetry section.
 */
export const DO_NOT_TRACK_ENV = "DO_NOT_TRACK";
export const BROWSEROPS_TELEMETRY_ENV = "BROWSEROPS_TELEMETRY";

/** Explicit consent flag for shipping the user's email to PostHog as an alias. */
export const BROWSEROPS_ALIAS_EMAIL_ENV = "BROWSEROPS_ALIAS_EMAIL";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
}

export function isTelemetryEnabled(opts: ResolveOptions = {}): boolean {
  const env = opts.env ?? process.env;
  const dnt = (env[DO_NOT_TRACK_ENV] ?? "").trim().toLowerCase();
  if (TRUTHY.has(dnt)) return false;
  const bo = (env[BROWSEROPS_TELEMETRY_ENV] ?? "").trim().toLowerCase();
  if (FALSY.has(bo)) return false;
  return true;
}

/**
 * The user's email is never sent to PostHog unless they explicitly opt in via
 * `BROWSEROPS_ALIAS_EMAIL=1`. Default is opt-out — distinct-id aliasing across
 * machines requires consent because it links the install-id to a real identity.
 */
export function isEmailAliasEnabled(opts: ResolveOptions = {}): boolean {
  const env = opts.env ?? process.env;
  const flag = (env[BROWSEROPS_ALIAS_EMAIL_ENV] ?? "").trim().toLowerCase();
  return TRUTHY.has(flag);
}
