import type { ErrorCode } from "@browserops/shared";

/**
 * Optional structured hints attached to thrown errors. The bridge surfaces
 * `next_action` and `diagnostic` in the MCP error envelope when present.
 */
export interface ErrorHints {
  next_action?: string;
  diagnostic?: Record<string, unknown>;
}

/**
 * Throwable error with a `code` discriminator + optional hints. Every
 * extension handler funnels failures through this so the bridge can map
 * to the same wire envelope shape.
 */
export type CodedError = Error & {
  code: ErrorCode;
  next_action?: string;
  diagnostic?: Record<string, unknown>;
};

export function codedError(code: ErrorCode, message: string, hints?: ErrorHints): CodedError {
  const err = new Error(message) as CodedError;
  err.code = code;
  if (hints?.next_action !== undefined) err.next_action = hints.next_action;
  if (hints?.diagnostic !== undefined) err.diagnostic = hints.diagnostic;
  return err;
}
