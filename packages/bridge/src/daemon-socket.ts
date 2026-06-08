import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createConnection, createServer, type Server as NetServer, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  DAEMON_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  isShimBye,
  isShimMcpIn,
  isShimRegister,
  type DaemonRegisterAck,
  type DaemonRegisterNak,
  type DaemonToShim,
  type ShimToDaemon,
} from "@browserops/shared";
import type { Logger } from "./logger.js";
import type { DaemonSession } from "./daemon-sessions.js";

// Shim ↔ daemon JSONL framing is capped to the same per-frame budget as the
// extension WebSocket so the two transports stay in lockstep.
const MAX_LINE_BYTES = MAX_FRAME_BYTES;

export interface DaemonSocketHandlers {
  /**
   * Called when a shim has registered. Implementer wires the returned
   * session to its MCP machinery and pumps mcp_in/mcp_out on the
   * supplied connection. Throwing here will cause the daemon to send a
   * register_nak and close the socket.
   */
  onSession(
    connection: ShimConnection,
    register: { client_info?: { name: string; version: string } },
  ): Promise<DaemonSession> | DaemonSession;
}

/**
 * One live shim connection. Each MCP client gets exactly one of these.
 * The daemon side uses `send` for register_ack/mcp_out/bye and reads
 * shim frames via the handler that `attach()` installs after register.
 */
export interface ShimConnection {
  send(msg: DaemonToShim): void;
  onMcpIn(handler: (data: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(reason: string): void;
}

interface ConnState {
  socket: Socket;
  buffer: string;
  registered: boolean;
  mcpInHandler?: (data: string) => void;
  closeHandlers: ((reason: string) => void)[];
  closed: boolean;
}

export interface DaemonSocketOptions {
  socketPath: string;
  logger: Logger;
  handlers: DaemonSocketHandlers;
}

/**
 * Listens on the shim ↔ daemon Unix socket. Frames are NDJSON.
 *
 * Per-connection lifecycle:
 *   1. Shim sends `register`. Daemon hands the connection to
 *      handlers.onSession, which mints a DaemonSession and (in later
 *      phases) starts an MCP transport reading from `onMcpIn`.
 *   2. Daemon writes `register_ack` (or `register_nak` on failure).
 *   3. Subsequent shim `mcp_in` frames are dispatched to the handler.
 *   4. Either side may send `bye` for a graceful close. Socket close
 *      with no `bye` ends the session immediately.
 */
export class DaemonSocketServer {
  private server?: NetServer;
  private readonly conns = new Set<ConnState>();
  private readonly opts: DaemonSocketOptions;
  private shuttingDown = false;

  constructor(opts: DaemonSocketOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const socketPath = this.opts.socketPath;
    await mkdir(dirname(socketPath), { recursive: true });

    if (existsSync(socketPath)) {
      const live = await probeSocket(socketPath);
      if (live) {
        throw new Error(`daemon socket at ${socketPath} is already owned by a live process`);
      }
      await unlink(socketPath).catch(() => {
        /* ignore — race with another cleanup */
      });
    }

    this.server = createServer((socket) => this.handleConnection(socket));
    this.server.on(
      "error",
      (err) =>
        void this.opts.logger.write({
          dir: "system",
          event: "daemon_socket_error",
          error: String(err),
        }),
    );

    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error): void => reject(err);
      this.server!.once("error", onErr);
      this.server!.listen(socketPath, () => {
        this.server!.removeListener("error", onErr);
        resolve();
      });
    });
    await chmod(socketPath, 0o600).catch(() => {
      /* best effort */
    });
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    for (const conn of this.conns) {
      try {
        conn.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.conns.clear();
    if (this.server) {
      await new Promise<void>((r) => this.server!.close(() => r()));
      this.server = undefined;
    }
    await unlink(this.opts.socketPath).catch(() => {
      /* ignore */
    });
  }

  private handleConnection(socket: Socket): void {
    const state: ConnState = {
      socket,
      buffer: "",
      registered: false,
      closeHandlers: [],
      closed: false,
    };
    this.conns.add(state);

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(state, chunk));
    socket.on("close", () => this.onClose(state, "socket_close"));
    socket.on(
      "error",
      (err) =>
        void this.opts.logger.write({
          dir: "system",
          event: "daemon_conn_error",
          error: String(err),
        }),
    );
  }

  private onData(state: ConnState, chunk: string): void {
    state.buffer += chunk;
    if (state.buffer.length > MAX_LINE_BYTES) {
      void this.opts.logger.write({ dir: "system", event: "daemon_conn_oversize" });
      try {
        state.socket.destroy();
      } catch {
        /* ignore */
      }
      return;
    }
    let idx: number;
    while ((idx = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      let msg: ShimToDaemon | unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        void this.opts.logger.write({ dir: "system", event: "daemon_bad_json" });
        continue;
      }
      this.dispatch(state, msg);
    }
  }

