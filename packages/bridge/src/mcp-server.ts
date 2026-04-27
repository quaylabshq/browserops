import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
  isErrorCode,
  type TraceEvent,
} from "@browserops/shared";
import type { RateLimiter } from "./rate-limiter.js";
import type { Safety, TabInfo } from "./safety.js";
import type { TabRegistry } from "./tab-registry.js";
import type { Logger } from "./logger.js";
import type { TraceWriter } from "./trace-writer.js";
import { buildProcedureHandlers } from "./procedures/handlers.js";
import { listPrompts, getPrompt } from "./prompts.js";
import { checkBreaker, recordResult as recordBreakerResult } from "./circuit-breaker.js";
import type { TeachSessionStore } from "./teach/session-store.js";

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
  /** Disk-backed teach-mode session store (procedures_teach_* handlers read/write here). */
  teachStore: TeachSessionStore;
  /** Optional trace writer. When provided, the router will emit a TraceEvent after each tool result. */
  traceWriter?: TraceWriter;
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
 * anchoring on the user's pinned tab and consulting procedure memory before
 * re-planning a flow from scratch. Delegation guidance is conditional on
 * whether the host client exposes a sub-agent / task primitive — clients
 * without one can ignore that section.
 */
const SERVER_INSTRUCTIONS = [
  "browserops controls a real Chrome profile via a companion extension.",
  "",
  "Full operating guide: if your host supports Claude skills, invoke the",
  "`browserops` skill before your first browser_* or procedures_* call. It",
  "covers the observation-centric execution model (page_effect), trusted vs",
  "synthetic dispatch, per-tool cookbook, failure-mode → fix-it map,",
  "sub-agent delegation rules, and procedure authoring discipline. The",
  "summary below is the minimum; the skill is the canonical reference.",
  "",
  "AUTONOMOUS BY DEFAULT — the #1 rule. Do NOT ask the user to disambiguate",
  "a short ask. Interpret it charitably, state the interpretation in ≤1",
  "line, and attempt. The observation runtime (page_effect) catches wrong",
  "interpretations within one call — that loop is faster than a clarifying",
  "round-trip. A three-part clarifying-question dump like \"did you mean",
  "amazon.in or amazon.com/in? what is 'delivery info task'? did you mean",
  "mouse click or keyboard?\" is the specific failure mode this rule bans.",
  "Ask at most ONE short question, and only when the task literally cannot",
  "be attempted without a specific value (credentials, amount, recipient),",
  "OR is irreversible and the target is genuinely ambiguous. Everything",
  "else: interpret, attempt, verify, report.",
  "",
  "Tool invocation:",
  '- Every tool takes a JSON arguments object per its inputSchema (e.g.',
  '  procedures_search needs {"query": "..."}, browser_navigate needs',
  '  {"tab_id": "...", "url": "..."}). If your host exposes a generic',
  '  MCP wrapper that does not forward arguments, the call will error',
  "  with INVALID_PARAMS — use the host's native per-tool invocation path",
  "  instead.",
  "",
  "Orchestration (plan-if-complex → decompose → list → delegate in parallel):",
  "- Classify each piece of the request as easy (known site, low-stakes,",
  "  known procedure) or tricky (canvas/SPA gotcha, unfamiliar tool,",
  "  branching, high-stakes, ambiguous goal, recovering from a failure).",
  "- For tricky pieces, the FIRST list item is a planner spawn, e.g.",
  '  "0. Spawn planner sub-agent (sonnet) — produce plan covering goal,',
  "  tab strategy, tools to use, tools to AVOID and why, expected",
  '  page_effect signatures, failure recovery. ≤15 lines."',
  "- Externalize the planning so the main context only ever sees the",
  "  finished plan, not the deliberation. This is the #1 reason the full",
  "  discipline collapses on complex tasks — task state crowds out the",
  "  rules in working memory.",
  "- PARALLELIZE: if a request has both easy and tricky pieces, fire them",
  "  in one turn (multiple Agent calls per message). Planner sub-agent on",
  "  the tricky site runs concurrently with the easy execution sub-agent.",
  "  Parallelism rule: sub-agents may run in parallel iff they operate on",
  "  different tabs. Same-tab subtasks must serialize (they race).",
  "- Before calling any tool, decompose the user's request into a flat list",
  "  of concrete subtasks and record it with your host's task-tracking",
  "  primitive. The list is the source of truth — it's how the main agent",
  "  avoids losing the overall goal as intermediate output piles up.",
  "- IMPORTANT: each non-trivial list item must be phrased as a spawn-sub-",
  '  agent instruction, not a task description. Write "Spawn sub-agent —',
  '  search for Kartik in Slack, return tab_id", NOT "Search for Kartik".',
  "  Agents that see the word 'spawn' in the list actually delegate; agents",
  "  that see a plain task description frequently forget and run inline,",
  "  especially for the 2nd/3rd/Nth subtask.",
  "- Run each subtask in its own sub-agent (if the host supports it) so the",
  "  main context stays an orchestrator: no page dumps, no screenshots, no",
  "  intermediate tool results accumulating. Hosts without sub-agent support",
  "  can run inline, but should still maintain the subtask list.",
  "- Recursive decomposition is allowed: if a sub-agent receives a brief",
  "  that is itself compound, it writes its own spawn-sub-agent list and",
  "  delegates further. Only the final ≤5-line summary rolls back up.",
  "- Trivial single primitives (one browser_navigate, one browser_read, a",
  "  one-shot factual query) can run directly. Anything compound, branching,",
  "  or likely to need retries (REF_STALE, occluded clicks, wait_for loops)",
  "  goes through one-sub-agent-per-subtask.",
  "- Each brief must be minimal: procedure name + inputs + tab_id, or for",
  "  ad-hoc work the primitive sequence for THAT subtask only. Never inline",
  "  procedure steps — the delegate calls procedures_get itself. Never batch",
  "  two subtasks into one brief. Example:",
  '  "Run gmail.send_email on tab t_3 with to=x subject=y body=z. Report success."',
  "- After each sub-agent returns (≤5 lines: what it did, pass/fail gate,",
  "  result summary), update the list and dispatch the next subtask.",
  "",
  "Tab selection (stay autonomous — recover without asking the user):",
  "- Call browser_current_tab to operate on whatever the user is looking at;",
  "  if no usable tab is returned, call browser_new_tab and proceed.",
  "- For cross-tab work, call browser_list_tabs and pick explicitly.",
  "",
  "Clicking (escalation ladder — stop when page_effect shows intended effect):",
  "  1. browser_click with a ref (cheapest, most addressable).",
  "  2. browser_click with dismiss_overlay:true if (1) returns occluded, or",
  "     returns clicked:true with zero page_effect.",
  "  3. browser_click_by_text with the visible label — for div-with-onclick",
  "     targets that never surface as a ref.",
  "  4. browser_click_at with viewport coordinates — last resort, genuinely",
  "     useful on complex SPAs (Instagram, TikTok, some retail checkouts)",
  "     where the clickable surface is a gesture handler on a parent div",
  "     or canvas.",
  "- Coordinate clicks are underused but unreliable: clicked:true only means",
  "  a mouse event was dispatched at that point — it could have landed on a",
  "  parent, a sibling overlay, or dead space. ALWAYS verify page_effect",
  "  immediately after browser_click_at. Zero effect = failure, retry with",
  "  adjusted coords or fall back to click_by_text.",
  "",
  "Risky actions (browser_execute_js, click/type on sensitive domains) prompt the",
  "user in the extension popup by default. They can be auto-approved via --yolo",
  "on the bridge CLI or the popup auto-approve toggle (session-scoped).",
  "",
  "Procedure memory:",
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
    this.procedureHandlers = buildProcedureHandlers(deps.wsBridge, deps.teachStore);

    const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
    addFormats(ajv);
    for (const def of TOOL_DEFS) {
      this.validators.set(def.name, ajv.compile(def.inputSchema));
    }

    this.server = new Server(
      { name: "browserops", version: deps.version },
      { capabilities: { tools: {}, prompts: {} }, instructions: SERVER_INSTRUCTIONS },
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

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => listPrompts());

    this.server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const args = (req.params.arguments ?? {}) as Record<string, string>;
      return getPrompt(req.params.name, args);
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
      const tab_hostname = tab?.url ? (() => { try { return new URL(tab.url).hostname; } catch { return undefined; } })() : undefined;
      const decision = await this.deps.safety.requireApproval({ tool: name, params, reason, tab_hostname });
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
      this.emitTrace(id, name, params, startMs, result);
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

      const result = await this.reply(id, name, toolOk(extResult));
      recordBreakerResult(breakerCall, { ok: true });
      this.emitTrace(id, name, params, startMs, result);
      return result;
    } catch (err) {
      const code = extractErrorCode(err);
      const message = err instanceof Error ? err.message : String(err);
      const result = await this.reply(id, name, toolError({ code, message }));
      recordBreakerResult(breakerCall, { ok: false, error_code: code });
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
