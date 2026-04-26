/**
 * WebSocket transport defaults.
 */
export const DEFAULT_WS_HOST = "127.0.0.1";
export const DEFAULT_WS_PORT = 8765;

/**
 * Max WebSocket frame size. 16 MiB gives headroom for full-page 4K screenshots.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Per-tool default timeouts (ms).
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const NAVIGATE_TIMEOUT_MS = 45_000;
export const WAIT_FOR_TIMEOUT_CAP_MS = 120_000;

/**
 * Hello frame handshake.
 */
export const HELLO_TIMEOUT_MS = 5_000;

/**
 * Rate-limiter defaults.
 */
export const RATE_LIMIT_PER_TAB_PER_MIN = 16;
export const RATE_LIMIT_GLOBAL_PER_MIN_DEFAULT = 60;

/**
 * Risky-action confirmation UX timeout. Deny on no-response.
 */
export const RISKY_CONFIRM_TIMEOUT_MS = 30_000;

/**
 * Relative paths under the state directory. The bridge resolves these
 * against ~/.browserops/ at runtime; the extension does not import any of them.
 */
export const STATE_DIR_NAME = ".browserops";
export const TOKEN_FILENAME = "token";
export const LOG_FILENAME = "log.jsonl";
export const RISKY_DOMAINS_FILENAME = "risky-domains.json";

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
  /** Set to "auto" (default) or "gate" to control risky-action approval mode. */
  APPROVAL: "BROWSEROPS_APPROVAL",
  /** Set to "1" to enable trace recording. Set to a dir path to also override the traces dir. */
  TRACE: "BROWSEROPS_TRACE",
  /** Override the directory where trace .jsonl files are written. */
  TRACE_DIR: "BROWSEROPS_TRACE_DIR",
} as const;
