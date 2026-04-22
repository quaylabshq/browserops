import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode as McpErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import AjvModule from "ajv";
import type { ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import {
  TOOL_DEFS,
  TOOL_DEF_MAP,
  type ToolDef,
  DEFAULT_TOOL_TIMEOUT_MS,
  NAVIGATE_TIMEOUT_MS,
  WAIT_FOR_TIMEOUT_CAP_MS,
  type ErrorCode,
  isErrorCode,
} from "@browserops/shared";
import type { RateLimiter } from "./rate-limiter.js";
import type { Safety, TabInfo } from "./safety.js";
import type { TabRegistry } from "./tab-registry.js";
import type { Logger } from "./logger.js";

/**
 * Minimal shape McpBridgeServer needs to talk to the extension. Implemented
 * by {@link WSBridge} (primary) and RemoteWSBridge (secondary).
 */
export interface WSBridgeLike {
  isConnected(): boolean;
  callExtension<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
// Stdout hygiene: console shim.
// Redirect any stray console.log/info/debug to stderr so third-party libs
// can't corrupt the MCP JSON-RPC stream on stdout.
// ---------------------------------------------------------------------------

(function installConsoleShim(): void {
  const g = globalThis as { __browserops_console_shimmed?: boolean };
  if (g.__browserops_console_shimmed) return;
  g.__browserops_console_shimmed = true;

  let warned = false;
  const redirect = (method: string) => (...args: unknown[]): void => {
    if (!warned) {
      warned = true;
      try {
        process.stderr.write(
          `[browserops-bridge] console.${method} redirected to stderr (stdout is reserved for MCP)\n`,
        );
      } catch {
        /* ignore */
      }
    }
    try {
      const line = args
        .map((a) => (typeof a === "string" ? a : safeJson(a)))
        .join(" ");
      process.stderr.write(line + "\n");
    } catch {
      /* ignore */
    }
  };
  // Keep console.error/console.warn on stderr (their default) — only redirect
  // the ones that default to stdout.
  console.log = redirect("log");
  console.info = redirect("info");
  console.debug = redirect("debug");
})();

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "<unserializable>";
  }
}

// ---------------------------------------------------------------------------
// Ajv interop (CJS default export reached via ESM).
// ---------------------------------------------------------------------------

// Ajv and ajv-formats are CommonJS modules that expose their real export
// under `.default` when loaded from ESM. Normalise.
type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
type AddFormatsFn = (ajv: unknown) => unknown;

const Ajv: AjvCtor =
  ((AjvModule as unknown as { default?: AjvCtor }).default ?? (AjvModule as unknown as AjvCtor));
const addFormats: AddFormatsFn =
  ((addFormatsModule as unknown as { default?: AddFormatsFn }).default ??
    (addFormatsModule as unknown as AddFormatsFn));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpBridgeDeps {
  wsBridge: WSBridgeLike;
  rateLimiter: RateLimiter;
  safety: Safety;
  tabs: TabRegistry;
  logger: Logger;
  version: string;
}

interface ToolErrorPayload {
  code: ErrorCode | "INVALID_PARAMS";
  message: string;
  details?: unknown;
}

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError: boolean;
}

// ---------------------------------------------------------------------------
// McpBridgeServer
// ---------------------------------------------------------------------------

export class McpBridgeServer {
  private readonly deps: McpBridgeDeps;
  private readonly server: Server;
  private readonly validators = new Map<string, ValidateFunction>();
  private transport?: StdioServerTransport;

