import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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
  type ChatEvent,
  type ChatMessage,
  type SessionRef,
  type TerminalMode,
  isHello,
  isResponse,
  isEvent,
  isTerminalMode,
} from "@browserops/shared";
import type { Logger } from "./logger.js";
import type { ConfirmationChannel } from "./safety.js";
import { engineErrorCode } from "./engine/errors.js";
import type { TerminalHandle } from "./engine/driver.js";

/** Launch request forwarded from the side-panel launcher to the handler. */
export interface LaunchRequestParams {
  /** Agent id (e.g. "claude"); validated against the registry downstream. */
  agent?: string;
  /** Optional first instruction the user typed in the composer. */
  instruction?: string;
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
}

export type LaunchOutcome = { ok: true } | { ok: false; error: string };

/** A new-session request from the side-panel chat client. */
export interface ChatStartParams {
  agent: string;
  instruction?: string;
  page: { url: string; title?: string; description?: string; siteName?: string };
}

export interface ChatSessionSummary extends SessionRef {
  lastActive: number;
}

export type ChatTerminalOutcome = { ok: true } | { ok: false; error: string };

/**
 * The in-panel chat surface the bridge exposes over /chat/*. Implemented by
 * daemon-runtime over the ChatEngine + the terminal launcher, but kept as an
 * interface so ws-server stays decoupled from the engine (and is testable with
 * a fake). Gated by token + origin-pin exactly like /launch.
 */
export interface ChatService {
  start(params: ChatStartParams): Promise<SessionRef>;
  send(sessionId: string, text: string): Promise<void>;
  /** Attach a live listener; the implementation replays buffered events first. */
  subscribe(sessionId: string, listener: (event: ChatEvent) => void): Promise<() => void>;
  history(sessionId: string): Promise<ChatMessage[]>;
  listSessions(): Promise<ChatSessionSummary[]>;
  /** Open a read-only terminal mirror, or eject the session into a terminal. */
  terminal(sessionId: string, mode: TerminalMode): Promise<ChatTerminalOutcome>;
  /** Bind a live raw-terminal handle for the embedded xterm pane (via /chat/pty). */
  attachTerminal(sessionId: string): TerminalHandle;
}

export interface WSBridgeOptions {
  host?: string;
  port?: number;
  allowedExtensionId?: string;
  token: string;
  bridgeVersion: string;
  logger: Logger;
  onEvent: (name: string, payload: Record<string, unknown>) => void;
  /**
   * Handle a POST /launch from the (pinned, token-authed) extension popup:
   * open a new terminal running an interactive `claude`, optionally seeded
   * with the active tab's metadata. The returned outcome is serialised back
   * to the popup. Absent → /launch responds 503 launch_unavailable.
   */
  onLaunch?: (params: LaunchRequestParams) => Promise<LaunchOutcome>;
  /**
   * The in-panel chat surface (POST /chat/new|send|terminal, GET
   * /chat/sessions|history, SSE /chat/stream). Token + origin-pinned exactly
   * like /launch. Absent → /chat/* responds 503 chat_unavailable.
   */
  chat?: ChatService;
  onConnectionChange?: (connected: boolean) => void;
  /**
   * Returns the bridge's currently-enabled feature names. Called at every
   * HelloAck so the extension always sees the live set after a CLI toggle
   * + daemon-reload, not the snapshot at WSBridge construction time.
   */
  getFeatures?: () => readonly string[];
  /**
   * Extension ID this bridge has previously paired with, loaded from
   * `~/.browserops/extension_id` at boot. When non-null:
   *   - `/pair` is refused for any Origin whose extension ID differs
   *   - the WS upgrade is refused for any Origin whose extension ID differs
   * `browserops init --repair` deletes the on-disk file to allow re-pair.
   */
  pinnedExtensionId?: string | null;
  /**
   * Called once when an unpinned bridge sees its first successful hello.
   * The caller (daemon-runtime) persists the ID to disk so subsequent
   * runs can reload it via `pinnedExtensionId`. Errors are logged but
   * not fatal — the live socket is already authenticated by token.
   */
  onExtensionPin?: (extensionId: string) => Promise<void>;
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

/** Coerce a value to a string and defensively cap its length, else undefined. */
function capField(v: unknown, max = 2000): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

export class WSBridge {
  private readonly host: string;
  private readonly port: number;
  private readonly allowedExtensionId: string;
  private readonly token: string;
  private readonly bridgeVersion: string;
  private readonly logger: Logger;
  private readonly onEvent: (name: string, payload: Record<string, unknown>) => void;
  private readonly onLaunch?: (params: LaunchRequestParams) => Promise<LaunchOutcome>;
  private readonly chat?: ChatService;
  /** Open SSE responses, ended on stop() so the http server can close. */
  private readonly openStreams = new Set<ServerResponse>();
  /** Open /chat/pty terminal sockets, closed on stop(). */
  private readonly openPtySockets = new Set<WebSocket>();
  private readonly onConnectionChange?: (connected: boolean) => void;
  private readonly getFeatures?: () => readonly string[];
  private readonly onExtensionPin?: (extensionId: string) => Promise<void>;