  private dispatch(state: ConnState, msg: unknown): void {
    if (!state.registered) {
      if (!isShimRegister(msg)) {
        this.nak(state, "internal", "first frame must be `register`");
        return;
      }
      if (msg.protocol_version !== DAEMON_PROTOCOL_VERSION) {
        this.nak(
          state,
          "protocol_mismatch",
          `daemon speaks protocol_version ${DAEMON_PROTOCOL_VERSION}, shim sent ${msg.protocol_version}`,
        );
        return;
      }
      if (this.shuttingDown) {
        this.nak(state, "shutting_down", "daemon is shutting down");
        return;
      }
      state.registered = true;
      const conn = this.makeConnection(state);
      Promise.resolve()
        .then(() => this.opts.handlers.onSession(conn, { client_info: msg.client_info }))
        .then((session) => {
          const ack: DaemonRegisterAck = {
            type: "register_ack",
            protocol_version: DAEMON_PROTOCOL_VERSION,
            daemon_version: this.daemonVersion(),
            session_id: session.id,
            session_name: session.name,
            session_color: session.color,
          };
          this.send(state, ack);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.nak(state, "internal", message);
        });
      return;
    }

    if (isShimMcpIn(msg)) {
      state.mcpInHandler?.(msg.data);
      return;
    }
    if (isShimBye(msg)) {
      this.onClose(state, msg.reason ?? "shim_bye");
      try {
        state.socket.end();
      } catch {
        /* ignore */
      }
      return;
    }

    void this.opts.logger.write({ dir: "system", event: "daemon_unknown_frame" });
  }

  private makeConnection(state: ConnState): ShimConnection {
    return {
      send: (msg) => this.send(state, msg),
      onMcpIn: (handler) => {
        state.mcpInHandler = handler;
      },
      onClose: (handler) => {
        if (state.closed) handler("already_closed");
        else state.closeHandlers.push(handler);
      },
      close: (reason) => {
        try {
          state.socket.end();
        } catch {
          /* ignore */
        }
        this.onClose(state, reason);
      },
    };
  }

  private send(state: ConnState, msg: DaemonToShim): void {
    if (state.closed) return;
    try {
      state.socket.write(JSON.stringify(msg) + "\n");
    } catch {
      /* ignore */
    }
  }

  private nak(state: ConnState, reason: DaemonRegisterNak["reason"], message: string): void {
    const nak: DaemonRegisterNak = { type: "register_nak", reason, message };
    this.send(state, nak);
    try {
      state.socket.end();
    } catch {
      /* ignore */
    }
  }

  private onClose(state: ConnState, reason: string): void {
    if (state.closed) return;
    state.closed = true;
    this.conns.delete(state);
    for (const h of state.closeHandlers) {
      try {
        h(reason);
      } catch {
        /* ignore */
      }
    }
    state.closeHandlers.length = 0;
  }

  private daemonVersion(): string {
    return process.env["BROWSEROPS_DAEMON_VERSION"] ?? "0.0.0";
  }
}

/**
 * True iff a process is currently accepting connections on the socket.
 * Used to differentiate live daemons from stale socket files.
 */
export async function probeSocket(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = createConnection(path);
    const cleanup = (): void => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
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

/**
 * Pidfile lock.
 *
 * Atomically writes our PID to `path` if no live daemon is recorded
 * there. Returns false when another daemon is alive — caller should
 * exit. Stale pidfiles (process gone, or kill -0 ESRCH) are reclaimed.
 */
export async function acquirePidfile(path: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const raw = await readFile(path, "utf8").catch(() => "");
    const pid = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(pid) && pid > 0 && pidIsAlive(pid)) {
      return false;
    }
    await unlink(path).catch(() => {
      /* ignore */
    });
  }
  await writeFile(path, String(process.pid), { flag: "wx" }).catch(
    async (err: NodeJS.ErrnoException) => {
      // Race: another process won the wx open. Re-check liveness; if alive, surrender.
      if (err.code === "EEXIST") {
        const raw = await readFile(path, "utf8").catch(() => "");
        const pid = Number.parseInt(raw.trim(), 10);
        if (Number.isFinite(pid) && pid > 0 && pidIsAlive(pid)) {
          throw new Error("pidfile_taken");
        }
        await unlink(path).catch(() => {
          /* ignore */
        });
        await writeFile(path, String(process.pid));
        return;
      }
      throw err;
    },
  );
  return true;
}

export async function releasePidfile(path: string): Promise<void> {
  try {
    const raw = await readFile(path, "utf8");
    if (Number.parseInt(raw.trim(), 10) === process.pid) {
      await unlink(path).catch(() => {
        /* ignore */
      });
    }
  } catch {
    /* ignore */
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but is owned by another user — still
    // counts as alive for our purposes (we'd never be able to signal it).
    return code === "EPERM";
  }
}
