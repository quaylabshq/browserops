import { isErrorCode, type ErrorCode, type Request, type Response } from "@browserops/shared";
import type { EventName, EventMap } from "@browserops/shared";
import type { RefCache } from "./ref-cache.js";

export type Handler = (params: Record<string, unknown>, ctx: Context) => Promise<unknown>;

export interface Context {
  emitEvent: <N extends EventName>(name: N, payload: EventMap[N]) => void;
  refCache: RefCache;
  // TODO: inject debugger-session manager in a later PR.
}

export class Router {
  private readonly handlers = new Map<string, Handler>();

  register(method: string, handler: Handler): void {
    if (this.handlers.has(method)) {
      console.warn(`[router] overwriting existing handler for ${method}`);
    }
    this.handlers.set(method, handler);
  }

  async dispatch(req: Request, ctx: Context): Promise<Response> {
    const handler = this.handlers.get(req.method);
    if (handler === undefined) {
      return {
        type: "response",
        id: req.id,
        ok: false,
        error: { code: "INTERNAL", message: `no handler for method: ${req.method}` },
      };
    }
    try {
      const result = await handler(req.params, ctx);
      return { type: "response", id: req.id, ok: true, result };
    } catch (err: unknown) {
      const { code, message, details } = extractError(err);
      return {
        type: "response",
        id: req.id,
        ok: false,
        error: details === undefined ? { code, message } : { code, message, details },
      };
    }
  }
}

function extractError(err: unknown): { code: ErrorCode; message: string; details?: unknown } {
  if (err instanceof Error) {
    const maybeCode = (err as { code?: unknown }).code;
    const code: ErrorCode = isErrorCode(maybeCode) ? maybeCode : "INTERNAL";
    const details = (err as { details?: unknown }).details;
    return { code, message: err.message, details };
  }
  return { code: "INTERNAL", message: typeof err === "string" ? err : "unknown error" };
}
