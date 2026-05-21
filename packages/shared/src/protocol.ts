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
 * (e.g. "procedures", "lore"). Extension stores them in
 * chrome.storage.local.features and uses them to decide whether to
 * register optional handlers and surface optional UI.
 */
export interface HelloAck {
  type: "hello_ack";
  bridge_version: string;
  protocol_version: number;
  features?: string[];
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

/**
 * Per-action page_effect envelope. Every state-changing browser_* handler
 * returns one of these alongside its result, so the agent can verify
 * structurally what happened during the action window without re-reading
 * the page. ~100 tokens when serialized.
 */
export interface MutationCounts {
  added: number;
  removed: number;
  attr: number;
  char: number;
}

export interface NetworkActivity {
  requests: number;
  failed: number;
  endpoints: string[];
}

export interface A11yDelta {
  added: number;
  removed: number;
  changed: number;
}

export interface NewDialog {
  role: string;
  name: string;
  ref: string;
}

export interface Effect {
  url_changed: boolean;
  title_changed: boolean;
  mutations: MutationCounts;
  network: NetworkActivity;
  visual_hash_delta: number;
  a11y_delta: A11yDelta;
  focus_moved_to: string | null;
  new_dialogs: NewDialog[];
  console_errors: number;
  duration_ms: number;
}

/**
 * Predicate the agent attaches to a state-changing action to assert what
 * should happen after dispatch. The handler polls the page until the
 * predicate matches or `timeout_ms` elapses, then returns
 * `expectation_met: boolean` alongside the usual effect envelope.
 *
 * Named `ActionExpectation` (not `ExpectedEffect`) because the procedure-
 * memory module already exports a differently-shaped `ExpectedEffect`.
 * Agent-facing tool descriptions still refer to the field as "expected".
 *
 * All fields are optional; matching is "all-of" — every present field
 * must hold for the predicate to be considered met.
 */
export interface ActionExpectation {
  url_matches?: string;
  new_dialog?: boolean | string;
  value_contains?: { ref: string; substring: string };
  mutations_at_least?: number;
  network_endpoint?: string;
  focus_to?: string;
  visual_delta_at_least?: number;
  title_matches?: string;
  timeout_ms?: number;
  poll_interval_ms?: number;
}

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
