/**
 * Engine-layer errors carry a stable `code` so the HTTP surface can map them to
 * a status without string-matching messages.
 */
export type EngineErrorCode =
  | "unknown_session"
  | "agent_unavailable"
  | "session_ejected"
  | "claude_not_found"
  /** The terminal transport was required but node-pty could not be loaded/spawned. */
  | "pty_unavailable";

export class EngineError extends Error {
  constructor(public readonly code: EngineErrorCode) {
    super(code);
    this.name = "EngineError";
  }
}

export function engineErrorCode(err: unknown): EngineErrorCode | undefined {
  return err instanceof EngineError ? err.code : undefined;
}
