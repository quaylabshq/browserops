/**
 * Canonical error codes for tool results and WebSocket Response envelopes.
 */
export const ERROR_CODES = [
  "TAB_NOT_FOUND",
  "REF_STALE",
  "REF_NOT_FOUND",
  "TEXT_NOT_FOUND",
  "WRITE_NOT_REFLECTED",
  "WRITE_AMPLIFIED",
  "OCCLUDED_CLICK",
  "NO_PINNED_TAB",
  "TIMEOUT",
  "NAVIGATION_IN_PROGRESS",
  "CDP_ATTACH_FAILED",
  "FRAME_UNREACHABLE",
  "RATE_LIMITED",
  "RISKY_ACTION_DENIED",
  "EXTENSION_DISCONNECTED",
  "INVALID_PARAMS",
  "INTERNAL",
  // Procedures errors (plan 06)
  "PROC_NOT_FOUND",
  "PROC_ALREADY_EXISTS",
  "PROC_SCHEMA_INVALID",
  "PROC_IN_USE",
  "PROC_OWNER_INVALID",
  "PROC_DOMAIN_INVALID",
  "CHAINED_ACTION_FAILED",
  "REPEATED_FAILURE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Canonical WebSocket close codes.
 */
export const CloseCode = {
  BAD_TOKEN: 4001,
  PROTOCOL_MISMATCH: 4002,
  HELLO_TIMEOUT: 4003,
  MALFORMED_HELLO: 4004,
  SUPERSEDED: 4005,
  USER_DISCONNECT: 4006,
  BACKPRESSURE_ABORT: 4008,
} as const;

export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];
