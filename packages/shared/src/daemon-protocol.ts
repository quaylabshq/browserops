/**
 * Shim ↔ daemon Unix-socket protocol.
 *
 * The shim binary is a thin per-MCP-client process: it forwards stdio
 * MCP frames to the long-lived daemon, which owns the WebSocket to the
 * extension and fans out across concurrent sessions. NDJSON over a
 * Unix domain socket — one JSON envelope per line.
 *
 * Lifecycle:
 *   1. Shim opens socket, sends `register` with its MCP clientInfo (or
 *      blank if not yet known — daemon will pick it up from the
 *      `initialize` request inside the MCP stream).
 *   2. Daemon replies with `register_ack` carrying the assigned
 *      session_id, color, and display name.
 *   3. Shim forwards each line of stdin as `mcp_in.data` and writes
 *      every `mcp_out.data` it receives to stdout.
 *   4. Either side may send `bye` for a graceful close. Socket close
 *      with no `bye` ends the session immediately (used when the MCP
 *      client crashes).
 */

export const DAEMON_PROTOCOL_VERSION = 1;

export interface DaemonClientInfo {
  name: string;
  version: string;
}

export interface ShimRegister {
  type: "register";
  protocol_version: number;
  client_info?: DaemonClientInfo;
}

export interface DaemonRegisterAck {
  type: "register_ack";
  protocol_version: number;
  daemon_version: string;
  session_id: string;
  session_name: string;
  session_color: string;
}

export interface DaemonRegisterNak {
  type: "register_nak";
  reason: "protocol_mismatch" | "shutting_down" | "internal";
  message: string;
}

export interface ShimMcpIn {
  type: "mcp_in";
  data: string;
}

export interface DaemonMcpOut {
  type: "mcp_out";
  data: string;
}

export interface ShimBye {
  type: "bye";
  reason?: string;
}

export interface DaemonBye {
  type: "bye";
  reason?: string;
}

export type ShimToDaemon = ShimRegister | ShimMcpIn | ShimBye;
export type DaemonToShim = DaemonRegisterAck | DaemonRegisterNak | DaemonMcpOut | DaemonBye;
export type DaemonEnvelope = ShimToDaemon | DaemonToShim;

export function isShimRegister(m: unknown): m is ShimRegister {
  return isObj(m) && m["type"] === "register" && typeof m["protocol_version"] === "number";
}

export function isShimMcpIn(m: unknown): m is ShimMcpIn {
  return isObj(m) && m["type"] === "mcp_in" && typeof m["data"] === "string";
}

export function isShimBye(m: unknown): m is ShimBye {
  return isObj(m) && m["type"] === "bye";
}

export function isDaemonRegisterAck(m: unknown): m is DaemonRegisterAck {
  return isObj(m) && m["type"] === "register_ack" && typeof m["session_id"] === "string";
}

export function isDaemonRegisterNak(m: unknown): m is DaemonRegisterNak {
  return isObj(m) && m["type"] === "register_nak" && typeof m["reason"] === "string";
}

export function isDaemonMcpOut(m: unknown): m is DaemonMcpOut {
  return isObj(m) && m["type"] === "mcp_out" && typeof m["data"] === "string";
}

export function isDaemonBye(m: unknown): m is DaemonBye {
  return isObj(m) && m["type"] === "bye";
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
