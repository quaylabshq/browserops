import {
  CloseCode,
  PROTOCOL_VERSION,
  isHelloAck,
  isRequest,
  isResponse,
  isEvent,
  type Hello,
  type Request,
  type Response,
  type Event as WsEvent,
} from "@browserops/shared";
import type { EventName, EventMap } from "@browserops/shared";

export interface WsClientOptions {
  url: string;
  token: string;
  extensionVersion: string;
  onRequest: (req: Request) => Promise<Response>;
  onConnectionChange: (connected: boolean) => void;
  /** Called when the socket closes without scheduling a reconnect (fatal or user-disconnect). */
  onFatalClose?: (code: number) => void;
}

// Fatal close codes from the bridge — do not auto-reconnect.
const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  CloseCode.BAD_TOKEN,
  CloseCode.PROTOCOL_MISMATCH,
  CloseCode.HELLO_TIMEOUT,
  CloseCode.MALFORMED_HELLO,
  CloseCode.SUPERSEDED,
]);
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15_000;

export class WsClient {
  private readonly opts: WsClientOptions;
  private ws: WebSocket | null = null;
  private stopped = false;
  private ackReceived = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(userDisconnect: boolean): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws === null) return;
    try {
      ws.close(userDisconnect ? CloseCode.USER_DISCONNECT : 1000, "client_stop");
    } catch {
      /* ignore */
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.ackReceived;
  }

  sendEvent<N extends EventName>(name: N, payload: EventMap[N]): void {
    const frame: WsEvent<EventMap[N]> = { type: "event", name, payload };
    this.sendRaw(frame);
  }

  private open(): void {
    if (this.stopped) return;
    this.ackReceived = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (err) {
      console.warn("[ws] ctor threw", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      const hello: Hello = {
        type: "hello",
        token: this.opts.token,
        extension_version: this.opts.extensionVersion,
        protocol_version: PROTOCOL_VERSION,
      };
      this.sendRaw(hello);
    };
    ws.onmessage = (ev: MessageEvent) => this.handle(ev.data);
    ws.onerror = (ev) => console.warn("[ws] error", ev);
    ws.onclose = (ev: CloseEvent) => {
      const wasConnected = this.ackReceived;
      this.ws = null;
      this.ackReceived = false;
      if (wasConnected) this.opts.onConnectionChange(false);
      if (this.stopped) return;
      if (FATAL_CLOSE_CODES.has(ev.code) || ev.code === CloseCode.USER_DISCONNECT) {
        console.warn("[ws] no-reconnect close", ev.code, ev.reason);
        this.opts.onFatalClose?.(ev.code);
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handle(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      console.warn("[ws] malformed JSON");
      return;
    }
    if (isHelloAck(parsed)) {
      if (this.ackReceived) {
        console.warn("[ws] duplicate hello_ack ignored");
        return;
      }
      this.ackReceived = true;
      this.reconnectAttempt = 0;
      this.opts.onConnectionChange(true);
      return;
    }
    if (isRequest(parsed)) {
      this.dispatch(parsed);
      return;
    }
    if (isResponse(parsed)) {
      console.warn("[ws] orphan Response ignored", parsed.id);
      return;
    }
    if (isEvent(parsed)) {
      console.warn("[ws] inbound Event ignored");
      return;
    }
    console.warn("[ws] unknown frame");
  }

  private dispatch(req: Request): void {
    this.opts
      .onRequest(req)
      .then((res) => this.sendRaw({ ...res, id: req.id } satisfies Response))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const errResp: Response = {
          type: "response",
          id: req.id,
          ok: false,
          error: { code: "INTERNAL", message },
        };
        this.sendRaw(errResp);
      });
  }

  private sendRaw(frame: unknown): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      console.warn("[ws] send failed", err);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.reconnectAttempt);
    const delay = Math.max(BACKOFF_MIN_MS, Math.floor(Math.random() * cap)); // full jitter
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 10);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }
}
