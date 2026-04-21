# 01 — MCP Server (bridge, stdio half)

## 1. Scope

This plan covers the **MCP half** of the single bridge process that lives in `packages/bridge/`. It specifies how the bridge speaks the Model Context Protocol to Claude Code over stdio, how it declares and advertises the `browser.*` tool set, how it validates incoming `tools/call` requests, how it routes them through the rate limiter and risky-action gate, how it forwards the validated call into the WebSocket half via an internal `bridge.callExtension(...)` interface, and how it maps `Response` envelopes back into MCP tool results or MCP errors. It also covers bridge process lifecycle — startup, logging, and graceful shutdown on stdin close.

**Out of scope:** the WebSocket server itself (frame framing, connection lifecycle, token auth, origin check) — that belongs to `02-bridge-protocol.md`. The specific list of tool names, their parameter schemas, and their semantics — that belongs to `04-tools.md`; this plan only specifies how tools are *registered* with the MCP server. The rate-limiter and risky-action-gate internals live in `06-autonomy-safety.md`; this plan only specifies their call sites.

---

## 2. Inputs from other plans

- **From `00-overview.md`:** tool name prefix (`browser.`), `Request`/`Response` envelope shape, error code table, default 30 s tool timeout (45 s for `navigate`, up to 120 s for `wait_for`), log file path `~/.browserops/log.jsonl`, repo layout (`packages/bridge/`).
- **From `02-bridge-protocol.md`:** an internal TypeScript interface `BridgeCore` exposing at minimum:
  - `callExtension(method: string, params: object, timeoutMs: number): Promise<Response>` — returns the parsed `Response` envelope, or rejects with a typed `BridgeError` that already carries an `ErrorCode`.
  - `isExtensionConnected(): boolean`
  - `on("connect" | "disconnect", cb): void`
  - `start(): Promise<void>` / `stop(): Promise<void>` for lifecycle.
- **From `04-tools.md`:** the canonical list of tool definitions — an array of `{ name, description, inputSchema }` objects. This plan imports it as `TOOL_DEFS` from `@browserops/shared`.
- **From `06-autonomy-safety.md`:** two pure-ish modules:
  - `rateLimiter.charge(tabId: string, toolName: string): { ok: true } | { ok: false, retryAfterMs: number }`
  - `riskyGate.check(toolName: string, params: object): Promise<{ allow: true } | { allow: false, reason: string }>` — note this is async because some checks (e.g. password-field detection, confirmation popup) round-trip through the extension. The gate is allowed to call `BridgeCore.callExtension` internally for those checks.

---

## 3. Outputs to other plans

- **To `03-extension.md`:** nothing direct — the extension only interacts with the WebSocket side (02).
- **To `04-tools.md`:** a stable contract that every tool in `TOOL_DEFS` will be auto-registered, that its `inputSchema` will be enforced before dispatch, and that its handler receives `(validatedParams, ctx)` where `ctx` carries `{ requestId, tabId?, logger }`.
- **To `06-autonomy-safety.md`:** the call sites where `rateLimiter.charge` and `riskyGate.check` are invoked (documented below), and the guarantee that a denial short-circuits the extension call.
- **To `07-dev-setup.md`:** the startup command (`node packages/bridge/dist/index.js` or `tsx packages/bridge/src/index.ts`) and the fact that the process uses stdin/stdout for MCP and must not write anything non-JSON-RPC to stdout.
- **To `08-testing.md`:** the MCP surface can be exercised end-to-end against a fake `BridgeCore` via the official MCP SDK's in-memory transport.

---

## 4. Design

### 4.1 Package layout

```
packages/bridge/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # entrypoint; wires everything
    ├── mcp/
    │   ├── server.ts         # createMcpServer(deps) → McpServer
    │   ├── register.ts       # registers TOOL_DEFS on the server
    │   ├── dispatch.ts       # validated-params → bridge call → result
    │   ├── errors.ts         # ErrorCode ↔ McpError mapping
    │   └── schema.ts         # Ajv-based inputSchema validator
    ├── logging/
    │   └── jsonl.ts          # append-only writer for ~/.browserops/log.jsonl
    ├── lifecycle.ts          # stdin-close, signal handling, shutdown
    └── ws/                   # (owned by plan 02; referenced, not defined here)
```

### 4.2 Dependencies

