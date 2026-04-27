import { CONTROL_SOCKET_FILENAME, type ErrorCode } from "@browserops/shared";

export const CONTROL_PROTOCOL_VERSION = 1;

export { CONTROL_SOCKET_FILENAME };

export interface ControlHello {
  type: "hello";
  protocol_version: number;
  bridge_version: string;
  connected: boolean;
}

export interface ControlCall {
  type: "call";
  id: string;
  method: string;
  params: Record<string, unknown>;
  timeout_ms: number;
}

export interface ControlCancel {
  type: "cancel";
  id: string;
}

export type ControlResult =
  | { type: "result"; id: string; ok: true; result: unknown }
  | { type: "result"; id: string; ok: false; error: { code: ErrorCode; message: string } };

export interface ControlEvent {
  type: "event";
  name: string;
  payload: Record<string, unknown>;
}

export interface ControlConn {
  type: "conn";
  connected: boolean;
}

export type ControlMessage =
  | ControlHello
  | ControlCall
  | ControlCancel
  | ControlResult
  | ControlEvent
  | ControlConn;

export function isCall(m: unknown): m is ControlCall {
  return isObj(m) && m["type"] === "call" && typeof m["id"] === "string";
}

export function isCancel(m: unknown): m is ControlCancel {
  return isObj(m) && m["type"] === "cancel" && typeof m["id"] === "string";
}

export function isResult(m: unknown): m is ControlResult {
  return isObj(m) && m["type"] === "result" && typeof m["id"] === "string";
}

export function isEventMsg(m: unknown): m is ControlEvent {
  return isObj(m) && m["type"] === "event" && typeof m["name"] === "string";
}

export function isConnMsg(m: unknown): m is ControlConn {
  return isObj(m) && m["type"] === "conn" && typeof m["connected"] === "boolean";
}

export function isHello(m: unknown): m is ControlHello {
  return isObj(m) && m["type"] === "hello" && typeof m["protocol_version"] === "number";
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
