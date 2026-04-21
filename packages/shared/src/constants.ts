import { homedir } from "node:os";
import { join } from "node:path";

/**
 * WebSocket transport defaults. See plans/00-overview.md §5 and plans/02-bridge-protocol.md.
 */
export const DEFAULT_WS_HOST = "127.0.0.1";
export const DEFAULT_WS_PORT = 8765;

/**
 * Max WebSocket frame size. 16 MiB gives headroom for full-page 4K screenshots.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Per-tool default timeouts (ms). See plans/00-overview.md §4.5.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const NAVIGATE_TIMEOUT_MS = 45_000;
export const WAIT_FOR_TIMEOUT_CAP_MS = 120_000;

/**
 * Hello frame handshake. See plans/02-bridge-protocol.md.
 */
export const HELLO_TIMEOUT_MS = 5_000;

/**
 * Rate-limiter defaults. See plans/06-autonomy-safety.md.
 */
export const RATE_LIMIT_PER_TAB_PER_MIN = 16;
export const RATE_LIMIT_GLOBAL_PER_MIN_DEFAULT = 60;

/**
 * Risky-action confirmation UX timeout. Deny on no-response.
 */
export const RISKY_CONFIRM_TIMEOUT_MS = 30_000;

/**
 * Runtime state directory under the user's home.
 */
export function stateDir(): string {
  return join(homedir(), ".browserops");
}

export function tokenPath(): string {
  return join(stateDir(), "token");
}

export function logPath(): string {
  return join(stateDir(), "log.jsonl");
}

export function riskyDomainsPath(): string {
  return join(stateDir(), "risky-domains.json");
}

/**
 * Environment variable names read by the bridge.
 */
export const ENV = {
  PORT: "BROWSEROPS_PORT",
  HOST: "BROWSEROPS_HOST",
  EXTENSION_ID: "BROWSEROPS_EXTENSION_ID",
  GLOBAL_CAP: "BROWSEROPS_GLOBAL_CAP",
  LOG_LEVEL: "BROWSEROPS_LOG_LEVEL",
  AUTOCONFIRM: "BROWSEROPS_AUTOCONFIRM",
} as const;
