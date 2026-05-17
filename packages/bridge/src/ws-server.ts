import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomInt } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  DEFAULT_WS_HOST,
  DEFAULT_WS_PORT,
  HELLO_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  CloseCode,
  type ErrorCode,
  type HelloAck,
  type Request as WireRequest,
  type Response as WireResponse,
  isHello,
  isResponse,
  isEvent,
} from "@browserops/shared";
import type { Logger } from "./logger.js";
import type { ConfirmationChannel } from "./safety.js";

export interface WSBridgeOptions {
  host?: string;
  port?: number;
  allowedExtensionId?: string;
  token: string;
  bridgeVersion: string;
  logger: Logger;
  onEvent: (name: string, payload: Record<string, unknown>) => void;
  onConnectionChange?: (connected: boolean) => void;
  /**
   * Returns the bridge's currently-enabled feature names. Called at every
   * HelloAck so the extension always sees the live set after a CLI toggle
   * + daemon-reload, not the snapshot at WSBridge construction time.
   */
  getFeatures?: () => readonly string[];
}

interface Pending {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
  signal?: AbortSignal;
  abortListener?: () => void;
}

class CodedError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class WSBridge {
  private readonly host: string;
  private readonly port: number;
  private readonly allowedExtensionId: string;
  private readonly token: string;
  private readonly bridgeVersion: string;
  private readonly logger: Logger;
  private readonly onEvent: (name: string, payload: Record<string, unknown>) => void;
  private readonly onConnectionChange?: (connected: boolean) => void;
  private readonly getFeatures?: () => readonly string[];

  private http?: HttpServer;
  private wss?: WebSocketServer;
  private activeSocket?: WebSocket;
  private lastNotifiedConnected = false;
  private readonly pending = new Map<string, Pending>();

  private readonly pairCodeValue: string;
  private pairConsumed = false;

  readonly confirmation: ConfirmationChannel;

  constructor(opts: WSBridgeOptions) {
    this.host = opts.host ?? process.env["BROWSEROPS_HOST"] ?? DEFAULT_WS_HOST;
    const envPort = process.env["BROWSEROPS_PORT"];
    this.port = opts.port ?? (envPort ? Number(envPort) : DEFAULT_WS_PORT);
    this.allowedExtensionId =
      opts.allowedExtensionId ?? process.env["BROWSEROPS_EXTENSION_ID"] ?? "";
    this.token = opts.token;
    this.bridgeVersion = opts.bridgeVersion;
    this.logger = opts.logger;
    this.onEvent = opts.onEvent;
    this.onConnectionChange = opts.onConnectionChange;
    this.getFeatures = opts.getFeatures;

    // 6-digit pair code, formatted "XXX-XXX" for readability. Regenerated on
    // every bridge startup — if the first /pair response is lost, the user
    // restarts the bridge to mint a fresh code.
    const n = randomInt(0, 1_000_000).toString().padStart(6, "0");
    this.pairCodeValue = `${n.slice(0, 3)}-${n.slice(3)}`;

    this.confirmation = {
      awaitConfirmation: async (input) => {
        const res = await this.callExtension<{ decision_id?: unknown; allow?: unknown }>(
          "safety_prompt",
          { ...input },
          input.timeout_ms,
        );
        if (
          res &&
          typeof res === "object" &&
          res.decision_id === input.decision_id &&
          typeof res.allow === "boolean"
        ) {
          return { allow: res.allow };
        }
        throw new CodedError("INTERNAL", "safety_prompt returned malformed result");
      },
    };
  }

  isConnected(): boolean {
    return this.activeSocket !== undefined && this.activeSocket.readyState === WebSocket.OPEN;
  }

  get pairCode(): string {
    return this.pairCodeValue;
  }

  get pairCodeConsumed(): boolean {
    return this.pairConsumed;
  }

