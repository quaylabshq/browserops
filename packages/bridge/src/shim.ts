#!/usr/bin/env node
/**
 * browserops-shim
 *
 * Per-MCP-client thin process. Forwards stdio MCP frames to the
 * long-lived browserops-daemon over a Unix socket so multiple MCP
 * clients can share one Chrome profile.
 *
 *   stdin  → "mcp_in"  envelopes → daemon
 *   daemon → "mcp_out" envelopes → stdout
 *
 * Auto-spawns the daemon if its socket is absent or stale. Sniffs the
 * first stdin line for an MCP `initialize` frame and forwards the
 * client's `clientInfo` in the registration frame so the daemon can
 * label the session and its Chrome tab group meaningfully from the
 * very first session_started broadcast.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
  DAEMON_PROTOCOL_VERSION,
  isDaemonBye,
  isDaemonMcpOut,
  isDaemonRegisterAck,
  isDaemonRegisterNak,
  type DaemonClientInfo,
  type ShimMcpIn,
  type ShimRegister,
} from "@browserops/shared";
import { daemonSocketPath } from "./paths.js";
import { probeSocket } from "./daemon-socket.js";

const SHIM_VERSION = "0.0.5";
const DAEMON_SPAWN_TIMEOUT_MS = 8_000;
const DAEMON_SPAWN_POLL_MS = 75;

async function main(): Promise<void> {
  installProcessErrorHandlers();

  const socketPath = daemonSocketPath();

  // Buffer stdin lines until the daemon is connected. We sniff the first
  // line for an MCP `initialize` so we can pass clientInfo at register time.
  const stdinBuffer: string[] = [];
  let stdinClosed = false;
  let pendingChunk = "";
  let firstLineHandled = false;
  let registered = false;
  let socket: Socket | undefined;

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    pendingChunk += chunk;
    let idx: number;
    while ((idx = pendingChunk.indexOf("\n")) >= 0) {
      const line = pendingChunk.slice(0, idx);
      pendingChunk = pendingChunk.slice(idx + 1);
      if (!firstLineHandled) {
        firstLineHandled = true;
        const info = sniffClientInfo(line);
        // Kick off connect using the sniffed info, but still queue the
        // line so the daemon sees the original initialize frame.
        stdinBuffer.push(line);
        connectAndPump(info).catch((err: unknown) => {
          fail(`failed to connect to daemon: ${describeErr(err)}`);
        });
        continue;
      }
      if (registered && socket) {
        sendMcpIn(socket, line);
      } else {
        stdinBuffer.push(line);
      }
    }
  });
  process.stdin.on("end", () => {
    stdinClosed = true;
    if (registered && socket) {
      flushBufferAndClose();
    }
  });
  process.stdin.on("error", (err) => fail(`stdin error: ${describeErr(err)}`));

  async function connectAndPump(client_info: DaemonClientInfo | undefined): Promise<void> {
    socket = await ensureDaemonAndConnect(socketPath);

    socket.setEncoding("utf8");

    let recvBuffer = "";
    socket.on("data", (chunk: string) => {
      recvBuffer += chunk;
      let idx: number;
      while ((idx = recvBuffer.indexOf("\n")) >= 0) {
        const line = recvBuffer.slice(0, idx);
        recvBuffer = recvBuffer.slice(idx + 1);
        if (line.length === 0) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        handleDaemonFrame(msg);
      }
    });
    socket.on("close", () => {
      if (!registered) {
        fail("daemon closed connection before register_ack");
        return;
      }
      // Daemon went away mid-session — exit so the MCP client sees the
      // stdio close and can choose to respawn.
      process.exit(0);
    });
    socket.on("error", (err) => fail(`daemon socket error: ${describeErr(err)}`));

    const register: ShimRegister = {
      type: "register",
      protocol_version: DAEMON_PROTOCOL_VERSION,
      client_info,
    };
    socket.write(JSON.stringify(register) + "\n");
  }

  function handleDaemonFrame(msg: unknown): void {
    if (!registered) {
      if (isDaemonRegisterAck(msg)) {
        if (msg.protocol_version !== DAEMON_PROTOCOL_VERSION) {
          fail(
            `protocol mismatch: shim ${DAEMON_PROTOCOL_VERSION}, daemon ${msg.protocol_version}`,
          );
          return;
        }
        registered = true;
        process.stderr.write(
          `[browserops-shim] session ${msg.session_id} (${msg.session_name}, ${msg.session_color})\n`,
        );
        flushBufferAfterAck();
        if (stdinClosed) flushBufferAndClose();
        return;
      }
      if (isDaemonRegisterNak(msg)) {
        fail(`daemon refused registration: ${msg.reason}: ${msg.message}`);
        return;
      }
      // Unknown pre-register frame — ignore.
      return;
    }

    if (isDaemonMcpOut(msg)) {
      process.stdout.write(msg.data);
      if (!msg.data.endsWith("\n")) process.stdout.write("\n");
      return;
    }
    if (isDaemonBye(msg)) {
      // Graceful close from daemon side — let the close handler exit.
      return;
    }
  }

  function flushBufferAfterAck(): void {
    while (stdinBuffer.length > 0) {
      const line = stdinBuffer.shift()!;
      sendMcpIn(socket!, line);
    }
  }

  function flushBufferAndClose(): void {
    flushBufferAfterAck();
    try { socket!.end(); } catch { /* ignore */ }
  }
}

