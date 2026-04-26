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
  type TraceEvent,
} from "@browserops/shared";
import type { RateLimiter } from "./rate-limiter.js";
import type { Safety, TabInfo } from "./safety.js";
import type { TabRegistry } from "./tab-registry.js";
import type { Logger } from "./logger.js";
import type { TraceWriter } from "./trace-writer.js";
import type { ObservedFactsStore, ObservedFact } from "./observed-facts.js";
import { buildProcedureHandlers } from "./procedures/handlers.js";

// ---------------------------------------------------------------------------
// TabHostnameCache
//
// Populated from browser_navigate final_url. Tabs that were opened by the
// user (not via browserops navigate) have no cache entry; auto-escalation is
// skipped for them — acceptable first cut.
// ---------------------------------------------------------------------------

export class TabHostnameCache {
  private readonly map = new Map<string, string>(); // tab_id (t_foo) → hostname

  set(tabId: string, hostname: string): void {
    this.map.set(tabId, hostname);
  }

  get(tabId: string): string | undefined {
    return this.map.get(tabId);
  }
}

// ---------------------------------------------------------------------------
// Escalation threshold constants
// ---------------------------------------------------------------------------

/** Minimum synthetic samples before escalation is considered. */
export const ESCALATE_MIN_SYNTHETIC_SAMPLES = 3;
/** Synthetic effect rate must be below this to escalate. */
export const ESCALATE_MAX_SYNTHETIC_EFFECT_RATE = 0.2;
/** Trusted effect rate must be at or above this to escalate. */
export const ESCALATE_MIN_TRUSTED_EFFECT_RATE = 0.5;

// ---------------------------------------------------------------------------
// ObservedHints — attached to forwarded params when escalation fires
// ---------------------------------------------------------------------------

export interface ObservedHints {
  clickMode?: "trusted";
  semanticKeyMode?: "trusted";
  typeMode?: "trusted";
}

/**
 * Compute dispatch-mode hints based on observed facts for a single
 * (hostname, action_class) pair.
 *
 * Returns non-null ObservedHints when the evidence shows:
 *   - synthetic_samples >= ESCALATE_MIN_SYNTHETIC_SAMPLES
 *   - synthetic_effect_rate < ESCALATE_MAX_SYNTHETIC_EFFECT_RATE
 *   - a trusted observation exists with effect_rate >= ESCALATE_MIN_TRUSTED_EFFECT_RATE
 *
 * Returns null when below threshold — fail open to existing behavior.
 */
export function computeObservedHints(
  facts: ObservedFact[],
  actionClass: "click" | "type" | "press",
): ObservedHints | null {
  const relevant = facts.filter((f) => f.action_class === actionClass);

  const syntheticFact = relevant.find((f) => f.dispatch_mode === "synthetic");
  const trustedFact = relevant.find((f) => f.dispatch_mode === "trusted");

  // Must have enough synthetic evidence.
  if (!syntheticFact || syntheticFact.samples < ESCALATE_MIN_SYNTHETIC_SAMPLES) {
    return null;
  }

  const syntheticEffectRate = syntheticFact.effect_count / syntheticFact.samples;
  if (syntheticEffectRate >= ESCALATE_MAX_SYNTHETIC_EFFECT_RATE) {
    return null;
  }

  // Must have trusted evidence that actually works.
  if (!trustedFact || trustedFact.samples === 0) {
    return null;
  }

  const trustedEffectRate = trustedFact.effect_count / trustedFact.samples;
  if (trustedEffectRate < ESCALATE_MIN_TRUSTED_EFFECT_RATE) {
    return null;
  }

  // Escalate: map action_class to the correct hint field.
  if (actionClass === "click") return { clickMode: "trusted" };
  if (actionClass === "type") return { typeMode: "trusted" };
  if (actionClass === "press") return { semanticKeyMode: "trusted" };
  return null;
}

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
  /** Optional trace writer. When provided, the router will emit a TraceEvent after each tool result. */
  traceWriter?: TraceWriter;
  /**
   * Optional observed-facts store. When provided, the dispatch pipeline
   * records and queries observations to auto-escalate dispatch modes.
   */
  observedFacts?: ObservedFactsStore;
  /**
   * Optional tab hostname cache. Populated from browser_navigate final_url.
   * Used to look up the hostname for a tab_id when injecting observed_hints.
   * Tabs opened outside of browserops navigation have no entry (acceptable
   * first cut — Phase 6.5 can track hostnames from response metadata).
   */
  tabHostnameCache?: TabHostnameCache;
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

/**
 * Surfaced to the calling agent via MCP `initialize.result.instructions`.
 * Written for any MCP-compatible client (Claude Code, Cursor, Zed, Continue,
 * Windsurf, custom SDK agents, …). The goal is to nudge the agent toward
 * anchoring on the user's pinned tab and consulting procedure runtime before
 * re-planning a flow from scratch. Delegation guidance is conditional on
 * whether the host client exposes a sub-agent / task primitive — clients
 * without one can ignore that section.
 */
