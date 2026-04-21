import { createConnection, createServer, type Server as NetServer, type Socket } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ErrorCode } from "@browserops/shared";
import {
  CONTROL_PROTOCOL_VERSION,
  isCall,
  isCancel,
  type ControlCall,
  type ControlConn,
  type ControlEvent,
  type ControlHello,
  type ControlMessage,
  type ControlResult,
} from "./control-protocol.js";
import type { Logger } from "./logger.js";
import type { WSBridgeLike } from "./mcp-server.js";

const MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface ControlServerOptions {
  socketPath: string;
  wsBridge: WSBridgeLike;
  bridgeVersion: string;
  logger: Logger;
}

interface ClientState {
  socket: Socket;
  pending: Map<string, AbortController>;
  buffer: string;
}

/**
 * Primary-side listener on ~/.browserops/bridge.sock. Secondary bridge
 * processes connect here to forward tool calls and receive extension events.
 */
export class ControlServer {
  private readonly socketPath: string;
  private readonly wsBridge: WSBridgeLike;
  private readonly bridgeVersion: string;
  private readonly logger: Logger;
  private server?: NetServer;
  private readonly clients = new Set<ClientState>();

  constructor(opts: ControlServerOptions) {
    this.socketPath = opts.socketPath;
    this.wsBridge = opts.wsBridge;
    this.bridgeVersion = opts.bridgeVersion;
    this.logger = opts.logger;
  }

  async start(): Promise<void> {
    if (existsSync(this.socketPath)) {
      const live = await probeSocket(this.socketPath);
      if (live) {
        throw new Error(
          `control socket at ${this.socketPath} is already owned by a live primary`,
        );
      }
      await unlink(this.socketPath).catch(() => {
        /* ignore */
      });
    }

    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.on("error", (err) =>
      void this.logger.write({ dir: "system", event: "control_server_error", error: String(err) }),
    );

    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error): void => reject(err);
      this.server!.once("error", onErr);
      this.server!.listen(this.socketPath, () => {
        this.server!.removeListener("error", onErr);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600).catch(() => {
      /* best effort */
    });
    await this.logger.write({
      dir: "system",
      event: "control_listening",
      path: this.socketPath,
    });
  }

  async stop(): Promise<void> {
    for (const c of this.clients) {
      for (const [, ac] of c.pending) ac.abort();
      c.pending.clear();
      try { c.socket.destroy(); } catch { /* ignore */ }
    }
    this.clients.clear();
    if (this.server) {
      await new Promise<void>((r) => this.server!.close(() => r()));
      this.server = undefined;
    }
    await unlink(this.socketPath).catch(() => {
      /* ignore */
    });
  }

  broadcastEvent(name: string, payload: Record<string, unknown>): void {
    const msg: ControlEvent = { type: "event", name, payload };
    this.broadcast(msg);
  }

  broadcastConn(connected: boolean): void {
    const msg: ControlConn = { type: "conn", connected };
    this.broadcast(msg);
  }

  private broadcast(msg: ControlMessage): void {
    const line = JSON.stringify(msg) + "\n";
    for (const c of this.clients) {
      try { c.socket.write(line); } catch { /* ignore */ }
    }
  }

  private handleConnection(socket: Socket): void {
    const client: ClientState = { socket, pending: new Map(), buffer: "" };
    this.clients.add(client);

    void this.logger.write({ dir: "system", event: "control_client_open" });

    const hello: ControlHello = {
      type: "hello",
      protocol_version: CONTROL_PROTOCOL_VERSION,
      bridge_version: this.bridgeVersion,
      connected: this.wsBridge.isConnected(),
    };
    try { socket.write(JSON.stringify(hello) + "\n"); } catch { /* ignore */ }

    socket.setEncoding("utf8");

    socket.on("data", (chunk: string) => {
      client.buffer += chunk;
      if (client.buffer.length > MAX_LINE_BYTES) {
        void this.logger.write({ dir: "system", event: "control_oversize", bytes: client.buffer.length });
        try { socket.destroy(); } catch { /* ignore */ }
        return;
      }
      let idx: number;
      while ((idx = client.buffer.indexOf("\n")) >= 0) {
        const line = client.buffer.slice(0, idx);
        client.buffer = client.buffer.slice(idx + 1);
        if (line.length === 0) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          void this.logger.write({ dir: "system", event: "control_bad_json" });
          continue;
        }
        this.handleMessage(client, msg);
      }
    });

    socket.on("close", () => {
      for (const [, ac] of client.pending) ac.abort();
      client.pending.clear();
      this.clients.delete(client);
      void this.logger.write({ dir: "system", event: "control_client_close" });
    });

    socket.on("error", (err) =>
      void this.logger.write({ dir: "system", event: "control_client_error", error: String(err) }),
    );
  }

  private handleMessage(client: ClientState, msg: unknown): void {
    if (isCall(msg)) {
      this.handleCall(client, msg);
      return;
    }
    if (isCancel(msg)) {
      const ac = client.pending.get(msg.id);
      if (ac) {
        ac.abort();
        client.pending.delete(msg.id);
      }
      return;
    }
    void this.logger.write({ dir: "system", event: "control_unknown_msg" });
  }

  private handleCall(client: ClientState, call: ControlCall): void {
    const ac = new AbortController();
    client.pending.set(call.id, ac);

    this.wsBridge
      .callExtension(call.method, call.params, call.timeout_ms, ac.signal)
      .then(
        (result) => {
          client.pending.delete(call.id);
          this.sendResult(client, { type: "result", id: call.id, ok: true, result });
        },
        (err: unknown) => {
          client.pending.delete(call.id);
          const code = extractErrorCode(err);
          const message = err instanceof Error ? err.message : String(err);
          this.sendResult(client, {
            type: "result",
            id: call.id,
            ok: false,
            error: { code, message },
          });
        },
      );
  }

  private sendResult(client: ClientState, result: ControlResult): void {
    try { client.socket.write(JSON.stringify(result) + "\n"); } catch { /* ignore */ }
  }
}

/**
 * Checks whether the unix socket at `path` is accepting connections.
 * Returns false for stale/orphaned socket files (ECONNREFUSED/ENOENT).
 */
async function probeSocket(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = createConnection(path);
    const cleanup = (): void => {
      try { sock.destroy(); } catch { /* ignore */ }
    };
    sock.once("connect", () => {
      cleanup();
      resolve(true);
    });
    sock.once("error", () => {
      cleanup();
      resolve(false);
    });
    setTimeout(() => {
      cleanup();
      resolve(false);
    }, 500).unref();
  });
}

const KNOWN_CODES = new Set<string>([
  "TAB_NOT_FOUND",
  "REF_STALE",
  "REF_NOT_FOUND",
  "TIMEOUT",
  "NAVIGATION_IN_PROGRESS",
  "CDP_ATTACH_FAILED",
  "FRAME_UNREACHABLE",
  "RATE_LIMITED",
  "RISKY_ACTION_DENIED",
  "EXTENSION_DISCONNECTED",
  "INVALID_PARAMS",
  "INTERNAL",
]);

function extractErrorCode(err: unknown): ErrorCode {
  if (err && typeof err === "object") {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string" && KNOWN_CODES.has(c)) return c as ErrorCode;
    const name = (err as { name?: unknown }).name;
    if (name === "AbortError") return "INTERNAL";
  }
  return "INTERNAL";
}