  async start(): Promise<void> {
    if (this.host !== "127.0.0.1" && this.host !== "localhost" && this.host !== "::1") {
      throw new Error(`refusing to bind non-loopback host: ${this.host}`);
    }
    this.http = createServer();
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });
    this.http.on("request", (req, res) => this.handleHttpRequest(req, res));
    this.http.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.wss.on("error", (err) =>
      void this.logger.write({ dir: "system", event: "wss_error", error: String(err) }),
    );

    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error): void => reject(err);
      this.http!.once("error", onErr);
      this.http!.listen(this.port, this.host, () => {
        this.http!.removeListener("error", onErr);
        void this.logger.write({
          dir: "system",
          event: "listening",
          host: this.host,
          port: this.port,
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.signal && p.abortListener) p.signal.removeEventListener("abort", p.abortListener);
      p.reject(new CodedError("EXTENSION_DISCONNECTED", "bridge stopping"));
    }
    this.pending.clear();
    if (this.activeSocket) {
      try { this.activeSocket.close(1000, "bridge_stop"); } catch { /* ignore */ }
      this.activeSocket = undefined;
      this.notifyConnChange();
    }
    if (this.wss) {
      await new Promise<void>((r) => this.wss!.close(() => r()));
      this.wss = undefined;
    }
    if (this.http) {
      await new Promise<void>((r) => this.http!.close(() => r()));
      this.http = undefined;
    }
    await this.logger.write({ dir: "system", event: "stopped" });
  }

  callExtension<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(makeAbortError());
      if (!this.isConnected() || !this.activeSocket) {
        return reject(new CodedError("EXTENSION_DISCONNECTED", "no active extension socket"));
      }

      const id = globalThis.crypto.randomUUID();
      const envelope: WireRequest = { type: "request", id, method, params, timeout_ms: timeoutMs };

      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (p.signal && p.abortListener) p.signal.removeEventListener("abort", p.abortListener);
        p.reject(new CodedError("TIMEOUT", `request ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();

      const pending: Pending = { resolve: (r) => resolve(r as T), reject, timer, method, signal };

      if (signal) {
        const abortListener = (): void => {
          const p = this.pending.get(id);
          if (!p) return;
          this.pending.delete(id);
          clearTimeout(p.timer);
          this.safeSend({
            type: "request",
            id: globalThis.crypto.randomUUID(),
            method: "cancel",
            params: { cancel_id: id },
            timeout_ms: 1000,
          });
          signal.removeEventListener("abort", abortListener);
          p.reject(makeAbortError());
        };
        pending.abortListener = abortListener;
        signal.addEventListener("abort", abortListener, { once: true });
      }

      this.pending.set(id, pending);
      void this.logger.write({ dir: "ws_out", id, method, summary: summarize(params) });

      if (!this.safeSend(envelope)) {
        this.pending.delete(id);
        clearTimeout(timer);
        if (signal && pending.abortListener)
          signal.removeEventListener("abort", pending.abortListener);
        reject(new CodedError("EXTENSION_DISCONNECTED", "send failed"));
      }
    });
  }

  private safeSend(msg: unknown): boolean {
    const ws = this.activeSocket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      void this.logger.write({ dir: "system", event: "send_error", error: String(err) });
      return false;
    }
  }

  /**
   * Handle plain HTTP requests on the bridge port. Currently serves only the
   * one-shot /pair endpoint used by the extension's onboarding page to
   * retrieve the token without copy-paste. Origin is restricted to
   * chrome-extension:// to keep random webpages from scraping the token.
   */
  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const urlPath = (req.url ?? "/").split("?", 1)[0] ?? "/";
    const origin = req.headers.origin ?? "";

    if (urlPath !== "/pair") {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain");
      res.end("not found");
      return;
    }

    // CORS preflight from the extension.
    if (req.method === "OPTIONS") {
      this.writeCorsHeaders(res, origin);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("allow", "GET, OPTIONS");
      res.end("method not allowed");
      return;
    }

    // Extensions with host_permissions may bypass CORS and omit Origin.
    // Allow empty origin: the server only binds 127.0.0.1, and without CORS
    // headers web pages still cannot read the response.
    if (origin !== "" && !this.isOriginAllowed(origin)) {
      void this.logger.write({ dir: "system", event: "pair_origin_rejected", origin });
      res.statusCode = 403;
      res.setHeader("content-type", "text/plain");
      res.end("origin not allowed");
      return;
    }

    if (this.pairConsumed) {
      if (origin) this.writeCorsHeaders(res, origin);
      res.statusCode = 410;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "already_paired" }));
      return;
    }

    this.pairConsumed = true;
    void this.logger.write({ dir: "system", event: "pair_issued", origin });
    if (origin) this.writeCorsHeaders(res, origin);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      code: this.pairCodeValue,
      token: this.token,
      bridge_version: this.bridgeVersion,
    }));
  }

  private writeCorsHeaders(res: ServerResponse, origin: string): void {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("vary", "origin");
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = req.headers.origin ?? "";
    // Allow empty origin — extensions with host_permissions may omit it.
    // Real auth happens via the token in the Hello frame.
    if (origin !== "" && !this.isOriginAllowed(origin)) {
      void this.logger.write({ dir: "system", event: "origin_rejected", origin });
      try { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); } catch { /* ignore */ }
      socket.destroy();
      return;
    }
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.wss!.emit("connection", ws, req));
  }

  private isOriginAllowed(origin: string): boolean {
    if (!origin.startsWith("chrome-extension://")) return false;
    if (this.allowedExtensionId === "") return true;
    return origin === `chrome-extension://${this.allowedExtensionId}`;
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    let state: "awaiting_hello" | "ready" | "closed" = "awaiting_hello";
    const helloTimer = setTimeout(() => {
      if (state === "awaiting_hello") {
        try { ws.close(CloseCode.HELLO_TIMEOUT, "hello_timeout"); } catch { /* ignore */ }
      }
    }, HELLO_TIMEOUT_MS);
    if (typeof helloTimer === "object" && "unref" in helloTimer) helloTimer.unref();

    void this.logger.write({ dir: "system", event: "ws_open", origin: req.headers.origin ?? "" });

    ws.on("message", (data) => {
      if (state === "closed") return;
      const msg = this.parseFrame(ws, data, state === "awaiting_hello");
      if (msg === undefined) return;

      if (state === "awaiting_hello") {
        if (!isHello(msg)) {
          this.closeWith(ws, CloseCode.MALFORMED_HELLO, "bad_hello");
          state = "closed";
          return;
        }
        if (msg.token !== this.token) {
          this.closeWith(ws, CloseCode.BAD_TOKEN, "bad_token");
          state = "closed";
          return;
        }
        if (!SUPPORTED_PROTOCOL_VERSIONS.includes(msg.protocol_version)) {
          this.closeWith(ws, CloseCode.PROTOCOL_MISMATCH, "protocol_mismatch");
          state = "closed";
          return;
        }
        clearTimeout(helloTimer);
        if (this.activeSocket && this.activeSocket !== ws) {
          try { this.activeSocket.close(CloseCode.SUPERSEDED, "superseded"); } catch { /* ignore */ }
        }
        this.activeSocket = ws;
        state = "ready";
        this.notifyConnChange();
        const ack: HelloAck = {
          type: "hello_ack",
          bridge_version: this.bridgeVersion,
          protocol_version: PROTOCOL_VERSION,
        };
        const features = this.getFeatures?.();
        if (features !== undefined) ack.features = [...features];
        try { ws.send(JSON.stringify(ack)); } catch (err) {
          void this.logger.write({ dir: "system", event: "ack_send_error", error: String(err) });
        }
        void this.logger.write({
          dir: "system",
          event: "ws_ready",
          extension_version: msg.extension_version,
          protocol_version: msg.protocol_version,
        });
        return;
      }

      if (isResponse(msg)) {
        this.routeResponse(msg);
        return;
      }
      if (isEvent(msg)) {
        const name = (msg as { name?: unknown }).name;
        const payload = (msg as { payload?: unknown }).payload;
        if (typeof name === "string" && payload && typeof payload === "object") {
          void this.logger.write({ dir: "ws_in", event_name: name, summary: summarize(payload) });
          try {
            this.onEvent(name, payload as Record<string, unknown>);
          } catch (err) {
            void this.logger.write({ dir: "system", event: "on_event_error", error: String(err) });
          }
        }
        return;
      }
      void this.logger.write({
        dir: "system",
        event: "unknown_frame_type",
        type: (msg as { type?: unknown }).type,
      });
    });

    ws.on("close", (code, reason) => {
      state = "closed";
      clearTimeout(helloTimer);
      const wasActive = this.activeSocket === ws;
      if (wasActive) this.activeSocket = undefined;
      void this.logger.write({
        dir: "system",
        event: "ws_close",
        code,
        reason: reason?.toString() ?? "",
        was_active: wasActive,
      });
      if (wasActive) {
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          if (p.signal && p.abortListener) p.signal.removeEventListener("abort", p.abortListener);
          p.reject(new CodedError("EXTENSION_DISCONNECTED", "socket closed"));
          this.pending.delete(id);
        }
        this.notifyConnChange();
      }
    });

    ws.on("error", (err) =>
      void this.logger.write({ dir: "system", event: "ws_error", error: String(err) }),
    );
  }

  private routeResponse(msg: WireResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) {
      void this.logger.write({ dir: "ws_in", id: msg.id, orphan: true });
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (p.signal && p.abortListener) p.signal.removeEventListener("abort", p.abortListener);
    if (msg.ok) {
      void this.logger.write({ dir: "ws_in", id: msg.id, method: p.method, ok: true });
      p.resolve(msg.result);
    } else {
      void this.logger.write({
        dir: "ws_in",
        id: msg.id,
        method: p.method,
        ok: false,
        code: msg.error.code,
      });
      p.reject(new CodedError(msg.error.code, msg.error.message));
    }
  }

  private parseFrame(ws: WebSocket, data: RawData, firstFrame: boolean): unknown {
    const buf = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
    if (buf.byteLength > MAX_FRAME_BYTES) {
      this.closeWith(ws, 1009, "frame_too_large");
      return undefined;
    }
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch {
      if (firstFrame) this.closeWith(ws, CloseCode.MALFORMED_HELLO, "bad_json");
      else void this.logger.write({ dir: "system", event: "bad_json" });
      return undefined;
    }
  }

  private closeWith(ws: WebSocket, code: number, reason: string): void {
    try { ws.close(code, reason); } catch { /* ignore */ }
    void this.logger.write({ dir: "system", event: "close", code, reason });
  }

  private notifyConnChange(): void {
    if (!this.onConnectionChange) return;
    const current = this.isConnected();
    if (current === this.lastNotifiedConnected) return;
    this.lastNotifiedConnected = current;
    try { this.onConnectionChange(current); } catch { /* ignore */ }
  }
}

function makeAbortError(): Error {
  const err = new Error("aborted");
  (err as { name: string }).name = "AbortError";
  (err as { code?: string }).code = "ABORT_ERR";
  return err;
}

function summarize(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 200) + `…(+${s.length - 200})` : s;
  } catch {
    return "<unserializable>";
  }
}