- `@modelcontextprotocol/sdk` ≥1.13 (current stable v1.29) — official TypeScript SDK. The ≥1.13 floor is required because that release introduced `structuredContent` + `outputSchema` alongside the 2025-06-18 protocol revision. We use `Server` from `@modelcontextprotocol/sdk/server/index.js` and `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`. Request schemas (`ListToolsRequestSchema`, `CallToolRequestSchema`) and error types (`McpError`, `ErrorCode`) come from `@modelcontextprotocol/sdk/types.js`. We use the low-level `Server` from `@modelcontextprotocol/sdk/server/index.js` rather than the higher-level `McpServer` from `/server/mcp.js` because our tool registry is a single dynamic source-of-truth (`TOOL_DEFS` from @browserops/shared), not a static list of registered tools.
- `ajv` + `ajv-formats` — runtime JSON Schema validation of tool params. Each tool's `inputSchema` is compiled once at server construction.
- `pino` (or plain `fs.appendFile`) — JSONL logging. **Must not** write to stdout; stdout is reserved for MCP. Logger writes to `~/.browserops/log.jsonl` and to stderr for human-readable lines.

### 4.3 Entrypoint — `src/index.ts`

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridgeCore } from "./ws/core.js";          // from plan 02
import { createRateLimiter } from "./safety/rate.js";     // from plan 06
import { createRiskyGate } from "./safety/risky.js";      // from plan 06
import { createLogger } from "./logging/jsonl.js";
import { createMcpServer } from "./mcp/server.js";
import { installLifecycle } from "./lifecycle.js";

async function main() {
  const logger = await createLogger();                    // opens ~/.browserops/log.jsonl
  const bridge = createBridgeCore({ logger });
  await bridge.start();                                   // starts WS server (plan 02)

  const rateLimiter = createRateLimiter();
  const riskyGate   = createRiskyGate({ bridge, logger });

  const server = createMcpServer({ bridge, rateLimiter, riskyGate, logger });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ evt: "mcp_ready" });

  installLifecycle({ server, bridge, logger });
}

