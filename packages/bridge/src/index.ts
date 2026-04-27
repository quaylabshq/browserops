#!/usr/bin/env node
import {
  DEFAULT_WS_HOST,
  DEFAULT_WS_PORT,
  ENV,
  RATE_LIMIT_GLOBAL_PER_MIN_DEFAULT,
  RATE_LIMIT_PER_TAB_PER_MIN,
} from "@browserops/shared";
import { createTraceWriter } from "./trace-writer.js";
import { ControlClient } from "./control-client.js";
import { ControlServer } from "./control-server.js";
import { Logger, type LogLevel } from "./logger.js";
import { McpBridgeServer } from "./mcp-server.js";
import { controlSocketPath } from "./paths.js";
import { RateLimiter } from "./rate-limiter.js";
import { RemoteWSBridge } from "./remote-ws-bridge.js";
import { loadRiskyDomainMatcher } from "./risky-domains.js";
import { Safety } from "./safety.js";
import { TabRegistry, type TabRecord } from "./tab-registry.js";
import { loadOrCreateToken } from "./token.js";
import { WSBridge } from "./ws-server.js";
import { ensureIndex } from "./procedures/index-builder.js";
import { proceduresRoot } from "./procedures/paths.js";
import { seedBundledProcedures } from "./procedures/seed.js";
import { runInit } from "./cli-init.js";
import { TeachSessionStore } from "./teach/session-store.js";
import type { TeachEvent } from "@browserops/shared";

const VERSION = "0.0.4";

