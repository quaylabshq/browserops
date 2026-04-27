import type { ErrorCode } from "./errors.js";

/**
 * Current WebSocket protocol version. Bump on breaking envelope changes.
 */
export const PROTOCOL_VERSION = 1;

export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [1];

/**
 * First frame from extension after socket opens.
 */
export interface Hello {
  type: "hello";
  token: string;
  extension_version: string;
  protocol_version: number;
}

/**
 * Bridge reply to Hello.
 *
 * `features` carries the bridge's currently-enabled gated feature names
 * (e.g. "teach", "procedures"). Extension stores them in
 * chrome.storage.local.features and uses them to decide whether to
 * register optional handlers and surface optional UI.
 * `gated_domains` carries the resolved domain glob list when the
 * "gated-domains" feature is enabled, so the extension can pre-attach CDP.
 */
export interface HelloAck {
  type: "hello_ack";
  bridge_version: string;
  protocol_version: number;
  features?: string[];
  gated_domains?: string[];
}

/**
 * Bridge → Extension request envelope.
 */
export interface Request<TParams = Record<string, unknown>> {
  type: "request";
  id: string;
  method: string;
  params: TParams;
  timeout_ms: number;
}

export interface ResponseOk<TResult = unknown> {
  type: "response";
  id: string;
  ok: true;
  result: TResult;
  meta?: ResponseMeta;
}

export interface ResponseErr {
  type: "response";
  id: string;
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    next_action?: string;
    diagnostic?: Record<string, unknown>;
  };
  meta?: ResponseMeta;
}

export type Response<TResult = unknown> = ResponseOk<TResult> | ResponseErr;

export interface ResponseMeta {
  dropped_events?: number;
}

/**
 * Extension → Bridge unsolicited notifications. See events.ts for named payloads.
 */
export interface Event<TPayload = Record<string, unknown>> {
  type: "event";
  name: string;
  payload: TPayload;
}

export type Envelope = Hello | HelloAck | Request | Response | Event;

export function isHello(e: unknown): e is Hello {
  return isObj(e) && e.type === "hello";
}

export function isHelloAck(e: unknown): e is HelloAck {
  return isObj(e) && e.type === "hello_ack";
}

export function isRequest(e: unknown): e is Request {
  return isObj(e) && e.type === "request";
}

export function isResponse(e: unknown): e is Response {
  return isObj(e) && e.type === "response";
}

export function isEvent(e: unknown): e is Event {
  return isObj(e) && e.type === "event";
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
