/**
 * Allowlist-based event sanitiser. Each event maps to an exact set of
 * property keys that may leave the process. Any other key is dropped.
 *
 * Naming: `<domain>.<event>` (one dot).
 *   - `cli.*`  CLI commands (one event per subcommand)
 *   - `mcp.*`  MCP tool dispatch — the suffix IS the tool name
 *   - `root.*` daemon lifecycle, MCP sessions, identity
 *
 * Hardening:
 *   - tool_name (when present) must be a known TOOL_DEF_MAP key, else dropped
 *   - error_code must satisfy isErrorCode(), else collapsed to "UNKNOWN"
 *
 * Adding a tracked field requires adding it here AND to redact.test.ts.
 */
import { isErrorCode, TOOL_DEF_MAP } from "@browserops/shared";

const COMMON_PROPS: ReadonlySet<string> = new Set([
  "bridge_version",
  "cli_version",
  "os_platform",
  "os_arch",
  "node_major",
]);

/**
 * Properties allowed on every `mcp.*` event regardless of which tool
 * fired. Per-tool extras live in MCP_PER_TOOL_EXTRAS below.
 */
const MCP_COMMON: ReadonlySet<string> = new Set([
  "tool_name",
  "ok",
  "error_code",
  "duration_ms",
  "client_name",
  "param_keys",
  "tab_hostname",
  "is_gated_domain",
  "feature_gate_hit",
]);

/**
 * Per-tool additional properties. Keys are the tool name (the suffix
 * after `mcp.`). When the dispatcher emits `mcp.${toolName}`, the
 * allowlist for that event = MCP_COMMON ∪ MCP_PER_TOOL_EXTRAS[toolName].
 */
const MCP_PER_TOOL_EXTRAS: Record<string, ReadonlySet<string>> = {
  browser_screenshot: new Set([
    "screenshot_width_px",
    "screenshot_height_px",
    "screenshot_format",
  ]),
  browser_navigate: new Set(["is_external_url"]),
  procedures_execute: new Set(["procedure_name", "procedure_steps_executed"]),
  lore_save: new Set(["lore_name"]),
  lore_get: new Set(["lore_name"]),
  lore_delete: new Set(["lore_name"]),
};

const ALLOWED: Record<string, ReadonlySet<string>> = {
  // ---------------------------------------------------------------- root.*
  "root.first_install": new Set([]),
  "root.daemon_started": new Set([
    "approval_mode",
    "enabled_features",
    "extension_connected",
  ]),
  "root.daemon_shutdown": new Set([
    "reason",
    "uptime_ms",
    "total_sessions",
    "total_tool_calls",
  ]),
  "root.daemon_extension_connected": new Set(["extension_version"]),
  "root.daemon_extension_disconnected": new Set([
    "close_code",
    "was_connected_for_ms",
  ]),
  "root.daemon_upgraded": new Set(["from_version", "to_version"]),
  "root.session_started": new Set(["client_name", "client_version"]),
  "root.session_ended": new Set([
    "client_name",
    "duration_ms",
    "tool_calls_count",
    "tool_errors_count",
  ]),
  "root.user_identified": new Set(["via"]),
  "root.user_identity_cleared": new Set([]),

  // ---------------------------------------------------------------- cli.*
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

export type AllowedEvent = keyof typeof ALLOWED;

export function isAllowedEvent(name: string): boolean {
  if (name in ALLOWED) return true;
  if (name.startsWith("mcp.")) {
    return name.slice("mcp.".length) in TOOL_DEF_MAP;
  }
  return false;
}

function allowedKeysFor(event: string): ReadonlySet<string> | undefined {
  if (event in ALLOWED) return ALLOWED[event];
  if (event.startsWith("mcp.")) {
    const toolName = event.slice("mcp.".length);
    if (!(toolName in TOOL_DEF_MAP)) return undefined;
    const extras = MCP_PER_TOOL_EXTRAS[toolName];
    if (!extras) return MCP_COMMON;
    return new Set([...MCP_COMMON, ...extras]);
  }
  return undefined;
}

export function redact(
  event: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = allowedKeysFor(event);
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
