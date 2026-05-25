/**
 * Shared runtime the daemon boots once and reuses across every shim
 * session. Mirrors the singleton state the legacy bridge entry built
 * (WSBridge, TabRegistry, Safety, procedures, features, etc.) without
 * the primary/secondary role-election dance — the daemon is always
 * the sole owner of the WS port.
 *
 * Per-session state (per-MCP-client RateLimiter, future per-session
 * tab views, the actual McpBridgeServer instance) lives outside of
 * this module — see daemon.ts.
 */
import {
  DEFAULT_WS_HOST,
  DEFAULT_WS_PORT,
  ENV,
  type FeatureName,
} from "@browserops/shared";
import { createTraceWriter, type TraceWriter } from "./trace-writer.js";
import { Logger, type LogLevel } from "./logger.js";
import { loadRiskyDomainMatcher, type RiskyDomainMatcher } from "./risky-domains.js";
import { Safety } from "./safety.js";
import { TabRegistry, type TabRecord } from "./tab-registry.js";
import { loadOrCreateToken } from "./token.js";
import { WSBridge } from "./ws-server.js";
import { ensureIndex } from "./procedures/index-builder.js";
import { proceduresRoot } from "./procedures/paths.js";
import { loadConfigFeatures } from "./config.js";
import { SiteContextManager } from "./memory/delivery.js";
import { listRecords } from "./memory/store.js";
import { confidence } from "./memory/confidence.js";

export interface DaemonRuntime {
  version: string;
  logger: Logger;
  traceWriter: TraceWriter;
  wsBridge: WSBridge;
  tabs: TabRegistry;
  safety: Safety;
  enabledFeatures: { current: Set<FeatureName> };
  riskyMatcher: RiskyDomainMatcher;
  pairCode: string;
  /**
   * Mutable fan-out point invoked when the extension reports a closed
   * tab. The daemon registers a handler that walks every active
   * session's RateLimiter and calls forgetTab. Defaults to a no-op so
   * the runtime is usable from tests without rate-limit accounting.
   */
  onTabClosed: (tabId: string) => void;
  /**
   * Register a callback to run every time the extension transitions
   * from disconnected → connected. The daemon uses this to replay
   * session_started + claim_tab so the extension's tab-groups view
   * recovers cold starts and reconnects.
   */
  onExtensionReady(handler: () => void): void;
  /**
   * Daemon-lifetime SiteContextManager for hybrid memory delivery (Phase 6).
   * Warmed on page_navigated; consulted by each McpBridgeServer on dispatch.
   */
  siteContext: SiteContextManager;
  /**
   * Pre-computed global memory digest (≤10 title lines, confidence-ranked).
   * Computed once at daemon boot and threaded into each McpBridgeServer so
   * the initialize instructions carry global memory context.
   */
  globalDigest: string;
  shutdown(): Promise<void>;
}

export interface BootDaemonRuntimeOptions {
  version: string;
}