function sendMcpIn(socket: Socket, data: string): void {
  // Daemon expects exactly one MCP frame per `mcp_in`. Pass the raw line
  // — daemon's MCP transport will append the newline back when it reads.
  const env: ShimMcpIn = { type: "mcp_in", data };
  try { socket.write(JSON.stringify(env) + "\n"); } catch { /* ignore */ }
}

/**
 * Try to extract clientInfo from an MCP initialize frame. Tolerates
 * non-initialize first frames (returns undefined) and any parse errors.
 */
function sniffClientInfo(line: string): DaemonClientInfo | undefined {
  try {
    const parsed = JSON.parse(line) as { method?: string; params?: { clientInfo?: { name?: string; version?: string } } };
    if (parsed.method !== "initialize") return undefined;
    const ci = parsed.params?.clientInfo;
    if (!ci || typeof ci.name !== "string") return undefined;
    return { name: ci.name, version: typeof ci.version === "string" ? ci.version : "" };
  } catch {
    return undefined;
  }
}

/**
 * Ensure a daemon is reachable at `socketPath` and return an open
 * connection. If the socket is missing or stale, spawn the daemon as a
 * detached process and poll until it accepts connections.
 */
async function ensureDaemonAndConnect(socketPath: string): Promise<Socket> {
  if (existsSync(socketPath)) {
    const live = await probeSocket(socketPath);
    if (live) return await connect(socketPath);
  }

  spawnDaemon();

  const deadline = Date.now() + DAEMON_SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      const live = await probeSocket(socketPath);
      if (live) return await connect(socketPath);
    }
    await sleep(DAEMON_SPAWN_POLL_MS);
  }
  throw new Error(`daemon did not become reachable at ${socketPath} within ${DAEMON_SPAWN_TIMEOUT_MS}ms`);
}

function spawnDaemon(): void {
  const here = fileURLToPath(import.meta.url);
  // Resolve the daemon entry alongside the shim binary in dist/, or
  // alongside src/shim.ts during dev (tsx).
  const daemonPath = here.replace(/shim\.(ts|js)$/, (_m, ext: string) => `daemon.${ext}`);
  const env = { ...process.env, BROWSEROPS_DAEMON_VERSION: SHIM_VERSION };
  // detached:true makes the daemon survive shim exit; stdio:'ignore' so
  // it has no inherited tty/pipes (otherwise stdin EOF would trip the
  // legacy bridge's shutdown-on-stdin-close handler).
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.on("error", (err) => {
    process.stderr.write(`[browserops-shim] failed to spawn daemon: ${describeErr(err)}\n`);
  });
  child.unref();
}

function connect(socketPath: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const sock = createConnection(socketPath);
    const onErr = (err: Error): void => {
      sock.off("connect", onConn);
      reject(err);
    };
    const onConn = (): void => {
      sock.off("error", onErr);
      resolve(sock);
    };
    sock.once("error", onErr);
    sock.once("connect", onConn);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function fail(message: string): never {
  process.stderr.write(`browserops-shim: fatal: ${message}\n`);
  process.exit(1);
}

function installProcessErrorHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`browserops-shim: unhandledRejection: ${msg}\n`);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`browserops-shim: uncaughtException: ${err.stack ?? err.message}\n`);
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`browserops-shim: fatal: ${msg}\n`);
  process.exit(1);
});
