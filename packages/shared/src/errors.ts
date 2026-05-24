/**
 * Canonical error codes for tool results and WebSocket Response envelopes.
 */
export const ERROR_CODES = [
  "TAB_NOT_FOUND",
  "TAB_CLAIMED_BY_OTHER",
  "REF_STALE",
  "REF_NOT_FOUND",
  "TEXT_NOT_FOUND",
  "WRITE_NOT_REFLECTED",
  "WRITE_AMPLIFIED",
  "OCCLUDED_CLICK",
  "TIMEOUT",
  "NAVIGATION_IN_PROGRESS",
  "CDP_ATTACH_FAILED",
  "FRAME_UNREACHABLE",
  "RATE_LIMITED",
  "RISKY_ACTION_DENIED",
  "EXTENSION_DISCONNECTED",
  "INVALID_PARAMS",
  "INVALID_STATE",
  "FEATURE_DISABLED",
  "TOOL_DISABLED",
  "INTERNAL",
  // Chained-action / step-execution errors
  "CHAINED_ACTION_FAILED",
  // Procedure errors (unified runtime)
  "PROCEDURE_NOT_FOUND",
  "PROCEDURE_ALREADY_EXISTS",
  "PROCEDURE_SCHEMA_INVALID",
  "PROCEDURE_IN_USE",
  "PROCEDURE_OWNER_INVALID",
  "PROCEDURE_RESUME_EXPIRED",
  "PROCEDURE_RESUME_INVALID",
  "PROCEDURE_BUDGET_EXCEEDED",
  "PROCEDURE_FORBIDDEN",
  "REPEATED_FAILURE",
  // Cross-agent memory store errors
  "MEMORY_NOT_FOUND",
  "MEMORY_ALREADY_EXISTS",
  "MEMORY_SCHEMA_INVALID",
  // Observation architecture (plan: observation-architecture)
  "OBSERVATION_TOKEN_INVALID",
  "COORDS_OUT_OF_SCREENSHOT_BOUNDS",
  // Locator resolver errors
  "LOCATOR_NOT_FOUND",
  "LOCATOR_AMBIGUOUS",
  "ELEMENT_NOT_ACTIONABLE",
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
