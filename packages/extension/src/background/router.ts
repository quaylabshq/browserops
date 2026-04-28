import { isErrorCode, type ErrorCode, type FeatureName, type Request, type Response } from "@browserops/shared";
import type { EventName, EventMap } from "@browserops/shared";
import type { RefCache } from "./ref-cache.js";

export type Handler = (params: Record<string, unknown>, ctx: Context) => Promise<unknown>;

export interface Context {
  emitEvent: <N extends EventName>(name: N, payload: EventMap[N]) => void;
  refCache: RefCache;
  // TODO: inject debugger-session manager in a later PR.
}

export interface RegisterOptions {
  /**
   * Optional feature gate. When set, the handler is rejected at dispatch
   * time with FEATURE_DISABLED if the feature is absent from the live
   * features set (sourced from chrome.storage.local.features, populated
   * by the bridge's HelloAck on every connect).
   */
  feature?: FeatureName;
}

export class Router {
  private readonly handlers = new Map<string, Handler>();
  private readonly featureByMethod = new Map<string, FeatureName>();
  /** Live feature set provider; defaults to allow-all (treats all gates as on). */
  private getFeatures: () => ReadonlySet<FeatureName> = () =>
    new Set<FeatureName>(["procedures"]);

  register(method: string, handler: Handler, opts?: RegisterOptions): void {
    if (this.handlers.has(method)) {
      console.warn(`[router] overwriting existing handler for ${method}`);
    }
    this.handlers.set(method, handler);
    if (opts?.feature !== undefined) this.featureByMethod.set(method, opts.feature);
    else this.featureByMethod.delete(method);
  }

  /**
   * Set the source for the live feature set. The dispatch gate calls this
   * on every request, so the SW can keep the source in sync with
   * chrome.storage.local.features without re-registering handlers.
   */
  setFeatureSource(getFeatures: () => ReadonlySet<FeatureName>): void {
    this.getFeatures = getFeatures;
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
    const required = this.featureByMethod.get(req.method);
    if (required !== undefined && !this.getFeatures().has(required)) {
      return {
        type: "response",
        id: req.id,
        ok: false,
        error: {
          code: "FEATURE_DISABLED",
          message: `method "${req.method}" requires feature "${required}", which is currently off`,
          details: { feature: required },
        },
      };
    }
    try {
      const result = await handler(req.params, ctx);
      return { type: "response", id: req.id, ok: true, result };
    } catch (err: unknown) {
      const { code, message, details, next_action, diagnostic } = extractError(err);
      const error: {
        code: ErrorCode;
        message: string;
        details?: unknown;
        next_action?: string;
        diagnostic?: Record<string, unknown>;
      } = { code, message };
      if (details !== undefined) error.details = details;
      if (next_action !== undefined) error.next_action = next_action;
      if (diagnostic !== undefined) error.diagnostic = diagnostic;
      return {
        type: "response",
        id: req.id,
        ok: false,
        error,
      };
    }
  }
}

function extractError(err: unknown): {
  code: ErrorCode;
  message: string;
  details?: unknown;
  next_action?: string;
  diagnostic?: Record<string, unknown>;
} {
  if (err instanceof Error) {
    const maybeCode = (err as { code?: unknown }).code;
    const code: ErrorCode = isErrorCode(maybeCode) ? maybeCode : "INTERNAL";
    const details = (err as { details?: unknown }).details;
    const nextActionRaw = (err as { next_action?: unknown }).next_action;
    const next_action = typeof nextActionRaw === "string" ? nextActionRaw : undefined;
    const diagnosticRaw = (err as { diagnostic?: unknown }).diagnostic;
    const diagnostic =
      diagnosticRaw !== null && typeof diagnosticRaw === "object" && !Array.isArray(diagnosticRaw)
        ? (diagnosticRaw as Record<string, unknown>)
        : undefined;
    return { code, message: err.message, details, next_action, diagnostic };
  }
  return { code: "INTERNAL", message: typeof err === "string" ? err : "unknown error" };
}