const SERVER_INSTRUCTIONS = [
  "browserops controls a real Chrome profile via a companion extension.",
  "",
  "Tool invocation:",
  '- Every tool takes a JSON arguments object per its inputSchema (e.g.',
  '  procedures_search needs {"query": "..."}, browser_navigate needs',
  '  {"tab_id": "...", "url": "..."}). If your host exposes a generic',
  '  MCP wrapper that does not forward arguments, the call will error',
  "  with INVALID_PARAMS — use the host's native per-tool invocation path",
  "  instead.",
  "",
  "Orchestration:",
  "- For flows with ≤8 steps and no retry/branching logic, execute browser_*",
  "  tool calls directly. Keep the loop short; don't add steps that don't",
  "  advance the task.",
  "- For flows with >8 steps, or that need retry loops (REF_STALE, timing,",
  "  occluded clicks), if your host client supports delegating to a",
  "  sub-agent / background task, hand off the read → click → wait → verify",
  "  loop so the parent only sees the final result. If it does not, run the",
  "  loop inline — the steps are the same.",
  "- Delegation brief (when applicable) must be minimal: procedure name +",
  "  inputs + tab_id. Never inline procedure steps into the brief — the",
  "  delegate calls procedures_get itself. Example:",
  '  "Run gmail.send_email on tab t_3 with to=x subject=y body=z. Report success."',
  "",
  "Tab selection:",
  "- If the user is working on a specific tab they already have open, call",
  "  browser_pinned_tab FIRST and thread the returned tab_id through the rest",
  "  of the turn. That tab is the user's home base; do not open a new one",
  "  unless the task explicitly asks for it.",
  "- For cross-tab work, call browser_list_tabs and pick explicitly.",
  "- NO_PINNED_TAB means the user has not pinned one — ask them to click",
  '  "Use this tab" in the extension popup, or fall back to current_tab.',
  "",
  "Clicking:",
  "- Prefer browser_click (ref-based) when the target appears in the a11y tree.",
  "- If a button doesn't show up as a ref (common on retail SPAs with div-based",
  "  click handlers), use browser_click_by_text with the visible label.",
  "",
  "Risky actions (browser_execute_js, click/type on sensitive domains) prompt the",
  "user in the extension popup by default. They can be auto-approved via --yolo",
  "on the bridge CLI or the popup auto-approve toggle (session-scoped).",
  "",
  "Procedure runtime:",
  "- Procedures are named, parameterized, reusable action graphs living in",
  "  `~/browserops/procedures/`. Before planning any browser task, call",
  "  `procedures_search(<tokens from user's request>)` once. If the top match",
  "  has score >= 0.5, load it with `procedures_get` and run its steps. If",
  "  multiple matches are relevant (common for composite tasks like",
  '  "email posthog users" — both posthog and gmail procedures), load all of',
  "  them; they are meant to compose.",
  "- `list`/`search` return metadata only; `get` returns the YAML body. Do",
  "  not dump the full catalogue — scope via `domain` or `scope` when you",
  "  can narrow.",
  "- A composite procedure declares `uses: [...]`. After a `get`, fetch each",
  "  name in `uses:` (parallel `get` calls) — that loads the full pack for",
  "  execution.",
  "- If no match clears threshold, plan from scratch, then offer",
  "  `procedures_save` at the end.",
  "- You interpret and execute procedures yourself by calling the",
  "  `browser_*` primitives in their `steps:` — the bridge does not run",
  "  procedures.",
  "- Never take a screenshot to verify a step that declares `wait_for`.",
  "  Only screenshot on error or unexpected state.",
].join("\n");

// ---------------------------------------------------------------------------
// McpBridgeServer
// ---------------------------------------------------------------------------

export class McpBridgeServer {
  private readonly deps: McpBridgeDeps;
  private readonly server: Server;
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly procedureHandlers: Record<string, (raw: Record<string, unknown>) => Promise<unknown>>;
  private transport?: StdioServerTransport;