export async function bootDaemonRuntime(opts: BootDaemonRuntimeOptions): Promise<DaemonRuntime> {
  const traceEnv = process.env[ENV.TRACE];
  const traceWriter = createTraceWriter({
    enabled: traceEnv === "1" || traceEnv === "true",
    dir: process.env[ENV.TRACE_DIR] ?? undefined,
  });

  const logLevel = parseLogLevel(process.env[ENV.LOG_LEVEL]);
  const logger = new Logger(logLevel);
  await logger.write({ dir: "system", event: "daemon_runtime_boot", version: opts.version });

  const host = process.env[ENV.HOST] ?? DEFAULT_WS_HOST;
  const port = Number.parseInt(process.env[ENV.PORT] ?? String(DEFAULT_WS_PORT), 10);
  const allowedExtensionId = process.env[ENV.EXTENSION_ID] ?? "";

  const riskyMatcher = await loadRiskyDomainMatcher();
  const tabs = new TabRegistry();

  // Mutable hook the daemon overrides post-construction with a fan-out
  // across every active session's per-session RateLimiter.
  const hooks: { onTabClosed: (tabId: string) => void } = { onTabClosed: () => { /* noop */ } };
  const extensionReadyListeners: Array<() => void> = [];
  let lastExtensionConnected = false;

  const siteContext = new SiteContextManager();

  const enabledFeatures: { current: Set<FeatureName> } = { current: new Set() };
  try {
    const resolved = await loadConfigFeatures();
    enabledFeatures.current = resolved.enabled;
    if (resolved.unknownEnv.length > 0) {
      process.stderr.write(
        `[browserops] BROWSEROPS_FEATURES contains unknown name(s): ${resolved.unknownEnv.join(", ")} — ignored\n`,
      );
    }
    await logger.write({
      dir: "system",
      event: "features_loaded",
      source: resolved.source,
      enabled: [...resolved.enabled],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[browserops] warn: failed to load features: ${msg} — using defaults\n`);
  }

  const token = await loadOrCreateToken();
  const wsBridge = new WSBridge({
    host,
    port,
    allowedExtensionId,
    token,
    bridgeVersion: opts.version,
    logger,
    onEvent: (name, payload) => {
      const minted = handleEvent(name, payload, tabs, hooks.onTabClosed, logger, siteContext);
      if (minted) {
        wsBridge
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
    },
    onConnectionChange: (connected) => {
      const wasConnected = lastExtensionConnected;
      lastExtensionConnected = connected;
      if (connected && !wasConnected) {
        for (const fn of extensionReadyListeners) {
          try { fn(); } catch { /* ignore */ }
        }
      }
    },
    getFeatures: () => [...enabledFeatures.current],
  });

  await wsBridge.start();
  const safety = new Safety(riskyMatcher, wsBridge.confirmation, logger, traceWriter);

  if (enabledFeatures.current.has("procedures")) {
    try {
      await ensureIndex(proceduresRoot());
      await logger.write({ dir: "system", event: "procedure_index_ready" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`browserops: warn: failed to build procedure index: ${msg}\n`);
    }
  }

  // 6.4 — compute the global memory digest once at boot.
  const globalDigest = await computeGlobalDigest();

  const approvalMode = process.env[ENV.APPROVAL] === "gate" ? "GATE" : "AUTO";
  if (approvalMode === "GATE") {
    process.stderr.write(
      `[browserops-daemon] running in GATE mode — risky actions require approval\n`,
    );
  } else {
    process.stderr.write(
      `[browserops-daemon] running in AUTO mode — risky actions auto-approved\n`,
    );
  }

  process.stderr.write(
    `[browserops-daemon] WS listening on ws://${host}:${port}; pair code ${wsBridge.pairCode}\n`,
  );

  const runtime: DaemonRuntime = {
    version: opts.version,
    logger,
    traceWriter,
    wsBridge,
    tabs,
    safety,
    enabledFeatures,
    riskyMatcher,
    pairCode: wsBridge.pairCode,
    siteContext,
    globalDigest,
    get onTabClosed() {
      return hooks.onTabClosed;
    },
    set onTabClosed(handler: (tabId: string) => void) {
      hooks.onTabClosed = handler;
    },
    onExtensionReady(handler: () => void): void {
      extensionReadyListeners.push(handler);
      // If the extension is already connected by the time the daemon
      // wires up its listeners (legitimate at boot when the bridge
      // resumes a previously-active extension), fire immediately.
      if (lastExtensionConnected) {
        try { handler(); } catch { /* ignore */ }
      }
    },
    shutdown: async () => {
      try { await wsBridge.stop(); } catch { /* ignore */ }
      try { await traceWriter.close(); } catch { /* ignore */ }
      await logger.close();
    },
  };
  return runtime;
}

function parseLogLevel(v: string | undefined): LogLevel {
  return v === "audit" ? "audit" : "normal";
}

function handleEvent(
  name: string,
  payload: Record<string, unknown>,
  tabs: TabRegistry,
  onTabClosed: (tabId: string) => void,
  logger: Logger,
  siteContext?: SiteContextManager,
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
        onTabClosed(tabId);
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

      // 6.2 — warm SiteContextManager on navigation so primer data is ready
      // before the first tool call hits the new origin.
      if (name === "page_navigated" && url && siteContext) {
        let origin: string | undefined;
        try { origin = new URL(url).origin; } catch { /* not a URL */ }
        if (origin && origin !== "null") {
          const ctx = siteContext;
          const org = origin;
          listRecords({ scope: "site", origin: org }).then(
            (records) => ctx.warm(org, records),
            () => { /* best-effort */ },
          );
        }
      }

      return undefined;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Global memory digest helper (Phase 6.4)
// ---------------------------------------------------------------------------

/** Maximum number of global records shown in the digest. */
const GLOBAL_DIGEST_MAX = 10;

/**
 * Compute a terse, confidence-ranked digest of global memory records.
 * Returns a multi-line string (one record per line: "- [kind] title")
 * or an empty string when there are no global records or on error.
 */
async function computeGlobalDigest(): Promise<string> {
  try {
    const records = await listRecords({ scope: "global" });
    if (records.length === 0) return "";

    const ranked = records
      .map((r) => ({ r, conf: confidence(r) }))
      .sort((a, b) => b.conf - a.conf)
      .slice(0, GLOBAL_DIGEST_MAX);

    return ranked
      .map(({ r }) => `- [${r.kind}] ${r.title}  (${r.name})`)
      .join("\n");
  } catch {
    return "";
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
