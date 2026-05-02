#!/usr/bin/env node
/**
 * browserops-daemon
 *
 * Long-lived per-user singleton. Owns the WebSocket to the extension
 * (in later phases) and accepts shim connections over a Unix socket so
 * multiple MCP clients can drive the same Chrome profile concurrently
 * without stomping on each other.
 *
 * This file is the daemon entry skeleton. Subsequent phases bolt on:
 *   • per-session McpBridgeServer instances (1.4)
 *   • shared WSBridge / Safety / procedures (later in 1.4)
 *   • per-session rate limiters (phase 2)
 *   • tab ownership + auto-claim (phase 3)
 */
import { Logger, type LogLevel } from "./logger.js";
import { ENV } from "@browserops/shared";
import {
  acquirePidfile,
  DaemonSocketServer,
  releasePidfile,
  type ShimConnection,
} from "./daemon-socket.js";
import { SessionRegistry, type DaemonSession } from "./daemon-sessions.js";
import { daemonPidfilePath, daemonSocketPath } from "./paths.js";

const VERSION = "0.0.5";

async function main(): Promise<void> {
  installProcessErrorHandlers();
  process.env["BROWSEROPS_DAEMON_VERSION"] = VERSION;

  const logLevel = parseLogLevel(process.env[ENV.LOG_LEVEL]);
  const logger = new Logger(logLevel);
  await logger.write({ dir: "system", event: "daemon_boot", version: VERSION });

  const pidfile = daemonPidfilePath();
  const ok = await acquirePidfile(pidfile).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`browserops-daemon: pidfile error: ${msg}\n`);
    return false;
  });
  if (!ok) {
    process.stderr.write(
      `browserops-daemon: another daemon is already running (pidfile ${pidfile}).\n`,
    );
    process.exit(2);
  }

  const sessions = new SessionRegistry({
    onCreate: (s) => {
      void logger.write({
        dir: "system",
        event: "session_create",
        session_id: s.id,
        name: s.name,
        color: s.color,
      });
    },
    onDestroy: (s) => {
      void logger.write({
        dir: "system",
        event: "session_destroy",
        session_id: s.id,
        name: s.name,
      });
    },
    onWarn: (m) => process.stderr.write(`[browserops-daemon] ${m}\n`),
  });

  const socketPath = daemonSocketPath();
  const socket = new DaemonSocketServer({
    socketPath,
    logger,
    handlers: {
      onSession: (conn, register) => attachStubSession(conn, register, sessions, logger),
    },
  });
  await socket.start();
  process.stderr.write(`browserops-daemon: listening on ${socketPath} (pid ${process.pid})\n`);

  const shutdown = (reason: string): void => {
    void (async () => {
      await logger.write({ dir: "system", event: "daemon_shutdown", reason });
      try { await socket.stop(); } catch { /* ignore */ }
      await releasePidfile(pidfile);
      await logger.close();
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * Substep 1.2: registration only. We mint a session, ack, then echo
 * any mcp_in we receive back as mcp_out so end-to-end plumbing can be
 * smoke-tested before wiring the real MCP machinery in 1.4.
 */
function attachStubSession(
  conn: ShimConnection,
  register: { client_info?: { name: string; version: string } },
  sessions: SessionRegistry,
  logger: Logger,
): DaemonSession {
  const session = sessions.create(register.client_info);

  conn.onMcpIn((data) => {
    void logger.write({
      dir: "system",
      event: "stub_mcp_in",
      session_id: session.id,
      bytes: data.length,
    });
    conn.send({ type: "mcp_out", data });
  });

  conn.onClose((reason) => {
    sessions.destroy(session.id);
    void logger.write({
      dir: "system",
      event: "session_socket_closed",
      session_id: session.id,
      reason,
    });
  });

  return session;
}

function parseLogLevel(v: string | undefined): LogLevel {
  return v === "audit" ? "audit" : "normal";
}

function installProcessErrorHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`browserops-daemon: unhandledRejection: ${msg}\n`);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`browserops-daemon: uncaughtException: ${err.stack ?? err.message}\n`);
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`browserops-daemon: fatal: ${msg}\n`);
  process.exit(1);
});