  constructor(deps: McpBridgeDeps) {
    this.deps = deps;
    this.procedureHandlers = buildProcedureHandlers(deps.wsBridge);

    const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
    addFormats(ajv);
    for (const def of TOOL_DEFS) {
      this.validators.set(def.name, ajv.compile(def.inputSchema));
    }

    this.server = new Server(
      { name: "browserops", version: deps.version },
      { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFS.map((d) => ({
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
      const result = await this.reply(id, name, toolError({ code: "INVALID_PARAMS", message }));
      this.emitTrace(id, name, params, startMs, result);
      return result;
    }

    // 4a. In-process procedure handlers — bypass extension WebSocket entirely.
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
          const details = err instanceof Error && "details" in err
            ? (err as { details?: unknown }).details
            : undefined;
          result = await this.reply(id, name, toolError({ code, message, details }));
        }
        // procedures_* calls are not traced — they're meta-RPC, not browser
        // interactions useful for procedure compilation (Phase 4).
        return result;
      }
      // Unknown procedures_* tool — fall through to let MethodNotFound fire below.
    }

    // 4b. Look up tab info (optional).
    const tabIdRaw = params["tab_id"];
    const tabId = typeof tabIdRaw === "string" ? tabIdRaw : undefined;
    let tab: TabInfo | undefined;
    if (tabId) {
      const rec = this.deps.tabs.get(tabId);
      tab = rec ? { url: rec.url } : undefined;
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
      this.emitTrace(id, name, params, startMs, result);
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
      this.emitTrace(id, name, params, startMs, result);
      return result;
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
        const result = await this.reply(
          id,
          name,
          toolError({ code: "RISKY_ACTION_DENIED", message: reason }),
        );
        this.emitTrace(id, name, params, startMs, result);
        return result;
      }
    }

    // 8. Timeout.
    const timeoutMs = this.timeoutFor(def, params);

    // 8a. Auto-escalation: inject observed_hints into params for
    // browser_click / browser_type / browser_press when observations show
    // synthetic is ineffective on this site. Graceful on all errors — if we
    // can't look up the hostname or facts, we simply don't inject.
    const forwardParams = this.injectObservedHints(name, params);

    // 9. Call extension (forward cancellation).
    // Raw input is recorded verbatim — callers who set BROWSEROPS_TRACE=1 have
    // explicitly opted in. Redaction of secrets in params is a future concern.
    try {
      const extResult = await this.deps.wsBridge.callExtension(
        def.name,
        forwardParams,
        timeoutMs,
        extra.signal,
      );
      const result = await this.reply(id, name, toolOk(extResult));
      this.emitTrace(id, name, params, startMs, result);
      this.recordObservation(name, params, extResult);
      // Populate hostname cache from browser_navigate final_url so future
      // calls on this tab_id can benefit from observed-hints escalation.
      this.updateHostnameCache(name, params, extResult);
      return result;
    } catch (err) {
      const code = extractErrorCode(err);
      const message = err instanceof Error ? err.message : String(err);
      const result = await this.reply(id, name, toolError({ code, message }));
      this.emitTrace(id, name, params, startMs, result);
      return result;
    }
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
      try { value = JSON.parse(text); } catch { /* leave as string */ }
      traceResult = { ok: true, value };
    } else {
      const text = result.content[0]?.text ?? "";
      let errorCode = "UNKNOWN";
      let errorMessage = text;
      try {
        const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
        if (typeof parsed.code === "string") errorCode = parsed.code;
        if (typeof parsed.message === "string") errorMessage = parsed.message;
      } catch { /* leave defaults */ }
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

  /**
   * Record an observation to the observed-facts store after a successful
   * browser_click / browser_type / browser_press result.
   *
   * Skipped when:
   * - `observedFacts` is not enabled on deps
   * - tool is not one of the three mutating primitives
   * - `page_effect` is absent from the result (observe_effects:false or
   *   observation failure) — no signal to record
   *
   * Errors are caught and swallowed; failure to record must never break the
   * tool call that already succeeded.
   */
  private recordObservation(
    toolName: string,
    input: Record<string, unknown>,
    extResult: unknown,
  ): void {
    const store = this.deps.observedFacts;
    if (!store) return;

    try {
      // Map tool name → action_class.
      let action_class: ObservedFact["action_class"];
      if (toolName === "browser_click") {
        action_class = "click";
      } else if (toolName === "browser_type") {
        action_class = "type";
      } else if (toolName === "browser_press") {
        action_class = "press";
      } else {
        // Not a tool we observe.
        return;
      }

      if (!extResult || typeof extResult !== "object") return;
      const res = extResult as Record<string, unknown>;

      // page_effect must be present to record — if absent, skip.
      const pageEffect = res["page_effect"];
      if (!pageEffect || typeof pageEffect !== "object") return;
      const pe = pageEffect as Record<string, unknown>;

      // Derive had_effect from the page_effect fields.
      const dom = pe["dom"] && typeof pe["dom"] === "object"
        ? pe["dom"] as Record<string, unknown>
        : null;
      const domDelta = dom
        ? ((dom["added"] as number | undefined) ?? 0) +
          ((dom["removed"] as number | undefined) ?? 0) +
          ((dom["attr_changes"] as number | undefined) ?? 0) +
          ((dom["text_changes"] as number | undefined) ?? 0)
        : 0;

      const url = pe["url"] && typeof pe["url"] === "object"
        ? pe["url"] as Record<string, unknown>
        : null;
      const urlChanged = url ? Boolean(url["changed"]) : false;

      const focus = pe["focus"] && typeof pe["focus"] === "object"
        ? pe["focus"] as Record<string, unknown>
        : null;
      const focusChanged = focus ? Boolean(focus["changed"]) : false;

      const network = pe["network"] && typeof pe["network"] === "object"
        ? pe["network"] as Record<string, unknown>
        : null;
      const networkStarted = network
        ? ((network["requests_started"] as number | undefined) ?? 0)
        : 0;

      const had_effect =
        domDelta > 0 || urlChanged || focusChanged || networkStarted > 0;

      // Extract hostname from result.site (preferred) or input.url (fallback).
      let hostname: string | undefined;
      if (typeof res["site"] === "string" && res["site"]) {
        hostname = res["site"];
      } else if (typeof input["url"] === "string" && input["url"]) {
        try {
          hostname = new URL(input["url"]).hostname;
        } catch {
          /* invalid URL — skip */
        }
      }
      if (!hostname) return;

      // Extract dispatch_mode.
      let dispatch_mode: ObservedFact["dispatch_mode"];
      if (action_class === "click") {
        // browser_click: result.mode_used is "synthetic" | "trusted"
        const modeUsed = res["mode_used"];
        if (modeUsed === "trusted") {
          dispatch_mode = "trusted";
        } else {
          dispatch_mode = "synthetic";
        }
      } else if (action_class === "type") {
        // browser_type: result.mode_used is "keystroke" | "paste" | "trusted" | "insertText"
        const modeUsed = res["mode_used"];
        if (modeUsed === "trusted") {
          dispatch_mode = "trusted";
        } else if (modeUsed === "insertText") {
          dispatch_mode = "insertText";
        } else {
          // "keystroke" | "paste" → synthetic
          dispatch_mode = "synthetic";
        }
      } else {
        // browser_press: result.dispatch is "synthetic" | "trusted"
        const dispatchField = res["dispatch"];
        if (dispatchField === "trusted") {
          dispatch_mode = "trusted";
        } else {
          dispatch_mode = "synthetic";
        }
      }

      store.recordObservation({ hostname, action_class, dispatch_mode, had_effect });
    } catch {
      // Recording must never break the call.
    }
  }

  /**
   * Populate the tab hostname cache from a successful browser_navigate result.
   * Called after every successful extension call; no-op for all other tools.
   */
  private updateHostnameCache(
    toolName: string,
    input: Record<string, unknown>,
    extResult: unknown,
  ): void {
    if (toolName !== "browser_navigate") return;
    const cache = this.deps.tabHostnameCache;
    if (!cache) return;
    try {
      const tabId = typeof input["tab_id"] === "string" ? input["tab_id"] : undefined;
      if (!tabId) return;

      // Prefer final_url from the extension result; fall back to input url.
      let urlStr: string | undefined;
      if (extResult && typeof extResult === "object") {
        const r = extResult as Record<string, unknown>;
        if (typeof r["final_url"] === "string") urlStr = r["final_url"];
      }
      if (!urlStr && typeof input["url"] === "string") urlStr = input["url"];
      if (!urlStr) return;

      const hostname = new URL(urlStr).hostname;
      if (hostname) cache.set(tabId, hostname);
    } catch {
      // URL parse errors or missing fields — just skip.
    }
  }

  /**
   * Inject `observed_hints` into the params before forwarding to the extension
   * for browser_click / browser_type / browser_press.
   *
   * If no hostname is cached for the tab, or no escalation threshold is met,
   * returns the original params object unmodified.
   */
  private injectObservedHints(
    toolName: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    try {
      let actionClass: "click" | "type" | "press";
      if (toolName === "browser_click") {
        actionClass = "click";
      } else if (toolName === "browser_type") {
        actionClass = "type";
      } else if (toolName === "browser_press") {
        actionClass = "press";
      } else {
        return params;
      }

      const cache = this.deps.tabHostnameCache;
      const store = this.deps.observedFacts;
      if (!cache || !store) return params;

      const tabId = typeof params["tab_id"] === "string" ? params["tab_id"] : undefined;
      if (!tabId) return params;

      const hostname = cache.get(tabId);
      if (!hostname) return params;

      const facts = store.getFacts(hostname);
      if (facts.length === 0) return params;

      const hints = computeObservedHints(facts, actionClass);
      if (hints === null) return params;

      // Log the escalation so it's visible in bridge stderr.
      const hintDesc = Object.entries(hints)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      process.stderr.write(
        `[browserops] observed_hints:${hintDesc} overriding synthetic for ${hostname} (${toolName})\n`,
      );

      return { ...params, observed_hints: hints };
    } catch {
      // Any error: fail open, no injection.
      return params;
    }
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
