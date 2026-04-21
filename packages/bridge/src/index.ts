#!/usr/bin/env node
import {
  DEFAULT_WS_HOST,
  DEFAULT_WS_PORT,
  ENV,
  RATE_LIMIT_GLOBAL_PER_MIN_DEFAULT,
  RATE_LIMIT_PER_TAB_PER_MIN,
} from "@browserops/shared";
import { Logger, type LogLevel } from "./logger.js";
import { McpBridgeServer } from "./mcp-server.js";
import { RateLimiter } from "./rate-limiter.js";
import { loadRiskyDomainMatcher } from "./risky-domains.js";
import { Safety } from "./safety.js";
import { TabRegistry, type TabRecord } from "./tab-registry.js";
import { loadOrCreateToken } from "./token.js";
import { WSBridge } from "./ws-server.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  installProcessErrorHandlers();

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

  const token = await loadOrCreateToken();
  const riskyMatcher = await loadRiskyDomainMatcher();

  const tabs = new TabRegistry();
  const rateLimiter = new RateLimiter(RATE_LIMIT_PER_TAB_PER_MIN, globalCap);

  const wsBridge = new WSBridge({
    host,
    port,
    allowedExtensionId,
    token,
    bridgeVersion: VERSION,
    logger,
    onEvent: (name, payload) => handleEvent(name, payload, tabs, rateLimiter, logger),
  });

  const safety = new Safety(riskyMatcher, wsBridge.confirmation, logger);

  const mcp = new McpBridgeServer({
    wsBridge,
    rateLimiter,
    safety,
    tabs,
    logger,
    version: VERSION,
  });

  await wsBridge.start();
  process.stderr.write(`browserops: listening on ws://${host}:${port}\n`);
  await mcp.start();

  const shutdown = (reason: string): void => {
    void (async () => {
      await logger.write({ dir: "system", event: "shutdown", reason });
      try {
        await mcp.stop();
      } catch {
        // ignore
      }
      try {
        await wsBridge.stop();
      } catch {
        // ignore
      }
      await logger.close();
      process.exit(0);
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.on("end", () => shutdown("stdin_closed"));
}

function parseLogLevel(v: string | undefined): LogLevel {
  return v === "audit" ? "audit" : "normal";
}

function handleEvent(
  name: string,
  payload: Record<string, unknown>,
  tabs: TabRegistry,
  rateLimiter: RateLimiter,
  logger: Logger,
): void {
  void logger.write({ dir: "ws_event", method: name, payload });

  switch (name) {
    case "tab_created": {
      const chromeId = numberField(payload, "chrome_tab_id");
      if (chromeId == null) return;
      tabs.mint(chromeId, {
        url: stringField(payload, "url") ?? "",
        active: boolField(payload, "active") ?? false,
        window_id: numberField(payload, "window_id") ?? -1,
      });
      return;
    }
    case "tab_closed": {
      const tabId = stringField(payload, "tab_id");
      if (tabId) {
        tabs.remove(tabId);
        rateLimiter.forgetTab(tabId);
      }
      return;
    }
    case "tab_updated":
    case "page_navigated":
    case "page_loaded": {
      const tabId = stringField(payload, "tab_id");
      if (!tabId) return;
      const patch: Partial<TabRecord> = {};
      const url = stringField(payload, "url");
      if (url !== undefined) patch.url = url;
      const title = stringField(payload, "title");
      if (title !== undefined) patch.title = title;
      const active = boolField(payload, "active");
      if (active !== undefined) patch.active = active;
      tabs.update(tabId, patch);
      return;
    }
    default:
      return;
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
