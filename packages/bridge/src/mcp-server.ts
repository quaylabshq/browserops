import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
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
  type FeatureName,
  isErrorCode,
  type TraceEvent,
} from "@browserops/shared";
import type { RateLimiter } from "./rate-limiter.js";
import type { Safety, TabInfo } from "./safety.js";
import type { TabRecord, TabRegistry } from "./tab-registry.js";
import type { Logger } from "./logger.js";
import type { TraceWriter } from "./trace-writer.js";
import { buildProcedureHandlers } from "./procedures/handlers.js";
import { LORE_HANDLERS } from "./lore/handlers.js";
import { buildServerInstructions } from "./server-instructions.js";
import { createPromptRegistry } from "./prompts.js";
import { checkBreaker, recordResult as recordBreakerResult } from "./circuit-breaker.js";
import { renderBoxDrawing } from "./observe/box-drawing-render.js";
import {
  buildCommonProps,
  captureEvent,
  getTelemetry,
  type CommonProps,
} from "./telemetry/index.js";

/**
 * Minimal shape McpBridgeServer needs to talk to the extension.
 * Implemented by {@link WSBridge}; the daemon hosts one per process
 * and shares it across every active session.
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
  const redirect =
    (method: string) =>
    (...args: unknown[]): void => {
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
        const line = args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ");
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
  (AjvModule as unknown as { default?: AjvCtor }).default ?? (AjvModule as unknown as AjvCtor);
const addFormats: AddFormatsFn =
  (addFormatsModule as unknown as { default?: AddFormatsFn }).default ??
  (addFormatsModule as unknown as AddFormatsFn);

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
  /**
   * Identifier of the daemon-managed session this MCP server belongs to.
   * Phases 3+ thread it through dispatch so tools can resolve tab
   * ownership and per-session approval state. Empty string for the
   * legacy bridge entry, which has no session model.
   */
  sessionId: string;
  /**
   * Hook the daemon supplies for browser_set_session_name. Renames
   * the session in the daemon's SessionRegistry and broadcasts
   * session_renamed to the extension. Returns the canonical name the
   * registry settled on (may differ from the requested name if a
   * dedup suffix had to be appended). Undefined for the legacy
   * bridge entry; the tool reports INVALID_STATE in that case.
   */
  renameSession?: (name: string) => string | undefined;
  /**
   * Set of currently-enabled gated features. Tools whose def.feature is set
   * but absent from this set are hidden from tools/list and rejected at
   * tools/call with FEATURE_DISABLED.
   */
  enabledFeatures: ReadonlySet<FeatureName>;
  /**
   * Tool names that should be hidden from tools/list and rejected at
   * tools/call. Populated from the BROWSEROPS_DISABLED_TOOLS env var
   * (comma-separated). Use to enforce a minimal surface — e.g. a
   * screenshot-first profile that hides browser_observe / quick_read /
   * read / query_selector / describe_ref to mirror a simpler harness.
   */
  disabledTools?: ReadonlySet<string>;
  /** Optional trace writer. When provided, the router will emit a TraceEvent after each tool result. */
  traceWriter?: TraceWriter;
  /**
   * Display name of the MCP client (e.g. "Claude Code", "Cursor"). When
   * present, included as `client_name` on tool_called telemetry events.
   * Empty / undefined drops the property — the redact allowlist tolerates
   * its absence.
   */
  clientName?: string;
}

interface ToolErrorPayload {
  code: ErrorCode | "INVALID_PARAMS";
  message: string;
  details?: unknown;
}

