/**
 * Allowlist-based event sanitiser. Each event name maps to the exact set
 * of property keys that may leave the process. Any other key — even if a
 * caller passes it through — is silently dropped.
 *
 * Hardening:
 *   - tool_name must be a known TOOL_DEF_MAP key, else dropped.
 *   - error_code must satisfy isErrorCode(), else collapsed to "UNKNOWN".
 *
 * The allowlist is the security boundary. Adding a new tracked field
 * requires adding its key here AND to a redact.test.ts assertion.
 */
import { isErrorCode, TOOL_DEF_MAP } from "@browserops/shared";

const COMMON_PROPS: ReadonlySet<string> = new Set([
  "bridge_version",
  "cli_version",
  "os_platform",
  "os_arch",
  "node_major",
]);

const ALLOWED: Record<string, ReadonlySet<string>> = {
  daemon_started: new Set([
    "approval_mode",
    "enabled_features",
    "extension_connected",
  ]),
  daemon_shutdown: new Set([
    "reason",
    "uptime_ms",
    "total_sessions",
    "total_tool_calls",
  ]),
  session_created: new Set(["client_name", "client_version"]),
  session_destroyed: new Set([
    "client_name",
    "duration_ms",
    "tool_calls_count",
    "tool_errors_count",
  ]),
  tool_called: new Set([
    "tool_name",
    "ok",
    "error_code",
    "duration_ms",
    "client_name",
    "param_keys",
    "tab_hostname",
    "is_gated_domain",
    "is_risky_match",
    "feature_gate_hit",
    // procedures_execute extras
    "procedure_name",
    "procedure_steps_executed",
    // lore_* extras
    "lore_op",
    "lore_name",
    // browser_screenshot extras
    "screenshot_width_px",
    "screenshot_height_px",
    "screenshot_format",
  ]),
  cli_command_invoked: new Set(["command", "exit_code", "duration_ms"]),
  feature_changed: new Set(["feature_name", "enabled"]),
  init_completed: new Set([
    "clients_installed",
    "features_enabled",
    "interactive",
  ]),
  upgrade_completed: new Set(["from_version", "to_version", "ok"]),
  telemetry_changed: new Set(["enabled"]),
};

export type AllowedEvent = keyof typeof ALLOWED;

export function isAllowedEvent(name: string): name is AllowedEvent {
  return name in ALLOWED;
}

export function redact(
  event: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = ALLOWED[event];
  if (!allowed) return {};

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (allowed.has(k) || COMMON_PROPS.has(k)) out[k] = v;
  }

  if ("tool_name" in out) {
    const t = out["tool_name"];
    if (typeof t !== "string" || !(t in TOOL_DEF_MAP)) {
      delete out["tool_name"];
    }
  }
  if ("error_code" in out && !isErrorCode(out["error_code"])) {
    out["error_code"] = "UNKNOWN";
  }

  return out;
}
