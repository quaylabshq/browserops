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
import {
  buildCommonProps,
  captureEvent,
  initTelemetry,
  type PostHogHttpClient,
} from "./telemetry/index.js";

const VERSION = "0.0.9";
const TELEMETRY_DRAIN_MS = 1_500;

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

  const startedAtMs = Date.now();
  const telemetry: PostHogHttpClient | null = await initTelemetry({ bridgeVersion: VERSION })
    .then((r) => r.client)
    .catch(() => null);
  const common = buildCommonProps({ bridgeVersion: VERSION });
  let totalSessions = 0;

  captureEvent(
    telemetry,
    "root.daemon_started",
    {
      approval_mode: process.env[ENV.APPROVAL] === "gate" ? "gate" : "auto",
      enabled_features: [...runtime.enabledFeatures.current],
      extension_connected: runtime.wsBridge.isConnected(),
    },
    common,
  );

  const active = new Map<string, ActiveSession>();

  // The side panel obtains authoritative detail from /chat/agents, while this
  // reverse RPC lets the extension immediately invalidate its cached health
  // when an MCP subprocess connects or exits. This makes the extension ↔ MCP
  // relationship explicitly bidirectional instead of inferring it from a
  // provider binary or PID.
  const publishMcpHealth = (): void => {
    if (!runtime.wsBridge.isConnected()) return;
    runtime.wsBridge
      .callExtension(
        "mcp_connection_state",
        { providers: runtime.mcpConnections.snapshot() },
        3_000,
      )
      .catch(
        (err: unknown) =>
          void runtime.logger.write({
            dir: "system",
            event: "mcp_health_publish_failed",
            error: err instanceof Error ? err.message : String(err),
          }),
      );
  };

  // Fan tab_closed → forgetTab across every active session's bucket so a
  // closed tab can't continue eating quota. Buckets are otherwise fully
  // isolated: one session's burst never touches another's allowance.
  runtime.onTabClosed = (tabId: string) => {
    for (const entry of active.values()) {
      entry.rateLimiter.forgetTab(tabId);
    }
  };

  const broadcast = (method: string, params: Record<string, unknown>): void => {
    if (!runtime.wsBridge.isConnected()) return;
    runtime.wsBridge.callExtension(method, params, 3_000).catch((err: unknown) => {
      // Extension may pre-date the session-group handlers — log and
      // keep going; nothing in the daemon's correctness depends on
      // the broadcast succeeding.
      void runtime.logger.write({
        dir: "system",
        event: "session_broadcast_failed",
        method,
        params,
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
      totalSessions += 1;
      captureEvent(
        telemetry,
        "root.session_started",
        {
          client_name: s.client_info.name || "unknown",
          client_version: s.client_info.version || "",
        },
        common,
      );
      broadcast("session_started", {
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
      broadcast("session_ended", { session_id: s.id });
    },
    onWarn: (m) => process.stderr.write(`[browserops-daemon] ${m}\n`),
  });

  // Mirror tab-ownership transitions into Chrome tab groups.
  runtime.tabs.onClaim((rec, sessionId) => {
    broadcast("claim_tab", {
      session_id: sessionId,
      chrome_tab_id: rec.chrome_tab_id,
    });
  });
  runtime.tabs.onRelease((rec) => {
    broadcast("release_tab", {
      chrome_tab_id: rec.chrome_tab_id,
    });
  });

  // When the extension reconnects (cold start, restart, reload), replay
  // session_started + claim_tab so its tab-groups view matches the
  // daemon's ownership model. The legacy WSBridge already exposes
  // onConnectionChange via the bootDaemonRuntime callback path; we
  // hook it here by wrapping the existing pair-broadcast.
  const replaySessionState = (): void => {
    for (const s of sessions.list()) {
      broadcast("session_started", { session_id: s.id, name: s.name, color: s.color });
    }
    for (const rec of runtime.tabs.list()) {
      if (rec.owner_session_id !== null) {
        broadcast("claim_tab", {
          session_id: rec.owner_session_id,
          chrome_tab_id: rec.chrome_tab_id,
        });
      }
    }
  };
  runtime.onExtensionReady(replaySessionState);
  runtime.onExtensionReady(publishMcpHealth);

  const socketPath = daemonSocketPath();
  const socket = new DaemonSocketServer({
    socketPath,
    logger: runtime.logger,
    handlers: {
      onSession: async (conn, register) => {
        const session = sessions.create(register.client_info);
        try {
          const renameSession = (name: string): string | undefined => {
            const updated = sessions.rename(session.id, name);
            if (!updated) return undefined;
            broadcast("session_renamed", {
              session_id: updated.id,
              name: updated.name,
              color: updated.color,
            });
            return updated.name;
          };
          const entry = await attachMcpSession(conn, session, runtime, renameSession);
          active.set(session.id, entry);
          runtime.mcpConnections.markConnected(session.id, session.client_info.name);
          publishMcpHealth();
          conn.onClose(async (reason) => {
            const e = active.get(session.id);
            if (e) {
              active.delete(session.id);
              try {
                await e.mcp.stop();
              } catch {
                /* ignore */
              }
            }
            runtime.mcpConnections.markDisconnected(session.id);
            publishMcpHealth();
            // Orphan this session's claimed tabs back to user-owned
            // BEFORE destroying the session. The release_tab broadcast
            // resets each tab's Chrome group; the subsequent
            // session_ended cleans up the now-empty group.
            runtime.tabs.releaseAll(session.id);
            captureEvent(
              telemetry,
              "root.session_ended",
              {
                client_name: session.client_info.name || "unknown",
                duration_ms: Date.now() - session.created_at_ms,
              },
              common,
            );
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
      captureEvent(
        telemetry,
        "root.daemon_shutdown",
        {
          reason,
          uptime_ms: Date.now() - startedAtMs,
          total_sessions: totalSessions,
        },
        common,
      );
      // Tear down active sessions first so MCP servers don't try to send
      // responses through a half-closed socket.
      for (const [, entry] of active) {
        try {
          await entry.mcp.stop();
        } catch {
          /* ignore */
        }
      }
      active.clear();
      try {
        await socket.stop();
      } catch {
        /* ignore */
      }
      try {
        await runtime.shutdown();
      } catch {
        /* ignore */
      }
      try {
        await telemetry?.shutdown(TELEMETRY_DRAIN_MS);
      } catch {
        /* ignore */
      }
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
  renameSession: (name: string) => string | undefined,
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

  // BROWSEROPS_DISABLED_TOOLS: comma-separated tool names hidden from
  // tools/list and rejected at tools/call. Use to expose a minimal,
  // screenshot-first surface that mirrors browser-harness — set to e.g.
  // "browser_observe,browser_quick_read,browser_read,browser_query_selector,
  //  browser_describe_ref,browser_click_by_text,browser_find_and_replace".
  // Empty / unset means no extra hiding (default behaviour).
  const disabledToolsRaw = process.env["BROWSEROPS_DISABLED_TOOLS"] ?? "";
  const disabledTools = new Set(
    disabledToolsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

  const transport = new SocketServerTransport(conn, session.id);
  const mcp = new McpBridgeServer({
    wsBridge: runtime.wsBridge,
    rateLimiter,
    safety: runtime.safety,
    tabs: runtime.tabs,
    logger: runtime.logger,
    version: runtime.version,
    sessionId: session.id,
    enabledFeatures: runtime.enabledFeatures.current,
    disabledTools,
    traceWriter: runtime.traceWriter,
    renameSession,
    clientName: session.client_info.name,
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