/**
 * Tools that *read* a tab's state. These pass through ownership
 * resolution without claiming — the caller can inspect user-owned
 * tabs and its own tabs without committing to ownership.
 *
 * Everything else with a tab_id is treated as a mutation and
 * auto-claims user-owned tabs into the calling session.
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "browser_list_tabs",
  "browser_current_tab",
  "browser_read",
  "browser_quick_read",
  "browser_screenshot",
  "browser_query_selector",
  "browser_describe_ref",
  "browser_wait_for",
  "browser_wait_for_idle",
]);

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError: boolean;
}

// Server instructions are now built per-instance by buildServerInstructions()
// based on the active feature set — see ./server-instructions.ts.

// ---------------------------------------------------------------------------
// McpBridgeServer
// ---------------------------------------------------------------------------

export class McpBridgeServer {
  private readonly deps: McpBridgeDeps;
  private readonly server: Server;
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly procedureHandlers: Record<
    string,
    (raw: Record<string, unknown>) => Promise<unknown>
  >;
  private readonly loreHandlers: Record<string, (raw: Record<string, unknown>) => Promise<unknown>>;
  private readonly commonProps: CommonProps;
  private transport?: Transport;
  /**
   * Per-session "last successfully-acted-on tab." browser_current_tab
   * falls back to this when the OS-level foreground tab is owned by
   * another session (and therefore invisible to us). Updated after
   * every successful dispatch that named a tab.
   */
  private lastActiveTabId: string | null = null;

  constructor(deps: McpBridgeDeps) {
    this.deps = deps;
    this.procedureHandlers = buildProcedureHandlers(deps.wsBridge);
    this.loreHandlers = LORE_HANDLERS;
    this.commonProps = buildCommonProps({ bridgeVersion: deps.version });

    const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
    addFormats(ajv);
    for (const def of TOOL_DEFS) {
      this.validators.set(def.name, ajv.compile(def.inputSchema));
    }

    this.server = new Server(
      { name: "browserops", version: deps.version },
      {
        capabilities: { tools: {}, prompts: {} },
        instructions: buildServerInstructions(deps.enabledFeatures),
      },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFS.filter(
        (d) =>
          (d.feature === undefined || this.deps.enabledFeatures.has(d.feature)) &&
          !(this.deps.disabledTools?.has(d.name) ?? false),
      ).map((d) => ({
        name: d.name,
        description: d.description,
        // Some tool-use APIs (Anthropic's among them) reject top-level
        // oneOf/allOf/anyOf. Strip them on the wire for broad client
        // compatibility; ajv still enforces the full schema at dispatch time.
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

    const promptRegistry = createPromptRegistry(this.deps.enabledFeatures);

    this.server.setRequestHandler(ListPromptsRequestSchema, async () =>
      promptRegistry.listPrompts(),
    );

    this.server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const args = (req.params.arguments ?? {}) as Record<string, string>;
      return promptRegistry.getPrompt(req.params.name, args);
    });
  }

  async start(transport?: Transport): Promise<void> {
    this.transport = transport ?? new StdioServerTransport();
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
  // Dispatch pipeline.
  // -------------------------------------------------------------------------

  private async dispatch(
    req: { params: { name: string; arguments?: Record<string, unknown> } },
    extra: { signal?: AbortSignal; requestId?: string | number },
  ): Promise<ToolCallResult> {
    const startMs = Date.now();
    const id = extra.requestId !== undefined ? String(extra.requestId) : randomId();
    const name = req.params.name;
    const params: Record<string, unknown> = req.params.arguments ?? {};
    // Snapshot the user-supplied keys before AJV (useDefaults: true) mutates
    // params with schema defaults. tool_called.param_keys reports what the
    // caller actually passed, not the post-validation shape.
    const originalParamKeys = Object.keys(params).sort();

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

    // 2a. Disabled-tools gate (BROWSEROPS_DISABLED_TOOLS env). Tools listed
    // there are hidden from tools/list; reject calls if the client cached
    // the catalogue or names a tool we never advertised.
    if (this.deps.disabledTools?.has(name) ?? false) {
      const result = await this.reply(
        id,
        name,
        toolError({
          code: "TOOL_DISABLED",
          message:
            `tool "${name}" is disabled in this connector profile ` +
            `(BROWSEROPS_DISABLED_TOOLS). Use the screenshot-first ` +
            `equivalents instead.`,
          details: { tool: name },
        }),
      );
      this.record(id, name, params, originalParamKeys, startMs, result, undefined);
      return result;
    }

    // 2b. Feature gate. Tools whose feature flag is set but disabled are
    // hidden from tools/list; this branch handles a client that calls them
    // anyway (cached catalogue, naming convention, etc.).
    if (def.feature !== undefined && !this.deps.enabledFeatures.has(def.feature)) {
      const result = await this.reply(
        id,
        name,
        toolError({
          code: "FEATURE_DISABLED",
          message:
            `tool "${name}" requires the "${def.feature}" feature, which is currently off. ` +
            `Enable it with: browserops feature enable ${def.feature}`,
          details: { feature: def.feature },
        }),
      );
      this.record(id, name, params, originalParamKeys, startMs, result, undefined);
      return result;
    }

    // 3. Validate params (no rate-limit consumption on invalid input).
    const validate = this.validators.get(name);
    if (!validate) {
      throw new McpError(McpErrorCode.InternalError, `no validator compiled for ${name}`);
    }
    if (!validate(params)) {
      const message = formatAjvErrors(validate.errors);
      const result = await this.reply(id, name, toolError({ code: "INVALID_PARAMS", message }));
      this.record(id, name, params, originalParamKeys, startMs, result, undefined);
      return result;
    }

    // 4a. Session-management tools — handled entirely in-daemon, no
    //      extension round trip.
    if (name === "browser_set_session_name") {
      const newName = typeof params["name"] === "string" ? (params["name"] as string).trim() : "";
      if (!newName) {
        const result = await this.reply(
          id,
          name,
          toolError({ code: "INVALID_PARAMS", message: "name must be a non-empty string" }),
        );
        this.record(id, name, params, originalParamKeys, startMs, result, undefined);
        return result;
      }
      if (this.deps.sessionId === "" || !this.deps.renameSession) {
        const result = await this.reply(
          id,
          name,
          toolError({
            code: "INVALID_STATE",
            message:
              "browser_set_session_name is only available when running under the multi-session daemon",
          }),
        );
        this.record(id, name, params, originalParamKeys, startMs, result, undefined);
        return result;
      }
      const settled = this.deps.renameSession(newName) ?? newName;
      const result = await this.reply(
        id,
        name,
        toolOk({ session_id: this.deps.sessionId, name: settled }),
      );
      this.record(id, name, params, originalParamKeys, startMs, result, undefined);
      return result;
    }

    if (name === "browser_release_tab") {
      const tabId = typeof params["tab_id"] === "string" ? (params["tab_id"] as string) : "";
      if (!tabId) {
        const result = await this.reply(
          id,
          name,
          toolError({ code: "INVALID_PARAMS", message: "tab_id is required" }),
        );
        this.record(id, name, params, originalParamKeys, startMs, result, undefined);
        return result;
      }
      if (this.deps.sessionId === "") {
        const result = await this.reply(
          id,
          name,
          toolError({
            code: "INVALID_STATE",
            message:
              "browser_release_tab is only available when running under the multi-session daemon",
          }),
        );
        this.record(id, name, params, originalParamKeys, startMs, result, undefined);
        return result;
      }
      const released = this.deps.tabs.release(tabId, this.deps.sessionId);
      if (!released) {
        const result = await this.reply(
          id,
          name,
          toolError({ code: "TAB_NOT_FOUND", message: `tab ${tabId} not found` }),
        );
        this.record(id, name, params, originalParamKeys, startMs, result, undefined);
        return result;
      }
      const result = await this.reply(id, name, toolOk({ released: true }));
      this.record(id, name, params, originalParamKeys, startMs, result, undefined);
      return result;
    }

    // 4b. In-process procedure handlers — bypass extension WebSocket entirely.
    if (name.startsWith("procedures_")) {
      const handler = this.procedureHandlers[name];
      if (handler) {
        let result: ToolCallResult;
        try {
          const handlerResult = await handler(params);
          result = await this.reply(id, name, toolOk(handlerResult));
        } catch (err) {
          const code = extractErrorCode(err);
          const message = err instanceof Error ? err.message : String(err);
          const details =
            err instanceof Error && "details" in err
              ? (err as { details?: unknown }).details
              : undefined;
          result = await this.reply(id, name, toolError({ code, message, details }));
        }
        // procedures_* calls are not traced — they're meta-RPC, not browser
        // interactions useful for procedure compilation. Telemetry still
        // fires; record() suppresses the trace path internally.
        this.record(id, name, params, originalParamKeys, startMs, result, undefined);
        return result;
      }
      // Unknown procedures_* tool — fall through to let MethodNotFound fire below.
    }

    // 4c. In-process lore handlers — pure filesystem, no extension round-trip.
    if (name.startsWith("lore_")) {
      const handler = this.loreHandlers[name];
      if (handler) {
        let result: ToolCallResult;
        try {
          const handlerResult = await handler(params);
          result = await this.reply(id, name, toolOk(handlerResult));
        } catch (err) {
          const code = extractErrorCode(err);
          const message = err instanceof Error ? err.message : String(err);
          const details =
            err instanceof Error && "details" in err
              ? (err as { details?: unknown }).details
              : undefined;
          result = await this.reply(id, name, toolError({ code, message, details }));
        }
        this.record(id, name, params, originalParamKeys, startMs, result, undefined);
        return result;
      }
    }

    // 4b. Look up tab info + enforce per-session ownership.
    //
    // Visibility rule: a session sees only the tabs it owns plus
    // user-owned (unclaimed) tabs. Other sessions' tabs are treated as
    // non-existent (TAB_NOT_FOUND), so an agent can't even discover
    // them, let alone act on them.
    //
    // Claim rule: the first mutating call from a session on a
    // user-owned tab atomically transfers ownership. From then on
    // it's invisible to every other session. Read-only calls never
    // claim — they pass through without changing ownership.
    const tabIdRaw = params["tab_id"];
    const tabId = typeof tabIdRaw === "string" ? tabIdRaw : undefined;
    let tab: TabInfo | undefined;
    if (tabId) {
      const resolved = this.resolveTab(name, tabId);
      if (!resolved.ok) {
        const result = await this.reply(id, name, toolError(resolved.error));
        this.record(id, name, params, originalParamKeys, startMs, result, undefined);
        return result;
      }
      tab = resolved.record ? { url: resolved.record.url } : undefined;
    }

    // 5. Extension connectivity — short-circuit before charging.
    if (!this.deps.wsBridge.isConnected()) {
      const result = await this.reply(
        id,
        name,
        toolError({
          code: "EXTENSION_DISCONNECTED",
          message: "no active extension connection",
        }),
      );
      this.record(id, name, params, originalParamKeys, startMs, result, tab);
      return result;
    }

    // 6. Rate limit.
    const charge = this.deps.rateLimiter.tryConsume(tabId ?? "_global", def.action_weight);
    if (!charge.ok) {
      const result = await this.reply(
        id,
        name,
        toolError({
          code: "RATE_LIMITED",
          message: `rate limit exceeded (scope: ${charge.scope ?? "?"})`,
          details: { retry_after_ms: charge.retry_after_ms, scope: charge.scope },
        }),
      );
      this.record(id, name, params, originalParamKeys, startMs, result, tab);
      return result;
    }

    // 7. Risky-action gate.
    if (
      def.risky === "always" ||
      (def.risky === "conditional" &&
        this.deps.safety.checkRisky({ tool: name, params, tab }).risky)
    ) {
      const verdict =
        def.risky === "always"
          ? { risky: true as const, reason: `${name} is always risky` }
          : this.deps.safety.checkRisky({ tool: name, params, tab });
      const reason = verdict.reason ?? `${name} requires approval`;
      const tab_hostname = tab?.url
        ? (() => {
            try {
              return new URL(tab.url).hostname;
            } catch {
              return undefined;
            }
          })()
        : undefined;
      const decision = await this.deps.safety.requireApproval({
        tool: name,
        params,
        reason,
        tab_hostname,
      });
      if (!decision.allow) {
        const result = await this.reply(
          id,
          name,
          toolError({ code: "RISKY_ACTION_DENIED", message: reason }),
        );
        this.record(id, name, params, originalParamKeys, startMs, result, tab);
        return result;
      }
    }

    // 8. Repeated-failure circuit breaker.
    // Short-circuit identical failing calls within a 30s window so the agent
    // can't keep re-firing the same wrong action against the live page.
    const breakerCall = { method: name, params };
    const breakerCheck = checkBreaker(breakerCall);
    if (breakerCheck.tripped) {
      const result = await this.reply(
        id,
        name,
        toolError({
          code: "REPEATED_FAILURE",
          message: breakerCheck.error.message,
          details: {
            next_action: breakerCheck.error.next_action,
            diagnostic: breakerCheck.error.diagnostic,
          },
        }),
      );
      this.record(id, name, params, originalParamKeys, startMs, result, tab);
      return result;
    }

    // 9. Timeout.
    const timeoutMs = this.timeoutFor(def, params);

    // 10. Call extension (forward cancellation).
    // Raw input is recorded verbatim — callers who set BROWSEROPS_TRACE=1 have
    // explicitly opted in. Redaction of secrets in params is a future concern.
    try {
      const extResult = await this.deps.wsBridge.callExtension(
        def.name,
        params,
        timeoutMs,
        extra.signal,
      );

      this.maybeClaimNewTab(name, extResult);

      // list_tabs / current_tab need a session-aware view layered on
      // the extension's response — see applySessionFilter for the
      // visibility + lastActiveTab fallback rules. Only path to error
      // here is current_tab with nothing visible, which surfaces as
      // TAB_NOT_FOUND.
      const transformed = applyObserveBoxDrawing(name, extResult);
      const filtered = this.applySessionFilter(name, transformed);
      const finalResult = filtered ?? toolOk(transformed);
      if (finalResult.isError) {
        const result = await this.reply(id, name, finalResult);
        recordBreakerResult(breakerCall, { ok: false, error_code: "TAB_NOT_FOUND" });
        this.record(id, name, params, originalParamKeys, startMs, result, tab);
        return result;
      }
      const result = await this.reply(id, name, finalResult);
      recordBreakerResult(breakerCall, { ok: true });
      this.record(id, name, params, originalParamKeys, startMs, result, tab);
      // Track per-session "last touched tab" so browser_current_tab
      // can fall back to it when the OS-level foreground belongs to
      // someone else.
      if (tabId) this.lastActiveTabId = tabId;
      return result;
    } catch (err) {
      const code = extractErrorCode(err);
      const message = err instanceof Error ? err.message : String(err);
      const result = await this.reply(id, name, toolError({ code, message }));
      recordBreakerResult(breakerCall, { ok: false, error_code: code });
      this.record(id, name, params, originalParamKeys, startMs, result, tab);
      return result;
    }
  }

  /**
   * Per-session tab resolution + auto-claim. Three outcomes:
   *
   *   • { ok: true, record }  — caller can use the record (for
   *     read-only tools and own/just-claimed tabs).
   *   • { ok: false, error }  — caller bails out with this error.
   *
   * Empty sessionId disables ownership entirely so the legacy bridge
   * entry — which has no session model — keeps working unchanged.
   */
  private resolveTab(
    toolName: string,
    tabId: string,
  ): { ok: true; record: TabRecord | undefined } | { ok: false; error: ToolErrorPayload } {
    const sessionId = this.deps.sessionId;
    if (sessionId === "") {
      // Legacy / single-session path — no ownership enforcement.
      return { ok: true, record: this.deps.tabs.get(tabId) };
    }

    if (READ_ONLY_TOOLS.has(toolName)) {
      const rec = this.deps.tabs.getVisibleTo(tabId, sessionId);
      if (!rec) {
        return {
          ok: false,
          error: { code: "TAB_NOT_FOUND", message: `tab ${tabId} not found` },
        };
      }
      return { ok: true, record: rec };
    }

    // Mutating tool — atomically claim a user-owned tab into this
    // session, or bail out with TAB_NOT_FOUND for missing or
    // other-session-owned tabs.
    const claim = this.deps.tabs.claim(tabId, sessionId);
    if (claim.ok) {
      return { ok: true, record: claim.record };
    }
    // owned_by_other and unknown both surface the same way: the tab
    // simply doesn't exist for this session. The dedicated
    // TAB_CLAIMED_BY_OTHER code is reserved for the explicit
    // browser_claim_tab path that lands in phase 4.
    return {
      ok: false,
      error: { code: "TAB_NOT_FOUND", message: `tab ${tabId} not found` },
    };
  }

  /**
   * Post-call shaping for the two tab-discovery tools so each session
   * sees a coherent view of the profile that respects ownership.
   *
   *   browser_list_tabs → filtered to own + user-owned tabs.
   *   browser_current_tab → returns the foreground tab if visible;
   *     otherwise falls back to this session's lastActiveTab; if
   *     neither is visible, surfaces TAB_NOT_FOUND so the caller
   *     can branch instead of receiving a stale tab_id from another
   *     session.
   *
   * Legacy / single-session mode (sessionId === \"\") is a no-op.
   */
  private applySessionFilter(toolName: string, extResult: unknown): ToolCallResult | undefined {
    const sessionId = this.deps.sessionId;
    if (sessionId === "") return undefined;

    if (toolName === "browser_list_tabs") {
      if (!extResult || typeof extResult !== "object") return undefined;
      const obj = extResult as Record<string, unknown>;
      const tabs = obj["tabs"];
      if (!Array.isArray(tabs)) return undefined;
      const filtered = tabs.filter((t) => {
        const tabId = (t as { tab_id?: unknown }).tab_id;
        if (typeof tabId !== "string") return false;
        return this.deps.tabs.getVisibleTo(tabId, sessionId) !== undefined;
      });
      return toolOk({ ...obj, tabs: filtered });
    }

    if (toolName === "browser_current_tab") {
      const obj =
        extResult && typeof extResult === "object"
          ? (extResult as Record<string, unknown>)
          : undefined;
      const reportedId =
        obj && typeof obj["tab_id"] === "string" ? (obj["tab_id"] as string) : undefined;

      if (reportedId) {
        const rec = this.deps.tabs.getVisibleTo(reportedId, sessionId);
        if (rec) return toolOk(obj);
      }

      if (this.lastActiveTabId) {
        const rec = this.deps.tabs.getVisibleTo(this.lastActiveTabId, sessionId);
        if (rec) {
          return toolOk({
            tab_id: rec.tab_id,
            url: rec.url,
            title: rec.title ?? "",
            active: true,
          });
        }
      }

      return toolError({
        code: "TAB_NOT_FOUND",
        message: "no tab visible to this session — open one with browser_new_tab",
      });
    }

    return undefined;
  }

  /**
   * Post-call hook: when browser_new_tab succeeds, the new tab belongs
   * to the calling session by construction. Stamp ownership on the
   * registry so subsequent calls from this session resolve and other
   * sessions can't see it.
   */
  private maybeClaimNewTab(toolName: string, extResult: unknown): void {
    if (toolName !== "browser_new_tab") return;
    if (this.deps.sessionId === "") return;
    if (!extResult || typeof extResult !== "object") return;
    const newTabId = (extResult as { tab_id?: unknown }).tab_id;
    if (typeof newTabId !== "string") return;

    // The tab_created event may not have been processed yet; handle
    // both orderings by claiming after a microtask if the registry
    // doesn't yet know about it. This is a best-effort race fix —
    // phase 3.3 introduces an explicit createdBy hook on the WS event
    // path that covers the cleaner case.
    const claim = this.deps.tabs.claim(newTabId, this.deps.sessionId);
    if (claim.ok) return;
    // Tab not in registry yet — defer one tick.
    queueMicrotask(() => {
      const second = this.deps.tabs.claim(newTabId, this.deps.sessionId);
      if (!second.ok) {
        void this.deps.logger.write({
          dir: "system",
          event: "new_tab_claim_missed",
          tab_id: newTabId,
          session_id: this.deps.sessionId,
          status: second.status,
        });
      }
    });
  }

  /**
   * Joint hook for trace + telemetry. emitTrace preserves its existing
   * skip behaviour for the procedures_ and lore_ tool families (those
   * branches return early; we suppress trace emission for them inline
   * here too). captureToolCalled is unconditional because telemetry
   * treats every tools/call as a usage signal.
   */
  private record(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    originalParamKeys: readonly string[],
    startMs: number,
    result: ToolCallResult,
    tab: TabInfo | undefined,
  ): void {
    if (!toolName.startsWith("procedures_") && !toolName.startsWith("lore_")) {
      this.emitTrace(id, toolName, input, startMs, result);
    }
    this.captureToolCalled(toolName, input, originalParamKeys, startMs, result, tab);
  }

  /**
   * Emit a tool_called PostHog event. All property names go through the
   * redact allowlist in captureEvent — anything not on the allowlist is
   * silently dropped, so adding fields here without also updating
   * redact.ts is a no-op (and the redact tests will catch missing keys).
   */
  private captureToolCalled(
    toolName: string,
    input: Record<string, unknown>,
    originalParamKeys: readonly string[],
    startMs: number,
    result: ToolCallResult,
    tab: TabInfo | undefined,
  ): void {
    const t = getTelemetry();
    if (!t?.enabled) return;

    const props: Record<string, unknown> = {
      tool_name: toolName,
      ok: !result.isError,
      duration_ms: Date.now() - startMs,
      param_keys: [...originalParamKeys],
    };
    if (this.deps.clientName) props["client_name"] = this.deps.clientName;

    if (tab?.url) {
      try {
        const h = new URL(tab.url).hostname;
        if (h) props["tab_hostname"] = h;
      } catch {
        /* not a URL — skip */
      }
    }

    let parsedResult: Record<string, unknown> | undefined;
    const text = result.content[0]?.text ?? "";
    if (text) {
      try {
        const v = JSON.parse(text);
        if (v && typeof v === "object") parsedResult = v as Record<string, unknown>;
      } catch {
        /* leave undefined */
      }
    }

    if (result.isError && parsedResult && typeof parsedResult["code"] === "string") {
      props["error_code"] = parsedResult["code"];
      if (parsedResult["code"] === "FEATURE_DISABLED") props["feature_gate_hit"] = true;
    }

    if (toolName === "procedures_execute") {
      if (typeof input["name"] === "string") props["procedure_name"] = input["name"];
      if (parsedResult && typeof parsedResult["steps_executed"] === "number") {
        props["procedure_steps_executed"] = parsedResult["steps_executed"];
      }
    }

    if (toolName.startsWith("lore_")) {
      props["lore_op"] = toolName.slice("lore_".length);
      if (typeof input["name"] === "string") props["lore_name"] = input["name"];
    }

    if (toolName === "browser_screenshot" && !result.isError && parsedResult) {
      if (typeof parsedResult["width"] === "number")
        props["screenshot_width_px"] = parsedResult["width"];
      if (typeof parsedResult["height"] === "number")
        props["screenshot_height_px"] = parsedResult["height"];
      if (typeof parsedResult["format"] === "string")
        props["screenshot_format"] = parsedResult["format"];
    }

    if (toolName === "browser_navigate" && tab?.url && typeof input["url"] === "string") {
      try {
        const target = new URL(input["url"] as string);
        const current = new URL(tab.url);
        props["is_external_url"] = target.hostname !== current.hostname;
      } catch {
        /* not URLs — skip */
      }
    }

    captureEvent(t, `mcp.${toolName}`, props, this.commonProps);
  }

  /**
   * Emit a TraceEvent for a completed tools/call. No-op when traceWriter is
   * absent or disabled. Meta RPCs (tools/list, initialize, ping) are never
   * passed here — only browser_* and similar leaf tool calls go through this.
   */
  private emitTrace(
    id: string,
    toolName: string,
    input: Record<string, unknown>,
    startMs: number,
    result: ToolCallResult,
  ): void {
    const tw = this.deps.traceWriter;
    if (!tw?.enabled) return;

    let traceResult: TraceEvent["result"];
    if (!result.isError) {
      // Parse the value back out of the text content.
      const text = result.content[0]?.text ?? "";
      let value: unknown = text;
      try {
        value = JSON.parse(text);
      } catch {
        /* leave as string */
      }
      traceResult = { ok: true, value };
    } else {
      const text = result.content[0]?.text ?? "";
      let errorCode = "UNKNOWN";
      let errorMessage = text;
      try {
        const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
        if (typeof parsed.code === "string") errorCode = parsed.code;
        if (typeof parsed.message === "string") errorMessage = parsed.message;
      } catch {
        /* leave defaults */
      }
      traceResult = { ok: false, error_code: errorCode, error_message: errorMessage };
    }

    const event: TraceEvent = {
      id,
      timestamp: new Date().toISOString(),
      tool_name: toolName,
      duration_ms: Date.now() - startMs,
      input,
      result: traceResult,
    };
    tw.append(event);
  }

  private timeoutFor(def: ToolDef, params: Record<string, unknown>): number {
    if (def.name === "browser_navigate") return NAVIGATE_TIMEOUT_MS;
    if (def.name === "browser_wait_for") {
      const raw = params["timeout_ms"];
      const provided = typeof raw === "number" ? raw : DEFAULT_TOOL_TIMEOUT_MS;
      return Math.min(provided, WAIT_FOR_TIMEOUT_CAP_MS);
    }
    return DEFAULT_TOOL_TIMEOUT_MS;
  }

  private async reply(id: string, method: string, result: ToolCallResult): Promise<ToolCallResult> {
    const base: Record<string, unknown> = {
      dir: "mcp_out",
      id,
      method,
      ok: !result.isError,
    };
    if (result.isError) {
      // Error payload travels in content[0].text as a JSON string. Parse it
      // back to pull the code for the audit log.
      const text = result.content[0]?.text ?? "";
      try {
        const parsed = JSON.parse(text) as { code?: unknown };
        if (typeof parsed.code === "string") base["code"] = parsed.code;
      } catch {
        /* content wasn't JSON — fine, skip code field */
      }
    }
    await this.deps.logger.write(base as Omit<Parameters<Logger["write"]>[0], "ts">);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Action handlers attach a page_effect envelope (`effect: Effect`) — a
// structural delta about what changed during the action window. The bridge
// forwards the extension's result verbatim, so the envelope reaches MCP
// clients unmodified. The per-tool outputSchema in shared/src/tools.ts must
// list `effect` to keep strict-validating clients happy.
// browser_observe structure/auto modes embed a `_render: "box_drawing"` tag
// in the payload to defer the actual ASCII rendering to the bridge — keeps
// renderer logic out of the extension's MV3 SW and centralized here.
function applyObserveBoxDrawing(toolName: string, result: unknown): unknown {
  if (toolName !== "browser_observe") return result;
  if (typeof result !== "object" || result === null) return result;
  const r = result as Record<string, unknown>;
  const payload = r["payload"];
  if (typeof payload !== "object" || payload === null) return result;
  const p = payload as Record<string, unknown>;
  if (p["_render"] !== "box_drawing") return result;
  const rawNodes = (p["nodes"] ?? []) as Array<Record<string, unknown>>;
  const viewport_dims = (r["page_meta"] as { viewport_dims?: { w: number; h: number } } | undefined)
    ?.viewport_dims ?? { w: 1280, h: 720 };
  const nodes = rawNodes.map((n) => ({
    ref: typeof n["ref"] === "string" ? n["ref"] : String(n["ref"] ?? ""),
    role: typeof n["role"] === "string" ? n["role"] : "",
    name: typeof n["name"] === "string" ? n["name"] : "",
    selector: typeof n["selector"] === "string" ? n["selector"] : "",
    bounds: (n["bounds"] as { x: number; y: number; w: number; h: number } | null) ?? null,
    visible: n["visible"] === true,
    in_viewport: n["in_viewport"] === true,
    occluded_by: typeof n["occluded_by"] === "string" ? (n["occluded_by"] as string) : null,
    bg_color: typeof n["bg_color"] === "string" ? (n["bg_color"] as string) : null,
    fg_color: typeof n["fg_color"] === "string" ? (n["fg_color"] as string) : null,
    opacity: typeof n["opacity"] === "number" ? (n["opacity"] as number) : 1,
    disabled_visual: n["disabled_visual"] === true,
    display: typeof n["display"] === "string" ? (n["display"] as string) : undefined,
    flex_direction:
      typeof n["flex_direction"] === "string" ? (n["flex_direction"] as string) : undefined,
  }));
  const rendered = renderBoxDrawing(nodes, viewport_dims);
  const newPayload: Record<string, unknown> = {
    text: rendered.text,
    ref_map: rendered.ref_map,
  };
  if (p["image"] !== undefined) newPayload["image"] = p["image"];
  return { ...r, payload: newPayload };
}

function toolOk(result: unknown): ToolCallResult {
  const text = typeof result === "string" ? result : safeJson(result);
  return {
    content: [{ type: "text", text }],
    structuredContent: result as Record<string, unknown> | undefined,
    isError: false,
  };
}

function toolError(payload: ToolErrorPayload): ToolCallResult {
  // Intentionally no structuredContent on error. Per MCP spec, outputSchema
  // constrains successful results; error results carry info via `content`
  // + `isError: true`. Some clients (seen in Cursor) run strict outputSchema
  // validation against structuredContent regardless of isError — emitting an
  // error-shaped object there makes them surface a confusing "schema
  // mismatch" message that masks the real INVALID_PARAMS / RATE_LIMITED /
  // etc. cause.
  return {
    content: [{ type: "text", text: safeJson(payload) }],
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

function formatAjvErrors(errors: ValidateFunction["errors"] | null | undefined): string {
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