main().catch((err) => {
  // Last-ditch: write to stderr, never stdout.
  process.stderr.write(`[browserops-bridge] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
```

**Hard rule:** nothing in this process may `console.log` or otherwise write to stdout except the MCP SDK. Any accidental stdout write corrupts the JSON-RPC framing Claude Code expects. We enforce this with an eslint rule (`no-console`) and, at runtime, by replacing `console.log` with a wrapper that redirects to stderr.

### 4.4 MCP server construction — `src/mcp/server.ts`

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode as McpErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOL_DEFS } from "@browserops/shared";
import { compileSchemas } from "./schema.js";
import { dispatch } from "./dispatch.js";

export function createMcpServer(deps: {
  bridge: BridgeCore;
  rateLimiter: RateLimiter;
  riskyGate: RiskyGate;
  logger: Logger;
}) {
  const server = new Server(
    { name: "browserops", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const validators = compileSchemas(TOOL_DEFS);   // name → Ajv validate fn

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS.map(({ name, description, inputSchema }) => ({
      name, description, inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return dispatch(req, { ...deps, validators });
  });

  return server;
}
```

Notes:

- The server advertises **only** the `tools` capability. No resources, no prompts in v1.
- `TOOL_DEFS` is the single source of truth for both ListTools and CallTool routing. No second registration step.
- `inputSchema` is plain JSON Schema; the MCP SDK passes it through to Claude Code unchanged.

### 4.5 Dispatch — `src/mcp/dispatch.ts`

The per-call pipeline. Order matters:

```
CallToolRequest
  ├─ 1. resolve tool def (unknown name → McpError MethodNotFound)
  ├─ 2. validate params against inputSchema (fail → INVALID_PARAMS)
  ├─ 3. log mcp_in
  ├─ 4. rateLimiter.charge(tabId, name) → if !ok, return RATE_LIMITED
  ├─ 5. riskyGate.check(name, params) → if !allow, return RISKY_ACTION_DENIED
  ├─ 6. bridge.callExtension(method, params, timeoutMs)
  │       timeoutMs per tool (table in §4.7)
  ├─ 7. log ws_out / ws_in (bridge side already logs; dispatch re-logs mcp_out)
  └─ 8. translate Response → MCP tool result  (see §4.6)
```

Sketch:

```ts
export async function dispatch(req, deps) {
  const { name, arguments: rawArgs } = req.params;
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) throw new McpError(McpErrorCode.MethodNotFound, `unknown tool: ${name}`);

  const validate = deps.validators.get(name)!;
  if (!validate(rawArgs)) {
    throw new McpError(
      McpErrorCode.InvalidParams,
      ajvErrorsToString(validate.errors),
    );
  }
  const params = rawArgs as Record<string, unknown>;
  const requestId = crypto.randomUUID();
  const tabId = (params.tab_id as string | undefined) ?? null;

  deps.logger.jsonl({ dir: "mcp_in", id: requestId, method: name, params });

  if (tabId) {
    const charge = deps.rateLimiter.charge(tabId, name);
    if (!charge.ok) {
      return toolErrorResult("RATE_LIMITED",
        `rate limit exceeded for ${tabId}; retry in ${charge.retryAfterMs}ms`);
    }
  }

  const gate = await deps.riskyGate.check(name, params);
  if (!gate.allow) {
    return toolErrorResult("RISKY_ACTION_DENIED", gate.reason);
  }

  const method = name.replace(/^browser\./, "");      // "browser.click" → "click"
  const timeoutMs = timeoutFor(name);

  let resp: Response;
  try {
    resp = await deps.bridge.callExtension(method, params, timeoutMs);
  } catch (e) {
    const code = (e as BridgeError)?.code ?? "INTERNAL";
    deps.logger.jsonl({ dir: "mcp_out", id: requestId, ok: false, code });
    return toolErrorResult(code, (e as Error).message);
  }

  deps.logger.jsonl({
    dir: "mcp_out", id: requestId, ok: resp.ok,
    ...(resp.ok ? {} : { code: resp.error!.code }),
  });

  return resp.ok ? toolOkResult(resp.result) : toolErrorResult(resp.error!.code, resp.error!.message, resp.error!.details);
}
```

### 4.6 Result shape & error mapping — `src/mcp/errors.ts`

MCP `tools/call` responses have two tiers of failure:

1. **Protocol-level failure** — throw `McpError`. Used only for `MethodNotFound` (unknown tool) and `InvalidParams` (schema validation failure). These are bugs in Claude's call, not runtime problems.
2. **Tool-level failure** — return a normal tool result object with `isError: true` and a structured content block. Used for every `ErrorCode` from the overview (`TAB_NOT_FOUND`, `TIMEOUT`, `RATE_LIMITED`, etc.). This lets the model see the error code and decide what to do.

```ts
export function toolOkResult(result: unknown) {
  return {
    content: [
      { type: "text", text: typeof result === "string" ? result : JSON.stringify(result) },
    ],
    structuredContent: result,   // @modelcontextprotocol/sdk ≥1.13 supports this for typed results
    isError: false,
  };
}

export function toolErrorResult(code: ErrorCode, message: string, details?: unknown) {
  const payload = { code, message, ...(details !== undefined && { details }) };
  return {
    content: [{ type: "text", text: `[${code}] ${message}` }],
    structuredContent: { error: payload },
    isError: true,
  };
}
```

Rationale: returning `isError: true` instead of throwing means Claude sees the error code verbatim in its context and can retry intelligently (e.g. re-`read` after `REF_STALE`), which is the whole point of the error code table.

### 4.7 Per-tool timeouts — `timeoutFor`

| Tool | Timeout |
|---|---|
| `browser.navigate` | 45000 ms |
| `browser.wait_for` | value from params, capped at 120000 ms |
| everything else | 30000 ms |

The function lives in `src/mcp/dispatch.ts`. If `04-tools.md` later adds a tool with non-default needs, it updates this table.

**Timeout hierarchy.** Bridge-level `timeout_ms` must be shorter than any MCP-client-side request timeout, so failures surface as `TIMEOUT` tool errors (isError: true) rather than protocol-level `RequestTimeout` (JSON-RPC code −32001).

**MCP cancellation (design note).** MCP cancellation is supported — the handler's `extra.signal` is forwarded to `bridge.callExtension(method, params, timeoutMs, signal)` so cancelled requests abort the in-flight WS request. In SDK v1.29 the `Protocol` class auto-handles `notifications/cancelled` by creating an `AbortController` per inbound request and exposing `extra.signal` to handlers.

**Parameter schema-validation failures** return `INVALID_PARAMS` in a tool result (isError: true), per overview §4.3.

### 4.8 Schema validation — `src/mcp/schema.ts`

```ts
import Ajv from "ajv";
import addFormats from "ajv-formats";

export function compileSchemas(defs: ToolDef[]) {
  const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });
  addFormats(ajv);
  const out = new Map<string, ReturnType<Ajv["compile"]>>();
  for (const def of defs) out.set(def.name, ajv.compile(def.inputSchema));
  return out;
}
```

- `useDefaults: true` so tools can declare defaults (e.g. `full_page: false` for screenshot).
- `strict: true` — unknown keywords in a schema fail at compile time, catching typos in `04-tools.md`.
- Errors are formatted with `ajv.errorsText(errors, { separator: "; " })` for the `InvalidParams` message.

### 4.9 Rate-limiter & risky-gate call sites

Both live in dispatch (§4.5). Contract:

- **Rate limiter is charged only when the call has a `tab_id`.** Tools without a tab (e.g. a hypothetical `browser.list_tabs`) don't touch the limiter. `read` and `screenshot` are half-cost, which the limiter handles internally based on `toolName`.
- **Rate-limiter denial returns `RATE_LIMITED` as a tool-level error** (not thrown). Includes `retryAfterMs` in `details`.
- **Risky gate runs after the rate limiter** so a denied-by-risky call still counts toward zero rate-limit cost (we haven't charged yet because denial is returned as a tool error, and §4.5 charges before calling the gate — see the Open question below).
- **Risky gate may itself make extension calls** (to detect password fields, show the confirmation popup). It uses the same `bridge.callExtension` interface. If the extension is disconnected, the gate returns `{ allow: false, reason: "extension disconnected" }` mapped to `EXTENSION_DISCONNECTED`.

### 4.10 Bridge-disconnected handling

If `isExtensionConnected()` is false at dispatch time, short-circuit with `EXTENSION_DISCONNECTED` *before* charging the limiter or calling the gate — no point consuming budget on a call that cannot land. The risky gate's own internal extension calls also propagate `EXTENSION_DISCONNECTED` cleanly.

Bridge emits `on("disconnect")`; for any in-flight call the WebSocket half is responsible for rejecting its pending promise with `BridgeError({ code: "EXTENSION_DISCONNECTED" })`. Dispatch maps that to a tool-level error.

### 4.11 Logging — `src/logging/jsonl.ts`

- Opens `~/.browserops/log.jsonl` with `fs.createWriteStream(..., { flags: "a" })` at startup. Creates `~/.browserops/` with `0700` if missing.
- One JSON object per line, fields per overview §4.6: `ts`, `dir` (`mcp_in` | `ws_out` | `ws_in` | `mcp_out` | `evt`), `id`, plus method/params/ok/code as applicable.
- Human-readable mirror goes to `stderr` at info level, gated by `BROWSEROPS_LOG=debug|info|warn|error` (default `info`).
- Flushed on every write; closed on shutdown.
- **Never touches stdout.**

### 4.12 Lifecycle — `src/lifecycle.ts`

```ts
export function installLifecycle({ server, bridge, logger }) {
  const shutdown = async (reason: string) => {
    logger.info({ evt: "shutdown", reason });
    try { await server.close(); } catch {}
    try { await bridge.stop(); } catch {}
    try { await logger.close(); } catch {}
    process.exit(0);
  };

  process.stdin.on("end",   () => shutdown("stdin_end"));
  process.stdin.on("close", () => shutdown("stdin_close"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    logger.error({ evt: "uncaught", err: String(err?.stack ?? err) });
    shutdown("uncaught");
  });
  process.on("unhandledRejection", (err) => {
    logger.error({ evt: "unhandled_rejection", err: String(err) });
    // don't exit on rejection; just log.
  });
}
```

Claude Code signals end-of-session by closing the bridge's stdin. That's our primary shutdown trigger. SIGINT/SIGTERM are backup paths for users running the bridge standalone during dev.

### 4.13 Observability — tool-call trace ids

- Every inbound `tools/call` gets a fresh UUIDv4 `requestId`. This is the same id used on the WebSocket `Request` envelope so a single id traces a call end-to-end through the JSONL log.
- Tool results carry no id field (the MCP SDK handles JSON-RPC id mapping). But the log does, so an operator can grep a single id and see mcp_in → ws_out → ws_in → mcp_out.

### 4.14 Versioning & capability

`server.info.version` is `"0.1.0"` for v1. Bump minor for any change to `TOOL_DEFS` (new tool, schema change). This flows through to Claude Code's client negotiation and makes mismatched installs visible in logs.

---

## 5. Risks & mitigations

1. **stdout pollution breaks MCP framing.** A stray `console.log` anywhere in the process (or a dependency) silently corrupts JSON-RPC, manifesting as "Claude sees no tools." *Mitigation:* eslint `no-console`, a runtime shim that redirects `console.*` to stderr, and a smoke test in `08` that pipes stdout through a JSON-RPC parser.
2. **Schema drift between `04-tools.md` and the extension handlers.** Schema accepts a param the extension doesn't implement, or vice versa. *Mitigation:* both sides import `TOOL_DEFS` from `@browserops/shared`; CI contract test calls every tool against a mock extension that asserts it was handed the schema-declared keys.
3. **A slow or hung extension call blocks Claude's session.** If the WebSocket call never resolves, the MCP request hangs and Claude stalls. *Mitigation:* dispatch enforces per-tool timeouts (§4.7) in a `Promise.race` against `setTimeout`, returning a `TIMEOUT` tool error; the bridge also cancels the pending WS request so the extension can GC it.
4. **Risky-gate popup hangs on user inaction.** A confirmation dialog with no user present would deadlock the tool call. *Mitigation:* the gate has its own 30 s deadline (overview §6), after which it resolves as denied; dispatch surfaces `RISKY_ACTION_DENIED`.
5. **Extension reconnects mid-call with a new session, orphaning in-flight ids.** A zombie response could land after the MCP call already timed out. *Mitigation:* bridge keeps a pending-request map keyed by UUID; reconnect clears it and rejects all pending with `EXTENSION_DISCONNECTED`; late responses to unknown ids are logged and dropped.

---

## 6. Open questions

- **Charge order vs. gate order.** Current design charges the rate limiter *before* the risky gate runs. That means a denied-by-risky call still consumes budget. Alternative: run the gate first, so human-denied calls are free. The overview doesn't specify. Recommend flipping to gate-first; flagging here for cross-plan review.
- **Should `browser.read` and `browser.screenshot` be charged at all in v1?** Overview says 0.5 actions, but there's an argument that pure observation should be free so Claude can self-correct without bumping into the limit. Deferred to `06`.
- **`structuredContent` compatibility.** The MCP SDK supports typed structured results from a recent version; confirm the pinned SDK version does, else fall back to `content: [{ type: "text", text: JSON.stringify(...) }]` only.
- **`Origin` header on local WS.** Overview §5 says the bridge accepts only `chrome-extension://<our-extension-id>`. That field is owned by plan 02 but affects how we surface connection failures to the MCP side; no change needed here, just noting the dependency.

---

## 7. Acceptance checklist

- [ ] `packages/bridge/` builds with `tsc` clean and `pnpm --filter bridge test` passes.
- [ ] Running `node packages/bridge/dist/index.js` with stdin closed immediately exits cleanly (no hang).
- [ ] Running under an MCP client (e.g. `@modelcontextprotocol/inspector`) returns the full `browser.*` tool list from a `tools/list` request, matching `TOOL_DEFS` exactly.
- [ ] `tools/call` with an unknown tool name returns a JSON-RPC error with MCP code `MethodNotFound`.
- [ ] `tools/call` with a param that violates the tool's `inputSchema` returns `InvalidParams` and does **not** hit the bridge.
- [ ] `tools/call` with a valid payload, against a fake `BridgeCore` that returns `{ ok: true, result: {...} }`, produces an MCP result with `isError: false` and `structuredContent` equal to the result.
- [ ] `tools/call` against a fake bridge that returns `{ ok: false, error: { code: "TAB_NOT_FOUND", ... } }` produces `isError: true` with `structuredContent.error.code === "TAB_NOT_FOUND"`.
- [ ] Rate-limiter denial returns `isError: true`, `code: "RATE_LIMITED"`, includes `retryAfterMs`, and the bridge is **not** called.
- [ ] Risky-gate denial returns `isError: true`, `code: "RISKY_ACTION_DENIED"`, and the bridge is **not** called (beyond any extension calls the gate itself made).
- [ ] Calls issued while `isExtensionConnected()` is false short-circuit with `EXTENSION_DISCONNECTED` without charging the rate limiter.
- [ ] Per-tool timeouts are enforced: a fake bridge that never resolves produces `TIMEOUT` within 30 s for default tools, 45 s for `navigate`, and ≤ 120 s for `wait_for`.
- [ ] `~/.browserops/log.jsonl` contains exactly four lines for a successful click call: `mcp_in`, `ws_out`, `ws_in`, `mcp_out`, all sharing one `id`.
- [ ] No bytes are written to stdout except MCP JSON-RPC frames (verified by a test that pipes stdout through `JSON.parse` line-by-line).
- [ ] Closing stdin causes the process to call `server.close()`, `bridge.stop()`, flush the log, and exit 0 in under 1 s.
- [ ] SIGINT and SIGTERM follow the same graceful path.
- [ ] Bridge version in `server.info.version` matches `package.json`.
