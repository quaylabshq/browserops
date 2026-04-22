import { createConnection, type Socket } from "node:net";
import type { ErrorCode } from "@browserops/shared";
import {
  isCall,
  isConnMsg,
  isEventMsg,
  isHello,
  isResult,
  type ControlCall,
  type ControlCancel,
  type ControlHello,
} from "./control-protocol.js";
import type { Logger } from "./logger.js";

const MAX_LINE_BYTES = 16 * 1024 * 1024;

class CodedError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  method: string;
}

export interface ControlClientOptions {
  socketPath: string;
  logger: Logger;
  onEvent: (name: string, payload: Record<string, unknown>) => void;
  onConnChange?: (connected: boolean) => void;
  onDisconnect?: (err: Error) => void;
}

/**
 * Secondary-side client for the primary bridge's control socket.
 * Forwards callExtension requests and surfaces primary-side extension
 * events and connection-state updates.
 */
export class ControlClient {
  private readonly socketPath: string;
  private readonly logger: Logger;
  private readonly onEvent: (name: string, payload: Record<string, unknown>) => void;
  private readonly onConnChange?: (connected: boolean) => void;
  private readonly onDisconnect?: (err: Error) => void;

  private socket?: Socket;
  private buffer = "";
  private connected = false;
  private helloSeen = false;
  private bridgeVersion?: string;
  private readonly pending = new Map<string, Pending>();

  constructor(opts: ControlClientOptions) {
    this.socketPath = opts.socketPath;
    this.logger = opts.logger;
    this.onEvent = opts.onEvent;
    this.onConnChange = opts.onConnChange;
    this.onDisconnect = opts.onDisconnect;
  }

  async connect(): Promise<ControlHello> {
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.setEncoding("utf8");

    const hello = await new Promise<ControlHello>((resolve, reject) => {
      const onConnectErr = (err: Error): void => {
        reject(err);
      };
      socket.once("error", onConnectErr);

      socket.on("data", (chunk: string) => this.handleData(chunk, resolve));
      socket.on("close", () => this.handleClose());
      socket.on("error", (err) =>
        void this.logger.write({ dir: "system", event: "control_client_sock_err", error: String(err) }),
      );

      setTimeout(() => {
        if (!this.helloSeen) reject(new Error("control hello timeout"));
      }, 5000).unref();
    });

    this.bridgeVersion = hello.bridge_version;
    this.connected = hello.connected;
    return hello;
  }

  isConnected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed && this.connected;
  }

  bridgeVersionSeen(): string | undefined {
    return this.bridgeVersion;
  }

  call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        return reject(new CodedError("EXTENSION_DISCONNECTED", "control socket closed"));
      }
      if (signal?.aborted) return reject(makeAbortError());

      const id = globalThis.crypto.randomUUID();
      const call: ControlCall = { type: "call", id, method, params, timeout_ms: timeoutMs };

      const pending: Pending = {
        resolve: (v) => resolve(v as T),
        reject,
        method,
        signal,
      };

      if (signal) {
        const abortListener = (): void => {
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          const cancel: ControlCancel = { type: "cancel", id };
          try { this.socket?.write(JSON.stringify(cancel) + "\n"); } catch { /* ignore */ }
          signal.removeEventListener("abort", abortListener);
          p.reject(makeAbortError());
        };
        pending.abortListener = abortListener;
        signal.addEventListener("abort", abortListener, { once: true });
      }

      this.pending.set(id, pending);
      try {
        this.socket.write(JSON.stringify(call) + "\n");
      } catch (err) {
        this.pending.delete(id);
        if (signal && pending.abortListener) signal.removeEventListener("abort", pending.abortListener);
        reject(new CodedError("EXTENSION_DISCONNECTED", `control write failed: ${String(err)}`));
      }
    });
  }

  close(): void {
    if (this.socket && !this.socket.destroyed) {
      try { this.socket.end(); } catch { /* ignore */ }
    }
  }

  private handleData(chunk: string, resolveHello: (h: ControlHello) => void): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES) {
      void this.logger.write({ dir: "system", event: "control_client_oversize" });
      try { this.socket?.destroy(); } catch { /* ignore */ }
      return;
    }
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        void this.logger.write({ dir: "system", event: "control_client_bad_json" });
        continue;
      }
      if (!this.helloSeen) {
        if (isHello(msg)) {
          this.helloSeen = true;
          resolveHello(msg);
          continue;
        }
        void this.logger.write({ dir: "system", event: "control_client_pre_hello_msg" });
        continue;
      }
      this.route(msg);
    }
  }

  private route(msg: unknown): void {
    if (isResult(msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.signal && p.abortListener) p.signal.removeEventListener("abort", p.abortListener);
      if (msg.ok) {
        p.resolve(msg.result);
      } else {
        p.reject(new CodedError(msg.error.code, msg.error.message));
      }
      return;
    }
    if (isEventMsg(msg)) {
      try {
        this.onEvent(msg.name, msg.payload);
      } catch (err) {
        void this.logger.write({ dir: "system", event: "control_client_on_event_err", error: String(err) });
      }
      return;
    }
    if (isConnMsg(msg)) {
      this.connected = msg.connected;
      if (this.onConnChange) {
        try { this.onConnChange(msg.connected); } catch { /* ignore */ }
      }
      return;
    }
    if (isCall(msg)) {
      // server should not originate calls; ignore
      return;
    }
  }

  private handleClose(): void {
    const err = new CodedError("EXTENSION_DISCONNECTED", "control socket closed");
    for (const [id, p] of this.pending) {
      if (p.signal && p.abortListener) p.signal.removeEventListener("abort", p.abortListener);
      p.reject(err);
      this.pending.delete(id);
    }
    this.connected = false;
    if (this.onDisconnect) {
      try { this.onDisconnect(err); } catch { /* ignore */ }
    }
  }
}

function makeAbortError(): Error {
  const err = new Error("aborted");
  (err as { name: string }).name = "AbortError";
  (err as { code?: string }).code = "ABORT_ERR";
  return err;
}