async function main(): Promise<void> {
  installProcessErrorHandlers();

  const argv = process.argv.slice(2);

  // Subcommand: `init` runs scaffolding and exits — never opens the WS port
  // or attaches to the MCP stdio transport.
  if (argv[0] === "init") {
    await runInit();
    process.exit(0);
  }

  applyCliFlags(argv);

  // Opt-in trace writer. Must be created before any shutdown handlers so
  // close() is available everywhere below.
  const traceEnv = process.env[ENV.TRACE];
  const traceWriter = createTraceWriter({
    enabled: traceEnv === "1" || traceEnv === "true",
    dir: process.env[ENV.TRACE_DIR] ?? undefined,
  });

  const logLevel = parseLogLevel(process.env[ENV.LOG_LEVEL]);
  const logger = new Logger(logLevel);
  await logger.write({ dir: "system", event: "boot", version: VERSION });

  const host = process.env[ENV.HOST] ?? DEFAULT_WS_HOST;
  const port = Number.parseInt(process.env[ENV.PORT] ?? String(DEFAULT_WS_PORT), 10);
  const allowedExtensionId = process.env[ENV.EXTENSION_ID] ?? "";
  const globalCap = Number.parseInt(
    process.env[ENV.GLOBAL_CAP] ?? String(RATE_LIMIT_GLOBAL_PER_MIN_DEFAULT),
    10,
  );

  const riskyMatcher = await loadRiskyDomainMatcher();
  const tabs = new TabRegistry();
  const rateLimiter = new RateLimiter(RATE_LIMIT_PER_TAB_PER_MIN, globalCap);
  const teachStore = new TeachSessionStore();
  const sockPath = controlSocketPath();

  // ---------------------------------------------------------------------
  // Role selection. Primary = owns WS port + control socket. Secondary =
  // proxies extension traffic through the primary's control socket.
  // ---------------------------------------------------------------------

  let controlServer: ControlServer | undefined;
  let controlClient: ControlClient | undefined;
  let wsBridge: WSBridge | undefined;
  let role: "primary" | "secondary";

  const primaryToken = await tryAsPrimary();
  if (primaryToken.ok) {
    role = "primary";
    wsBridge = primaryToken.wsBridge;
    controlServer = primaryToken.controlServer;
  } else {
    const secondaryAttempt = await tryAsSecondary(sockPath, logger, tabs, rateLimiter);
    if (!secondaryAttempt.ok) {
      process.stderr.write(
        `browserops: fatal: port ${port} is in use but control socket ${sockPath} is not reachable ` +
          `(${secondaryAttempt.error}). Another bridge — possibly an older version without ` +
          `multi-session support — is running. Stop it and retry.\n`,
      );
      process.exit(1);
    }
    role = "secondary";
    controlClient = secondaryAttempt.client;
  }

  const wsLike = role === "primary" ? wsBridge! : new RemoteWSBridge(controlClient!);
  const confirmation =
    role === "primary" ? wsBridge!.confirmation : (wsLike as RemoteWSBridge).confirmation;
  const safety = new Safety(riskyMatcher, confirmation, logger, traceWriter);

  // Seed bundled examples into the user's procedures dir if absent. Failures
  // are logged but never fatal — a broken seed must not block boot.
  try {
    const seedReport = await seedBundledProcedures();
    if (seedReport.copied.length > 0) {
      await logger.write({
        dir: "system",
        event: "procedures_seeded",
        copied: seedReport.copied,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`browserops: warn: procedure seed failed: ${msg}\n`);
  }

  // Ensure procedure index is up-to-date before starting the MCP server.
  // A broken procedure tree must not prevent the bridge from starting.
  try {
    await ensureIndex(proceduresRoot());
    await logger.write({ dir: "system", event: "procedure_index_ready" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`browserops: warn: failed to build procedure index: ${msg}\n`);
  }

  const mcp = new McpBridgeServer({
    wsBridge: wsLike,
    rateLimiter,
    safety,
    tabs,
    logger,
    version: VERSION,
    teachStore,
    traceWriter,
  });

  process.stderr.write(
    role === "primary"
      ? `browserops: primary — listening on ws://${host}:${port}, control ${sockPath}\n`
      : `browserops: secondary — forwarding through ${sockPath}\n`,
  );

  // Log approval mode.
  const approvalMode = process.env[ENV.APPROVAL] === "gate" ? "GATE" : "AUTO";
  if (approvalMode === "GATE") {
    process.stderr.write(
      `[browserops] running in GATE mode — risky actions require approval\n`,
    );
  } else {
    process.stderr.write(
      `[browserops] running in AUTO mode — risky actions auto-approved. Re-enable gating with --approval=gate.\n`,
    );
  }

  if (role === "primary" && wsBridge) {
    process.stderr.write(
      `browserops: pair code ${wsBridge.pairCode} — enter this in the extension onboarding page\n`,
    );
  }

  await mcp.start();

  const shutdown = (reason: string): void => {
    void (async () => {
      await logger.write({ dir: "system", event: "shutdown", reason, role });
      try { await mcp.stop(); } catch { /* ignore */ }
      if (controlServer) {
        try { await controlServer.stop(); } catch { /* ignore */ }
      }
      if (controlClient) {
        try { controlClient.close(); } catch { /* ignore */ }
      }
      if (wsBridge) {
        try { await wsBridge.stop(); } catch { /* ignore */ }
      }
      await logger.close();
      try { await traceWriter.close(); } catch { /* ignore */ }
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // Tear down on stdin EOF only when the bridge is acting as an MCP stdio
  // server for a parent client. When BROWSEROPS_DAEMON=1, the CLI orchestrator
  // spawned us with stdio:ignore (i.e. /dev/null on stdin) — the immediate EOF
  // would otherwise kill the daemon a millisecond after it bound the port.
  if (process.env["BROWSEROPS_DAEMON"] !== "1") {
    process.stdin.on("end", () => shutdown("stdin_closed"));
  }
  process.on("beforeExit", () => {
    void traceWriter.close();
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function tryAsPrimary(): Promise<
    | { ok: true; wsBridge: WSBridge; controlServer: ControlServer }
    | { ok: false; reason: "port_in_use" | "other"; error: unknown }
  > {
    const token = await loadOrCreateToken();
    const bridge = new WSBridge({
      host,
      port,
      allowedExtensionId,
      token,
      bridgeVersion: VERSION,
      logger,
      onEvent: (name, payload) => {
        if (name === "teach_event") {
          const ev = payload as unknown as TeachEvent;
          teachStore.appendEvent(ev).catch((err: unknown) => {
            void logger.write({
              dir: "system",
              event: "teach_append_failed",
              error: err instanceof Error ? err.message : String(err),
            });
          });
          if (controlServer) controlServer.broadcastEvent(name, payload);
          return;
        }
        const minted = handleEvent(name, payload, tabs, rateLimiter, logger);
        if (minted) {
          // Close the loop with the extension: it's polling its chromeIdToTabId
          // map waiting for this assignment (packages/extension/.../tabs.ts).
          bridge
            .callExtension(
              "assign_tab_id",
              { chrome_tab_id: minted.chrome_tab_id, tab_id: minted.tab_id },
              5_000,
            )
            .catch((err: unknown) =>
              void logger.write({
                dir: "system",
                event: "assign_tab_id_failed",
                tab_id: minted.tab_id,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
        }
        if (controlServer) {
          const aug = minted ? { ...payload, tab_id: minted.tab_id } : payload;
          controlServer.broadcastEvent(name, aug);
        }
      },
      onConnectionChange: (connected) => {
        if (controlServer) controlServer.broadcastConn(connected);
      },
    });
    try {
      await bridge.start();
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "EADDRINUSE") return { ok: false, reason: "port_in_use", error: err };
      return { ok: false, reason: "other", error: err };
    }
    const server = new ControlServer({
      socketPath: sockPath,
      wsBridge: bridge,
      bridgeVersion: VERSION,
      logger,
    });
    try {
      await server.start();
    } catch (err) {
      // Tear down WS — partial start.
      await bridge.stop().catch(() => { /* ignore */ });
      throw err;
    }
    return { ok: true, wsBridge: bridge, controlServer: server };
  }
}

async function tryAsSecondary(
  sockPath: string,
  logger: Logger,
  tabs: TabRegistry,
  rateLimiter: RateLimiter,
): Promise<{ ok: true; client: ControlClient } | { ok: false; error: string }> {
  const client = new ControlClient({
    socketPath: sockPath,
    logger,
    onEvent: (name, payload) => handleEvent(name, payload, tabs, rateLimiter, logger),
    onDisconnect: () => {
      void logger.write({ dir: "system", event: "control_lost", role: "secondary" });
      // Primary went away. The extension channel is gone for us — exit so the
      // parent MCP client sees a clean stdio close and can respawn.
      process.stderr.write("browserops: primary bridge disappeared; exiting\n");
      process.exit(0);
    },
  });
  try {
    const hello = await client.connect();
    await logger.write({
      dir: "system",
      event: "secondary_connected",
      primary_version: hello.bridge_version,
      extension_connected: hello.connected,
    });
    return { ok: true, client };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseLogLevel(v: string | undefined): LogLevel {
  return v === "audit" ? "audit" : "normal";
}

/**
 * --approval=auto|gate: control risky-action approval mode.
 *   auto (default): auto-approve all risky actions
 *   gate: require user approval for risky actions
 *
 * --yolo, --autoconfirm: deprecated no-op aliases (auto-approve is now the default).
 * --trace: enable trace recording. Sets BROWSEROPS_TRACE=1 so the trace
 * writer picks it up. Optionally --trace-dir=<path> overrides the output dir.
 */
function applyCliFlags(argv: readonly string[]): void {
  // Parse --approval=auto|gate
  const approvalArg = argv.find((a) => a.startsWith("--approval="));
  if (approvalArg) {
    const mode = approvalArg.slice("--approval=".length);
    if (mode === "auto" || mode === "gate") {
      process.env[ENV.APPROVAL] = mode;
    }
  }

  // --yolo and --autoconfirm are now no-op aliases (auto is the default)
  if (argv.includes("--yolo") || argv.includes("--autoconfirm")) {
    process.stderr.write("[browserops] --yolo and --autoconfirm are now the default; ignoring.\n");
  }

  if (argv.includes("--trace")) {
    process.env[ENV.TRACE] = "1";
  }
  const traceDirArg = argv.find((a) => a.startsWith("--trace-dir="));
  if (traceDirArg) {
    process.env[ENV.TRACE_DIR] = traceDirArg.slice("--trace-dir=".length);
  }
}

/**
 * Process a `ws_event` envelope. Returns the newly-minted TabRecord for
 * `tab_created` events — the caller (primary) uses it to send `assign_tab_id`
 * back to the extension and to decorate the broadcast payload.
 */
function handleEvent(
  name: string,
  payload: Record<string, unknown>,
  tabs: TabRegistry,
  rateLimiter: RateLimiter,
  logger: Logger,
): TabRecord | undefined {
  void logger.write({ dir: "ws_event", method: name, payload });

  switch (name) {
    case "tab_created": {
      const chromeId = numberField(payload, "chrome_tab_id");
      if (chromeId == null) return undefined;
      const partial = {
        url: stringField(payload, "url") ?? "",
        active: boolField(payload, "active") ?? false,
        window_id: numberField(payload, "window_id") ?? -1,
      };
      // If the primary injected its authoritative tab_id into the broadcast,
      // use it; otherwise mint locally (primary path).
      const injected = stringField(payload, "tab_id");
      if (injected) {
        tabs.inject(chromeId, injected, partial);
        return undefined;
      }
      return tabs.mint(chromeId, partial);
    }
    case "tab_closed": {
      const tabId = stringField(payload, "tab_id");
      if (tabId) {
        tabs.remove(tabId);
        rateLimiter.forgetTab(tabId);
      }
      return undefined;
    }
    case "tab_updated":
    case "page_navigated":
    case "page_loaded": {
      const tabId = stringField(payload, "tab_id");
      if (!tabId) return undefined;
      const patch: Partial<TabRecord> = {};
      const url = stringField(payload, "url");
      if (url !== undefined) patch.url = url;
      const title = stringField(payload, "title");
      if (title !== undefined) patch.title = title;
      const active = boolField(payload, "active");
      if (active !== undefined) patch.active = active;
      tabs.update(tabId, patch);
      return undefined;
    }
    default:
      return undefined;
  }
}

function stringField(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" ? v : undefined;
}

function numberField(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" ? v : undefined;
}

function boolField(o: Record<string, unknown>, k: string): boolean | undefined {
  const v = o[k];
  return typeof v === "boolean" ? v : undefined;
}

function installProcessErrorHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    process.stderr.write(`browserops: unhandledRejection: ${msg}\n`);
  });
  process.on("uncaughtException", (err) => {
    process.stderr.write(`browserops: uncaughtException: ${err.stack ?? err.message}\n`);
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`browserops: fatal: ${msg}\n`);
  process.exit(1);
});
