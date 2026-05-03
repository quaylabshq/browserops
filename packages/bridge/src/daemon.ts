#!/usr/bin/env node
/**
 * browserops-daemon
 *
 * Long-lived per-user singleton. Owns the WebSocket to the extension
 * and accepts shim connections over a Unix socket so multiple MCP
 * clients can drive the same Chrome profile concurrently without
 * stomping on each other.
 */
import {
  ENV,
  RATE_LIMIT_GLOBAL_PER_MIN_DEFAULT,
  RATE_LIMIT_PER_TAB_PER_MIN,
} from "@browserops/shared";
import { Logger, type LogLevel } from "./logger.js";
import {
  acquirePidfile,
  DaemonSocketServer,
  releasePidfile,
  type ShimConnection,
} from "./daemon-socket.js";
import { SessionRegistry, type DaemonSession } from "./daemon-sessions.js";
import { daemonPidfilePath, daemonSocketPath } from "./paths.js";
import { bootDaemonRuntime, type DaemonRuntime } from "./daemon-runtime.js";
import { McpBridgeServer } from "./mcp-server.js";
import { RateLimiter } from "./rate-limiter.js";
import { SocketServerTransport } from "./socket-mcp-transport.js";

const VERSION = "0.0.5";

interface ActiveSession {
  session: DaemonSession;
  mcp: McpBridgeServer;
  transport: SocketServerTransport;
  rateLimiter: RateLimiter;
}

async function main(): Promise<void> {
  installProcessErrorHandlers();
  process.env["BROWSEROPS_DAEMON_VERSION"] = VERSION;
  applyDaemonCliFlags(process.argv.slice(2));

  // Bootstrap logger early so pidfile/socket failures still get logged.
  const bootLogger = new Logger(parseLogLevel(process.env[ENV.LOG_LEVEL]));
  await bootLogger.write({ dir: "system", event: "daemon_boot", version: VERSION });

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

  const runtime = await bootDaemonRuntime({ version: VERSION }).catch(async (err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`browserops-daemon: runtime boot failed: ${msg}\n`);
    await releasePidfile(pidfile);
    process.exit(1);
  });

  const active = new Map<string, ActiveSession>();

  // Fan tab_closed → forgetTab across every active session's bucket so a
  // closed tab can't continue eating quota. Buckets are otherwise fully
  // isolated: one session's burst never touches another's allowance.
  runtime.onTabClosed = (tabId: string) => {
    for (const entry of active.values()) {
      entry.rateLimiter.forgetTab(tabId);
    }
  };

  const sessions = new SessionRegistry({
    onCreate: (s) => {
      void runtime.logger.write({
        dir: "system",
        event: "session_create",
        session_id: s.id,
        name: s.name,
        color: s.color,
      });
    },
    onDestroy: (s) => {
      void runtime.logger.write({
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
    logger: runtime.logger,
    handlers: {
      onSession: async (conn, register) => {
        const session = sessions.create(register.client_info);
        try {
          const entry = await attachMcpSession(conn, session, runtime);
          active.set(session.id, entry);
          conn.onClose(async (reason) => {
            const e = active.get(session.id);
            if (e) {
              active.delete(session.id);
              try { await e.mcp.stop(); } catch { /* ignore */ }
            }
            sessions.destroy(session.id);
            void runtime.logger.write({
              dir: "system",
              event: "session_socket_closed",
              session_id: session.id,
              reason,
            });
          });
          return session;
        } catch (err) {
          sessions.destroy(session.id);
          throw err;
        }
      },
    },
  });
  await socket.start();
  process.stderr.write(`browserops-daemon: listening on ${socketPath} (pid ${process.pid})\n`);

  const shutdown = (reason: string): void => {
    void (async () => {
      await runtime.logger.write({ dir: "system", event: "daemon_shutdown", reason });
      // Tear down active sessions first so MCP servers don't try to send
      // responses through a half-closed socket.
      for (const [, entry] of active) {
        try { await entry.mcp.stop(); } catch { /* ignore */ }
      }
      active.clear();
      try { await socket.stop(); } catch { /* ignore */ }
      try { await runtime.shutdown(); } catch { /* ignore */ }
      await releasePidfile(pidfile);
      await bootLogger.close();
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function attachMcpSession(
  conn: ShimConnection,
  session: DaemonSession,
  runtime: DaemonRuntime,
): Promise<ActiveSession> {
  // Per-session rate limiter: bursts in one session never throttle
  // another. Caps are sourced from the same env vars the legacy bridge
  // honoured (BROWSEROPS_GLOBAL_CAP), so existing operator config
  // continues to apply — just per-session rather than process-wide.
  const globalCap = Number.parseInt(
    process.env[ENV.GLOBAL_CAP] ?? String(RATE_LIMIT_GLOBAL_PER_MIN_DEFAULT),
    10,
  );
  const rateLimiter = new RateLimiter(RATE_LIMIT_PER_TAB_PER_MIN, globalCap);

  const transport = new SocketServerTransport(conn, session.id);
  const mcp = new McpBridgeServer({
    wsBridge: runtime.wsBridge,
    rateLimiter,
    safety: runtime.safety,
    tabs: runtime.tabs,
    logger: runtime.logger,
    version: runtime.version,
    sessionId: session.id,
    teachStore: runtime.teachStore,
    enabledFeatures: runtime.enabledFeatures.current,
    traceWriter: runtime.traceWriter,
    gatedMatcher: runtime.gatedMatcher,
  });
  await mcp.start(transport);
  void runtime.logger.write({
    dir: "system",
    event: "session_mcp_ready",
    session_id: session.id,
  });
  return { session, mcp, transport, rateLimiter };
}

function applyDaemonCliFlags(argv: readonly string[]): void {
  const approvalArg = argv.find((a) => a.startsWith("--approval="));
  if (approvalArg) {
    const mode = approvalArg.slice("--approval=".length);
    if (mode === "auto" || mode === "gate") {
      process.env[ENV.APPROVAL] = mode;
    }
  }
  if (argv.includes("--trace")) {
    process.env[ENV.TRACE] = "1";
  }
  const traceDirArg = argv.find((a) => a.startsWith("--trace-dir="));
  if (traceDirArg) {
    process.env[ENV.TRACE_DIR] = traceDirArg.slice("--trace-dir=".length);
  }
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