  private http?: HttpServer;
  private wss?: WebSocketServer;
  private activeSocket?: WebSocket;
  private lastNotifiedConnected = false;
  private readonly pending = new Map<string, Pending>();

  private readonly pairCodeValue: string;
  private pairConsumed = false;
  private pinnedExtensionId: string | null;

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
    this.onLaunch = opts.onLaunch;
    this.chat = opts.chat;
    this.onConnectionChange = opts.onConnectionChange;
    this.getFeatures = opts.getFeatures;
    this.onExtensionPin = opts.onExtensionPin;
    this.pinnedExtensionId = opts.pinnedExtensionId ?? null;

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

  get pinnedExtension(): string | null {
    return this.pinnedExtensionId;
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
    this.wss.on(
      "error",
      (err) => void this.logger.write({ dir: "system", event: "wss_error", error: String(err) }),
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
    // End any open SSE streams so http.close() can actually complete.
    for (const res of this.openStreams) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.openStreams.clear();
    for (const ws of this.openPtySockets) {
      try {
        ws.close(1000, "bridge_stop");
      } catch {
        /* ignore */
      }
    }
    this.openPtySockets.clear();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.signal && p.abortListener) p.signal.removeEventListener("abort", p.abortListener);
      p.reject(new CodedError("EXTENSION_DISCONNECTED", "bridge stopping"));
    }
    this.pending.clear();
    if (this.activeSocket) {
      try {
        this.activeSocket.close(1000, "bridge_stop");
      } catch {
        /* ignore */
      }
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

    // /pair and /status are one-shot / live-state endpoints — their responses
    // must NEVER be cached by the browser. 410 "already_paired" is cacheable
    // by default (RFC 7231 §6.1, like 200/301/404), so without this a stale
    // 410 is replayed from the HTTP cache and survives a bridge restart,
    // reinstall, and fresh tabs — making re-pairing impossible until the cache
    // is manually cleared. Set on every response from this handler.
    res.setHeader("cache-control", "no-store");

    if (urlPath === "/launch") {
      // POST /launch needs to await onLaunch, so hand off to an async method.
      void this.handleLaunch(req, res, origin);
      return;
    }

    if (urlPath === "/status") {
      // Loopback-only status snapshot, used by `browserops init` to
      // detect when the user has installed the extension and paired.
      // Intentionally permissive on Origin (browser dev tools, the
      // welcome page, the CLI all curl this) — the body carries no
      // secret, only state flags + the pinned extension ID.
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      if (origin) this.writeCorsHeaders(res, origin);
      res.end(
        JSON.stringify({
          pair_consumed: this.pairConsumed,
          extension_connected: this.isConnected(),
          extension_id: this.pinnedExtensionId,
          bridge_version: this.bridgeVersion,
        }),
      );
      return;
    }

    if (urlPath === "/chat/new" || urlPath === "/chat/send" || urlPath === "/chat/terminal") {
      void this.handleChatPost(req, res, origin, urlPath);
      return;
    }
    if (urlPath === "/chat/sessions" || urlPath === "/chat/history") {
      void this.handleChatGet(req, res, origin, urlPath);
      return;
    }
    if (urlPath === "/chat/stream") {
      void this.handleChatStream(req, res, origin);
      return;
    }

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

    // First-pair-wins: once an extension ID has been pinned, only that
    // origin can pair. Refuse other extension origins even if they share
    // the same Chrome profile — defeats race attacks where a rogue
    // extension watches for bridge starts and tries to claim the token.
    if (!this.originMatchesPin(origin)) {
      void this.logger.write({
        dir: "system",
        event: "pair_pin_rejected",
        origin,
        pinned: this.pinnedExtensionId,
      });
      if (origin) this.writeCorsHeaders(res, origin);
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "extension_pinned" }));
      return;
    }

    // One-shot guard, with a deliberate exception for re-pairing. We refuse a
    // second /pair only when we can't positively identify the caller as the
    // already-pinned extension. When the pinned extension itself re-pairs —
    // after a reinstall, cleared storage, or a reopened onboarding tab — it's
    // the same trusted origin reclaiming the token it already held, so hand it
    // back without forcing a bridge restart. The token is identical either way
    // (it lives in ~/.browserops/token), so this grants nothing new.
    const isRepair = this.isPinnedOrigin(origin);
    if (this.pairConsumed && !isRepair) {
      if (origin) this.writeCorsHeaders(res, origin);
      res.statusCode = 410;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "already_paired" }));
      return;
    }

    this.pairConsumed = true;
    void this.logger.write({
      dir: "system",
      event: isRepair ? "pair_reissued" : "pair_issued",
      origin,
    });
    if (origin) this.writeCorsHeaders(res, origin);
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        code: this.pairCodeValue,
        token: this.token,
        bridge_version: this.bridgeVersion,
      }),
    );
  }

  private writeCorsHeaders(res: ServerResponse, origin: string): void {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("vary", "origin");
  }

  private writeLaunchCors(res: ServerResponse, origin: string): void {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("vary", "origin");
  }

  /**
   * POST /launch — token-authed, origin-pinned request from the extension
   * popup to open a new terminal running Claude. Two independent gates: the
   * Origin must match the pinned extension (a web page's real Origin won't),
   * AND the body must carry the loopback token (which only the pinned
   * extension ever receives via /pair). A page can emit the POST but holds
   * neither, so it is rejected before any terminal opens.
   */
  private async handleLaunch(
    req: IncomingMessage,
    res: ServerResponse,
    origin: string,
  ): Promise<void> {
    const jsonError = (status: number, error: string): void => {
      if (origin) this.writeLaunchCors(res, origin);
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error }));
    };

    if (req.method === "OPTIONS") {
      this.writeLaunchCors(res, origin);
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("allow", "POST, OPTIONS");
      res.end("method not allowed");
      return;
    }
    // Origin gating, mirroring /pair. Empty Origin is tolerated (extensions
    // with host_permissions may omit it); the token below is the real gate.
    if (origin !== "" && !this.isOriginAllowed(origin)) {
      void this.logger.write({ dir: "system", event: "launch_origin_rejected", origin });
      res.statusCode = 403;
      res.setHeader("content-type", "text/plain");
      res.end("origin not allowed");
      return;
    }
    if (!this.originMatchesPin(origin)) {
      void this.logger.write({ dir: "system", event: "launch_pin_rejected", origin });
      jsonError(403, "extension_pinned");
      return;
    }

    let body: Record<string, unknown>;
    try {
      const raw = await this.readBody(req);
      const parsed = raw.length > 0 ? (JSON.parse(raw) as unknown) : {};
      body =
        parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      jsonError(400, "bad_request");
      return;
    }

    if (typeof body["token"] !== "string" || body["token"] !== this.token) {
      void this.logger.write({ dir: "system", event: "launch_unauthorized", origin });
      jsonError(401, "unauthorized");
      return;
    }

    if (!this.onLaunch) {
      jsonError(503, "launch_unavailable");
      return;
    }

    const params: LaunchRequestParams = {
      agent: capField(body["agent"], 32),
      instruction: capField(body["instruction"], 8000),
      url: capField(body["url"]) ?? "",
      title: capField(body["title"]),
      description: capField(body["description"]),
      siteName: capField(body["site_name"]),
    };

    let outcome: LaunchOutcome;
    try {
      outcome = await this.onLaunch(params);
    } catch (err) {
      void this.logger.write({
        dir: "system",
        event: "launch_handler_error",
        error: err instanceof Error ? err.message : String(err),
      });
      outcome = { ok: false, error: "internal" };
    }
    void this.logger.write({
      dir: "system",
      event: "launch_requested",
      ok: outcome.ok,
      url: params.url,
    });
    if (origin) this.writeLaunchCors(res, origin);
    res.statusCode = outcome.ok ? 200 : 502;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(outcome));
  }

  // --- /chat/* surface ------------------------------------------------------

  private writeCors(res: ServerResponse, origin: string, methods: string): void {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", methods);
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("vary", "origin");
  }

  private endJson(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }

  private queryParam(req: IncomingMessage, name: string): string | undefined {
    try {
      return new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get(name) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Map an EngineError code to an HTTP status; default 500. */
  private chatErrorStatus(err: unknown): number {
    switch (engineErrorCode(err)) {
      case "unknown_session":
        return 404;
      case "session_ejected":
        return 409;
      case "agent_unavailable":
        return 422;
      case "claude_not_found":
        return 502;
      case "pty_unavailable":
        return 503;
      default:
        return 500;
    }
  }

  /**
   * Shared origin/pin/method gate for the chat endpoints, mirroring /launch.
   * Returns true to proceed, or false having already written the response
   * (OPTIONS preflight, wrong method, or a rejected origin/pin).
   */
  private chatGate(
    req: IncomingMessage,
    res: ServerResponse,
    origin: string,
    methods: string,
    wantMethod: "GET" | "POST",
  ): boolean {
    if (origin) this.writeCors(res, origin, methods);
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return false;
    }
    if (req.method !== wantMethod) {
      res.statusCode = 405;
      res.setHeader("allow", methods);
      res.end("method not allowed");
      return false;
    }
    if (origin !== "" && !this.isOriginAllowed(origin)) {
      void this.logger.write({ dir: "system", event: "chat_origin_rejected", origin });
      res.statusCode = 403;
      res.end("origin not allowed");
      return false;
    }
    if (!this.originMatchesPin(origin)) {
      void this.logger.write({ dir: "system", event: "chat_pin_rejected", origin });
      this.endJson(res, 403, { ok: false, error: "extension_pinned" });
      return false;
    }
    return true;
  }

  /** POST /chat/new | /chat/send | /chat/terminal. Token in the JSON body. */
  private async handleChatPost(
    req: IncomingMessage,
    res: ServerResponse,
    origin: string,
    path: string,
  ): Promise<void> {
    if (!this.chatGate(req, res, origin, "POST, OPTIONS", "POST")) return;

    let body: Record<string, unknown>;
    try {
      const raw = await this.readBody(req);
      const parsed = raw.length > 0 ? (JSON.parse(raw) as unknown) : {};
      body =
        parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      this.endJson(res, 400, { ok: false, error: "bad_request" });
      return;
    }
    if (typeof body["token"] !== "string" || body["token"] !== this.token) {
      void this.logger.write({ dir: "system", event: "chat_unauthorized", origin });
      this.endJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (!this.chat) {
      this.endJson(res, 503, { ok: false, error: "chat_unavailable" });
      return;
    }

    try {
      if (path === "/chat/new") {
        const params: ChatStartParams = {
          agent: capField(body["agent"], 32) ?? "claude",
          page: {
            url: capField(body["url"]) ?? "",
            title: capField(body["title"]),
            description: capField(body["description"]),
            siteName: capField(body["site_name"]),
          },
          ...(capField(body["instruction"], 8000) !== undefined
            ? { instruction: capField(body["instruction"], 8000) }
            : {}),
        };
        const ref = await this.chat.start(params);
        await this.logger.write({
          dir: "system",
          event: "chat_new",
          agent: params.agent,
          session: ref.sessionId,
        });
        this.endJson(res, 200, { ok: true, session: ref });
        return;
      }

      if (path === "/chat/send") {
        const sessionId = capField(body["session_id"], 100);
        const text = capField(body["text"], 100_000);
        if (!sessionId || text === undefined || text.length === 0) {
          this.endJson(res, 400, { ok: false, error: "bad_request" });
          return;
        }
        await this.chat.send(sessionId, text);
        this.endJson(res, 200, { ok: true });
        return;
      }

      // /chat/terminal
      const sessionId = capField(body["session_id"], 100);
      const mode = body["mode"];
      if (!sessionId || !isTerminalMode(mode)) {
        this.endJson(res, 400, { ok: false, error: "bad_request" });
        return;
      }
      const outcome = await this.chat.terminal(sessionId, mode);
      this.endJson(res, outcome.ok ? 200 : 502, outcome);
    } catch (err) {
      await this.logger.write({
        dir: "system",
        event: "chat_post_error",
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      this.endJson(res, this.chatErrorStatus(err), {
        ok: false,
        error: engineErrorCode(err) ?? "internal",
      });
    }
  }

  /** GET /chat/sessions | /chat/history. Token in the query string. */
  private async handleChatGet(
    req: IncomingMessage,
    res: ServerResponse,
    origin: string,
    path: string,
  ): Promise<void> {
    if (!this.chatGate(req, res, origin, "GET, OPTIONS", "GET")) return;
    if (this.queryParam(req, "token") !== this.token) {
      this.endJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (!this.chat) {
      this.endJson(res, 503, { ok: false, error: "chat_unavailable" });
      return;
    }
    try {
      if (path === "/chat/sessions") {
        this.endJson(res, 200, { ok: true, sessions: await this.chat.listSessions() });
        return;
      }
      const sessionId = this.queryParam(req, "session_id");
      if (!sessionId) {
        this.endJson(res, 400, { ok: false, error: "bad_request" });
        return;
      }
      this.endJson(res, 200, { ok: true, messages: await this.chat.history(sessionId) });
    } catch (err) {
      this.endJson(res, this.chatErrorStatus(err), {
        ok: false,
        error: engineErrorCode(err) ?? "internal",
      });
    }
  }

  /**
   * GET /chat/stream — Server-Sent Events. Token in the query string (the
   * EventSource API can't set headers). Events emitted by the engine (incl. the
   * replayed buffer) are queued until the SSE headers are written, then
   * flushed, so the response status can still be a 404 if the session is
   * unknown. The stream is registered so stop() can end it.
   */
  private async handleChatStream(
    req: IncomingMessage,
    res: ServerResponse,
    origin: string,
  ): Promise<void> {
    if (!this.chatGate(req, res, origin, "GET, OPTIONS", "GET")) return;
    if (this.queryParam(req, "token") !== this.token) {
      this.endJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (!this.chat) {
      this.endJson(res, 503, { ok: false, error: "chat_unavailable" });
      return;
    }
    const sessionId = this.queryParam(req, "session_id");
    if (!sessionId) {
      this.endJson(res, 400, { ok: false, error: "bad_request" });
      return;
    }

    const queued: ChatEvent[] = [];
    let live = false;
    const writeEvent = (event: ChatEvent): void => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* client gone */
      }
    };

    let unsub: () => void;
    try {
      // subscribe replays the buffer synchronously into our listener; capture
      // those into `queued` so they don't write before the SSE headers.
      unsub = await this.chat.subscribe(sessionId, (event) => {
        if (live) writeEvent(event);
        else queued.push(event);
      });
    } catch (err) {
      this.endJson(res, this.chatErrorStatus(err), {
        ok: false,
        error: engineErrorCode(err) ?? "internal",
      });
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("connection", "keep-alive");
    res.write(": connected\n\n");
    for (const event of queued) writeEvent(event);
    live = true;

    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* ignore */
      }
    }, 25_000);
    if (typeof ping === "object" && "unref" in ping) ping.unref();

    this.openStreams.add(res);
    const cleanup = (): void => {
      clearInterval(ping);
      this.openStreams.delete(res);
      try {
        unsub();
      } catch {
        /* ignore */
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  /** Read a request body as a string, rejecting once it exceeds `maxBytes`. */
  private readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          reject(new Error("body_too_large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = req.headers.origin ?? "";
    // Allow empty origin — extensions with host_permissions may omit it.
    // Real auth happens via the token in the Hello frame.
    if (origin !== "" && !this.isOriginAllowed(origin)) {
      void this.logger.write({ dir: "system", event: "origin_rejected", origin });
      try {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      } catch {
        /* ignore */
      }
      socket.destroy();
      return;
    }
    if (!this.originMatchesPin(origin)) {
      void this.logger.write({
        dir: "system",
        event: "upgrade_pin_rejected",
        origin,
        pinned: this.pinnedExtensionId,
      });
      try {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      } catch {
        /* ignore */
      }
      socket.destroy();
      return;
    }
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (path === "/chat/pty") {
      this.handlePtyUpgrade(req, socket, head);
      return;
    }
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.wss!.emit("connection", ws, req));
  }

  /** Gate + upgrade a /chat/pty terminal socket (token in the query string, like SSE). */
  private handlePtyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const reject = (status: string): void => {
      try {
        socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
      } catch {
        /* ignore */
      }
      socket.destroy();
    };
    if (this.queryParam(req, "token") !== this.token) return reject("401 Unauthorized");
    if (!this.chat) return reject("503 Service Unavailable");
    const sessionId = this.queryParam(req, "session_id");
    if (!sessionId) return reject("400 Bad Request");
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.handlePtyConnection(ws, sessionId));
  }

  /** Bridge a terminal socket to the live pty: raw output out, JSON input/resize in. */
  private handlePtyConnection(ws: WebSocket, sessionId: string): void {
    let handle: TerminalHandle;
    try {
      handle = this.chat!.attachTerminal(sessionId);
    } catch (err) {
      try {
        ws.close(1011, engineErrorCode(err) ?? "error");
      } catch {
        /* ignore */
      }
      return;
    }
    this.openPtySockets.add(ws);
    const unsub = handle.onData((data) => {
      try {
        ws.send(data);
      } catch {
        /* client gone */
      }
    });
    ws.on("message", (raw: RawData) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as Record<string, unknown>;
      if (m["type"] === "input" && typeof m["data"] === "string") {
        handle.write(m["data"]);
      } else if (
        m["type"] === "resize" &&
        Number.isInteger(m["cols"]) &&
        Number.isInteger(m["rows"])
      ) {
        handle.resize(m["cols"] as number, m["rows"] as number);
      }
    });
    const cleanup = (): void => {
      this.openPtySockets.delete(ws);
      try {
        unsub();
      } catch {
        /* ignore */
      }
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  private isOriginAllowed(origin: string): boolean {
    if (!origin.startsWith("chrome-extension://")) return false;
    if (this.allowedExtensionId === "") return true;
    return origin === `chrome-extension://${this.allowedExtensionId}`;
  }

  /**
   * Extract the extension ID from a chrome-extension://<id> Origin.
   * Returns null for non-extension origins (or empty Origin headers).
   * Used to enforce the "first-pair wins" pin: once an ID is pinned to
   * `~/.browserops/extension_id`, /pair and WS upgrades from any other
   * extension origin are refused.
   */
  private extensionIdFromOrigin(origin: string): string | null {
    if (!origin.startsWith("chrome-extension://")) return null;
    const id = origin.slice("chrome-extension://".length);
    // chrome extension IDs are 32 lowercase letters a-p; tolerate hex for tests.
    if (id.length === 0) return null;
    return id;
  }

  /**
   * Returns true when an incoming chrome-extension Origin is allowed to
   * pair / upgrade given the current pinned-ID state. Non-extension
   * origins are handled by isOriginAllowed and are not the concern here.
   */
  private originMatchesPin(origin: string): boolean {
    if (this.pinnedExtensionId === null) return true;
    if (origin === "") {
      // Empty Origin is allowed for WS upgrades (host_permissions case)
      // but we can't verify the extension ID. The token in the Hello
      // frame still gates the connection.
      return true;
    }
    return origin === `chrome-extension://${this.pinnedExtensionId}`;
  }

  /**
   * True only when an Origin is *positively* the currently-pinned extension
   * (pin set AND origin matches). Unlike originMatchesPin, a null pin or an
   * empty Origin returns false — we use this to let the already-trusted
   * extension re-pair, which requires actually knowing who it is. An
   * unidentifiable caller must not be treated as the pinned one.
   */
  private isPinnedOrigin(origin: string): boolean {
    if (this.pinnedExtensionId === null || origin === "") return false;
    return origin === `chrome-extension://${this.pinnedExtensionId}`;
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    let state: "awaiting_hello" | "ready" | "closed" = "awaiting_hello";
    const helloTimer = setTimeout(() => {
      if (state === "awaiting_hello") {
        try {
          ws.close(CloseCode.HELLO_TIMEOUT, "hello_timeout");
        } catch {
          /* ignore */
        }
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
          try {
            this.activeSocket.close(CloseCode.SUPERSEDED, "superseded");
          } catch {
            /* ignore */
          }
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
        try {
          ws.send(JSON.stringify(ack));
        } catch (err) {
          void this.logger.write({ dir: "system", event: "ack_send_error", error: String(err) });
        }
        void this.logger.write({
          dir: "system",
          event: "ws_ready",
          extension_version: msg.extension_version,
          protocol_version: msg.protocol_version,
        });

        // Pin the extension ID on first successful hello. Subsequent
        // bridges (same install) reload this from disk and refuse
        // /pair + WS upgrade from any other chrome-extension origin.
        // Fail-soft on persistence errors — the live socket is already
        // token-authed; we just lose race-protection on the next boot.
        if (this.pinnedExtensionId === null) {
          const origin = req.headers.origin ?? "";
          const extId = this.extensionIdFromOrigin(origin);
          if (extId !== null) {
            this.pinnedExtensionId = extId;
            void this.logger.write({
              dir: "system",
              event: "extension_pinned",
              extension_id: extId,
            });
            if (this.onExtensionPin) {
              void this.onExtensionPin(extId).catch((err: unknown) =>
                this.logger.write({
                  dir: "system",
                  event: "extension_pin_persist_error",
                  error: err instanceof Error ? err.message : String(err),
                }),
              );
            }
          }
        }
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

    ws.on(
      "error",
      (err) => void this.logger.write({ dir: "system", event: "ws_error", error: String(err) }),
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
    try {
      ws.close(code, reason);
    } catch {
      /* ignore */
    }
    void this.logger.write({ dir: "system", event: "close", code, reason });
  }

  private notifyConnChange(): void {
    if (!this.onConnectionChange) return;
    const current = this.isConnected();
    if (current === this.lastNotifiedConnected) return;
    this.lastNotifiedConnected = current;
    try {
      this.onConnectionChange(current);
    } catch {
      /* ignore */
    }
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