  constructor(deps: McpBridgeDeps) {
    this.deps = deps;

    const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
    addFormats(ajv);
    for (const def of TOOL_DEFS) {
      this.validators.set(def.name, ajv.compile(def.inputSchema));
    }

    this.server = new Server(
      { name: "browserops", version: deps.version },
      { capabilities: { tools: {} } },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFS.map((d) => ({
        name: d.name,
        description: d.description,
        // Anthropic's tool API rejects top-level oneOf/allOf/anyOf. Strip them
        // for the wire; ajv still enforces the full schema at dispatch time.
        inputSchema: stripTopLevelUnions(d.inputSchema),
        outputSchema: d.outputSchema,
      })),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const result = await this.dispatch(req, extra);
      // The SDK types the response as a union that includes a task-style
      // variant we don't emit; our shape matches the tool-result arm.
      return result as unknown as { content: Array<{ type: "text"; text: string }> };
    });
  }

  async start(): Promise<void> {
    this.transport = new StdioServerTransport();
    await this.server.connect(this.transport);
  }

  async stop(): Promise<void> {
    try {
      await this.server.close();
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch pipeline (see plans/01-mcp-server.md §4.5).
  // -------------------------------------------------------------------------

  private async dispatch(
    req: { params: { name: string; arguments?: Record<string, unknown> } },
    extra: { signal?: AbortSignal; requestId?: string | number },
  ): Promise<ToolCallResult> {
    const id = extra.requestId !== undefined ? String(extra.requestId) : randomId();
    const name = req.params.name;
    const params: Record<string, unknown> = req.params.arguments ?? {};

    await this.deps.logger.write({
      dir: "mcp_in",
      id,
      method: name,
      params: params as Record<string, unknown>,
    });

    // 2. Resolve tool def.
    const def = TOOL_DEF_MAP[name];
    if (!def) {
      throw new McpError(McpErrorCode.MethodNotFound, `unknown tool: ${name}`);
    }

    // 3. Validate params (no rate-limit consumption on invalid input).
    const validate = this.validators.get(name);
    if (!validate) {
      throw new McpError(McpErrorCode.InternalError, `no validator compiled for ${name}`);
    }
    if (!validate(params)) {
      const message = formatAjvErrors(validate.errors);
      return this.reply(id, name, toolError({ code: "INVALID_PARAMS", message }));
    }

    // 4. Look up tab info (optional).
    const tabIdRaw = params["tab_id"];
    const tabId = typeof tabIdRaw === "string" ? tabIdRaw : undefined;
    let tab: TabInfo | undefined;
    if (tabId) {
      const rec = this.deps.tabs.get(tabId);
      tab = rec ? { url: rec.url } : undefined;
    }

    // 5. Extension connectivity — short-circuit before charging.
    if (!this.deps.wsBridge.isConnected()) {
      return this.reply(
        id,
        name,
        toolError({
          code: "EXTENSION_DISCONNECTED",
          message: "no active extension connection",
        }),
      );
    }

    // 6. Rate limit.
    const charge = this.deps.rateLimiter.tryConsume(tabId ?? "_global", def.action_weight);
    if (!charge.ok) {
      return this.reply(
        id,
        name,
        toolError({
          code: "RATE_LIMITED",
          message: `rate limit exceeded (scope: ${charge.scope ?? "?"})`,
          details: { retry_after_ms: charge.retry_after_ms, scope: charge.scope },
        }),
      );
    }

    // 7. Risky-action gate.
    if (
      def.risky === "always" ||
      (def.risky === "conditional" && this.deps.safety.checkRisky({ tool: name, params, tab }).risky)
    ) {
      const verdict =
        def.risky === "always"
          ? { risky: true as const, reason: `${name} is always risky` }
          : this.deps.safety.checkRisky({ tool: name, params, tab });
      const reason = verdict.reason ?? `${name} requires approval`;
      const decision = await this.deps.safety.requireApproval({ tool: name, params, reason });
      if (!decision.allow) {
        return this.reply(
          id,
          name,
          toolError({ code: "RISKY_ACTION_DENIED", message: reason }),
        );
      }
    }

    // 8. Timeout.
    const timeoutMs = this.timeoutFor(def, params);

    // 9. Call extension (forward cancellation).
    try {
      const result = await this.deps.wsBridge.callExtension(
        def.name,
        params,
        timeoutMs,
        extra.signal,
      );
      return this.reply(id, name, toolOk(result));
    } catch (err) {
      const code = extractErrorCode(err);
      const message = err instanceof Error ? err.message : String(err);
      return this.reply(id, name, toolError({ code, message }));
    }
  }

  private timeoutFor(def: ToolDef, params: Record<string, unknown>): number {
    if (def.name === "browser.navigate") return NAVIGATE_TIMEOUT_MS;
    if (def.name === "browser.wait_for") {
      const raw = params["timeout_ms"];
      const provided = typeof raw === "number" ? raw : DEFAULT_TOOL_TIMEOUT_MS;
      return Math.min(provided, WAIT_FOR_TIMEOUT_CAP_MS);
    }
    return DEFAULT_TOOL_TIMEOUT_MS;
  }

  private async reply(
    id: string,
    method: string,
    result: ToolCallResult,
  ): Promise<ToolCallResult> {
    const base: Record<string, unknown> = {
      dir: "mcp_out",
      id,
      method,
      ok: !result.isError,
    };
    if (result.isError) {
      const sc = result.structuredContent as { error?: { code?: unknown } } | undefined;
      const code = sc?.error?.code;
      if (typeof code === "string") base["code"] = code;
    }
    await this.deps.logger.write(base as Omit<Parameters<Logger["write"]>[0], "ts">);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolOk(result: unknown): ToolCallResult {
  const text = typeof result === "string" ? result : safeJson(result);
  return {
    content: [{ type: "text", text }],
    structuredContent: result as Record<string, unknown> | undefined,
    isError: false,
  };
}

function toolError(payload: ToolErrorPayload): ToolCallResult {
  return {
    content: [{ type: "text", text: safeJson(payload) }],
    structuredContent: { error: payload },
    isError: true,
  };
}

function extractErrorCode(err: unknown): ErrorCode {
  if (err && typeof err === "object") {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string" && isErrorCode(c)) return c;
    const name = (err as { name?: unknown }).name;
    if (name === "AbortError") return "INTERNAL";
  }
  return "INTERNAL";
}

function formatAjvErrors(
  errors: ValidateFunction["errors"] | null | undefined,
): string {
  if (!errors || errors.length === 0) return "invalid params";
  return errors
    .map((e) => {
      const path = e.instancePath || "(root)";
      return `${path} ${e.message ?? "invalid"}`;
    })
    .join("; ");
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

function stripTopLevelUnions(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === "oneOf" || k === "anyOf" || k === "allOf") continue;
    out[k] = v;
  }
  return out;
}
