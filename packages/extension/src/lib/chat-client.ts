/**
 * Side-panel chat client: talk to the bridge's /chat/* surface and reduce its
 * streamed events into renderable state.
 *
 * The pure pieces (the reducer, the request-body builder, status copy) live
 * here so they unit-test in plain Node; the fetch / EventSource calls are thin
 * wrappers the page invokes. Page metadata capture (grabPageMeta) and clampText
 * are reused from launch-client.
 */
import type {
  ChatEvent,
  ChatAgentStatus,
  ChatMessage,
  ChatSettings,
  ChatSessionCapabilities,
  ChatStatusState,
  SessionRef,
} from "@browserops/shared";
import { clampText, grabPageMeta, type PageMeta } from "./launch-client.js";

export { grabPageMeta };
export type { PageMeta, ChatEvent, ChatMessage, SessionRef };

/** Loopback bridge base. Hardcoded like the onboard page's /pair fetch. */
export const CHAT_BASE = "http://127.0.0.1:57321";

export interface ChatEndpoint {
  host: string;
  port: number;
}

export function chatBase(endpoint?: ChatEndpoint): string {
  if (!endpoint) return CHAT_BASE;
  const host = endpoint.host.trim() || "127.0.0.1";
  const port = Number.isInteger(endpoint.port) && endpoint.port > 0 ? endpoint.port : 57321;
  return `http://${host}:${port}`;
}

export interface SessionSummary extends SessionRef {
  lastActive: number;
  capabilities?: ChatSessionCapabilities;
  /** Transient: the session has a live pty right now (embedded-terminal toggle ok). */
  terminal?: boolean;
}

// --- pure: request body -----------------------------------------------------

export function buildNewBody(input: {
  token: string;
  agent: string;
  instruction?: string;
  meta: PageMeta;
}): Record<string, string> {
  const body: Record<string, string> = {
    token: input.token,
    agent: input.agent,
    url: input.meta.url,
  };
  const instruction = clampText(input.instruction, 8000);
  if (instruction) body["instruction"] = instruction;
  const title = clampText(input.meta.title);
  if (title) body["title"] = title;
  const description = clampText(input.meta.description);
  if (description) body["description"] = description;
  const siteName = clampText(input.meta.siteName);
  if (siteName) body["site_name"] = siteName;
  return body;
}

// --- pure: state reducer ----------------------------------------------------

export interface ChatState {
  session?: SessionRef;
  messages: ChatMessage[];
  status: ChatStatusState;
  /** Provider/bridge detail for a failed status, capped by the bridge. */
  statusDetail?: string;
  ejected: boolean;
  capabilities: ChatSessionCapabilities;
}

export interface ToolActivityItem {
  id: string;
  name: string;
  label: string;
  detail?: string;
  input?: string;
  result?: string;
  ok?: boolean;
  active: boolean;
}

export interface ToolActivity {
  items: ToolActivityItem[];
  active: boolean;
  completed: number;
  latest?: ToolActivityItem;
}

function compactToolValue(value: unknown, cap = 360): string {
  let text: string;
  if (value === undefined || value === null) text = "";
  else if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > cap ? flat.slice(0, cap) + "…" : flat;
}

function asInputRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Plain-text arguments get the generic fallback below.
    }
  }
  return {};
}

function displayToolInput(name: string, input: unknown): string {
  const normalized = name.replace(/^mcp__browserops(?:__|_)?/, "").toLowerCase();
  const args = asInputRecord(input);
  if (normalized === "browser_type" || normalized === "type") {
    const length = typeof args["text"] === "string" ? args["text"].length : 0;
    return length > 0 ? `Text input · ${length} characters` : "Text input";
  }
  if (normalized === "browser_execute_js" || normalized === "execute_js") {
    return "Custom page action";
  }
  return compactToolValue(input);
}

function shortText(value: unknown, cap = 72): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat ? (flat.length > cap ? `${flat.slice(0, cap)}…` : flat) : undefined;
}

function toolPresentation(
  name: string,
  input: unknown,
): Pick<ToolActivityItem, "label" | "detail"> {
  const args = asInputRecord(input);
  const isBrowserOps = name.startsWith("browser_") || name.startsWith("mcp__browserops");
  const raw = name.replace(/^mcp__browserops(?:__|_)?/, "");
  const clean = raw
    .replace(/^browser_/, "")
    .replace(/ToolCall$/, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const text = shortText(args["text"] ?? args["query"]);
  const path = shortText(args["file_path"] ?? args["path"] ?? args["filePath"]);
  const command = shortText(args["command"]);

  if (name.startsWith("mcp__") && !name.startsWith("mcp__browserops")) {
    const [, server = "MCP", tool = "tool"] = name.split("__");
    return { label: `Using ${server}`, detail: tool.replace(/[_-]+/g, " ") };
  }
  switch (clean) {
    case "observe":
      return {
        label: "Inspecting the page",
        detail: shortText(args["mode"]) ?? "Adaptive page view",
      };
    case "read":
      return isBrowserOps
        ? {
            label: "Reading page content",
            detail: shortText(args["mode"]) ?? "Accessible page structure",
          }
        : { label: path ? `Reading ${path}` : "Reading a file" };
    case "quick_read":
      return {
        label: text ? `Finding “${text}”` : "Finding page controls",
        detail: shortText(args["role"]),
      };
    case "navigate": {
      const url = shortText(args["url"]);
      try {
        return url
          ? { label: `Opening ${new URL(url).host}`, detail: new URL(url).pathname || "/" }
          : { label: "Opening a page" };
      } catch {
        return { label: "Opening a page", detail: url };
      }
    }
    case "click_by_text":
      return {
        label: text ? `Clicking “${text}”` : "Clicking a page control",
        detail: shortText(args["role"]),
      };
    case "click":
    case "click_at":
      return {
        label: "Clicking a page control",
        detail: args["ref"] !== undefined ? `Control ${String(args["ref"])}` : undefined,
      };
    case "type":
      return {
        label: "Entering text",
        detail: typeof args["text"] === "string" ? `${args["text"].length} characters` : undefined,
      };
    case "press":
      return {
        label: "Using the keyboard",
        detail: Array.isArray(args["keys"]) ? args["keys"].join(" + ") : undefined,
      };
    case "hover":
      return { label: "Inspecting a menu" };
    case "screenshot":
      return { label: "Capturing the page" };
    case "execute_js":
      return { label: "Running a custom page action" };
    case "procedures_execute":
      return { label: "Running a saved browser workflow", detail: shortText(args["name"]) };
    case "procedures_search":
      return { label: "Finding a saved browser workflow" };
    case "command_execution":
    case "bash":
    case "shell":
      return { label: "Running a command", detail: command };
    case "read_file":
      return { label: path ? `Reading ${path}` : "Reading a file" };
    case "write":
    case "write_file":
      return { label: path ? `Writing ${path}` : "Writing a file" };
    case "edit":
    case "edit_file":
      return { label: path ? `Editing ${path}` : "Editing a file" };
    case "file_change": {
      const changes = Array.isArray(args["changes"]) ? args["changes"] : [];
      return {
        label: `Updating ${changes.length || "some"} file${changes.length === 1 ? "" : "s"}`,
      };
    }
    case "web_search":
      return { label: text ? `Searching for “${text}”` : "Searching the web" };
    default:
      return { label: clean.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()) };
  }
}

/** Collapse provider-specific tool blocks into one panel-level activity feed. */
export function collectToolActivity(messages: readonly ChatMessage[]): ToolActivity {
  const items: ToolActivityItem[] = [];
  const byId = new Map<string, ToolActivityItem>();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind === "tool_use") {
        const presentation = toolPresentation(block.name, block.input);
        const item: ToolActivityItem = {
          id: block.id,
          name: block.name,
          ...presentation,
          input: displayToolInput(block.name, block.input),
          active: true,
        };
        items.push(item);
        byId.set(block.id, item);
      } else if (block.kind === "tool_result") {
        const item = byId.get(block.id);
        if (item) {
          item.active = false;
          item.ok = block.ok;
          item.result = compactToolValue(block.preview);
        } else {
          const orphan: ToolActivityItem = {
            id: block.id,
            name: "browser_action",
            label: "Browser action",
            result: compactToolValue(block.preview),
            ok: block.ok,
            active: false,
          };
          items.push(orphan);
          byId.set(block.id, orphan);
        }
      }
    }
  }
  const activeItems = items.filter((item) => item.active);
  return {
    items,
    active: activeItems.length > 0,
    completed: items.length - activeItems.length,
    latest: activeItems.at(-1) ?? items.at(-1),
  };
}

export function initialChatState(): ChatState {
  return {
    messages: [],
    status: "idle",
    ejected: false,
    capabilities: {
      embeddedTerminal: false,
      externalTakeover: false,
      migrationSource: true,
      migrationTarget: true,
    },
  };
}

const OPTIMISTIC_PREFIX = "local-";
const isOptimistic = (id: string): boolean => id.startsWith(OPTIMISTIC_PREFIX);

/**
 * Append, or replace by id when a message re-emits (streaming).
 *
 * One extra case for the terminal transport: the panel echoes the user's turn
 * optimistically on send (id `local-*`), and the pty tailer ALSO emits that turn
 * as a real transcript record (id = uuid, text flattened to one line / the seed
 * wrapped with page context). To avoid a duplicate bubble, a real user record
 * reconciles the oldest pending optimistic echo — adopting the real id but
 * KEEPING the user's original text. A user record with no pending echo (a turn
 * typed directly in the terminal, or one streamed in after an external eject)
 * just appends, which is exactly the live read-only mirror.
 */
function upsertMessage(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === incoming.id);
  if (idx >= 0) {
    const next = messages.slice();
    next[idx] = incoming;
    return next;
  }
  if (incoming.role === "user" && !isOptimistic(incoming.id)) {
    const incomingText = userMessageText(incoming);
    const pending = messages.findIndex(
      (m) => m.role === "user" && isOptimistic(m.id) && userMessageText(m) === incomingText,
    );
    if (pending >= 0) {
      const next = messages.slice();
      next[pending] = { ...messages[pending]!, id: incoming.id };
      return next;
    }
    // Cursor and other CLIs can replay a submitted prompt in their stream.
    // BrowserOps already rendered the canonical user event, so ignore an exact
    // replay instead of adding a second user bubble.
    if (
      incomingText.length > 0 &&
      messages.some(
        (m) => m.role === "user" && !isOptimistic(m.id) && userMessageText(m) === incomingText,
      )
    ) {
      return messages;
    }
  }
  return [...messages, incoming];
}

function userMessageText(message: ChatMessage): string {
  return message.blocks
    .filter(
      (block): block is Extract<ChatMessage["blocks"][number], { kind: "text" }> =>
        block.kind === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

export function reduceChat(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "session":
      return { ...state, session: event.ref };
    case "message":
      return { ...state, messages: upsertMessage(state.messages, event.message) };
    case "status":
      return {
        ...state,
        status: event.state,
        statusDetail: event.state === "error" ? event.detail : undefined,
        ejected: state.ejected || event.state === "ejected",
        // Ejected to an external terminal → the daemon no longer owns a pty, so
        // the embedded-terminal toggle is no longer available.
        capabilities:
          event.state === "ejected"
            ? { ...state.capabilities, embeddedTerminal: false, externalTakeover: false }
            : state.capabilities,
      };
    case "end":
      return { ...state, status: "idle" };
    default:
      return state;
  }
}

let optimisticSeq = 0;

/** The user's own turn isn't echoed by the R2 stream, so we add it optimistically. */
export function appendUserMessage(state: ChatState, text: string): ChatState {
  const message: ChatMessage = {
    id: `${OPTIMISTIC_PREFIX}${++optimisticSeq}`,
    role: "user",
    blocks: [{ kind: "text", text }],
  };
  return {
    ...state,
    messages: [...state.messages, message],
    status: "thinking",
    statusDetail: undefined,
  };
}

export function statusLabel(
  status: ChatStatusState,
  ejected: boolean,
  detail?: string,
  agent?: string,
): string {
  if (ejected) return "Controlled in your terminal";
  const provider = agent === "codex" ? "Codex" : agent === "cursor" ? "Cursor" : "Claude";
  switch (status) {
    case "starting":
      return "Starting…";
    case "thinking":
      return "Working…";
    case "error":
      if (detail === "agent_not_found") {
        return `${provider} CLI is unavailable. Install or sign in, then retry.`;
      }
      return detail ? `${provider} couldn’t start: ${detail}` : "Something went wrong";
    default:
      return "";
  }
}

// --- impure: bridge calls ---------------------------------------------------

async function postJson(path: string, body: unknown, endpoint?: ChatEndpoint): Promise<Response> {
  return fetch(`${chatBase(endpoint)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await res.json();
    return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface NewResult {
  ok: boolean;
  session?: SessionRef;
  /** Whether the new session has a live pty (offer the embedded-terminal toggle). */
  terminal?: boolean;
  capabilities?: ChatSessionCapabilities;
  status: number;
  error?: string;
}

export async function chatNew(input: {
  token: string;
  agent: string;
  instruction?: string;
  meta: PageMeta;
  endpoint?: ChatEndpoint;
}): Promise<NewResult> {
  let res: Response;
  try {
    res = await postJson("/chat/new", buildNewBody(input), input.endpoint);
  } catch {
    return { ok: false, status: 0, error: "unreachable" };
  }
  const data = await readJson(res);
  return {
    ok: res.ok && data["ok"] === true,
    session: data["session"] as SessionRef | undefined,
    capabilities: data["capabilities"] as ChatSessionCapabilities | undefined,
    terminal: data["terminal"] === true,
    status: res.status,
    error: typeof data["error"] === "string" ? data["error"] : undefined,
  };
}

export async function chatSend(
  token: string,
  sessionId: string,
  text: string,
  endpoint?: ChatEndpoint,
): Promise<{ ok: boolean; status: number; error?: string }> {
  let res: Response;
  try {
    res = await postJson("/chat/send", { token, session_id: sessionId, text }, endpoint);
  } catch {
    return { ok: false, status: 0, error: "unreachable" };
  }
  const data = await readJson(res);
  return {
    ok: res.ok,
    status: res.status,
    error: typeof data["error"] === "string" ? data["error"] : undefined,
  };
}

/** Interrupt the current answer without ending or discarding the conversation. */
export async function chatCancel(
  token: string,
  sessionId: string,
  endpoint?: ChatEndpoint,
): Promise<{ ok: boolean; status: number; error?: string }> {
  let res: Response;
  try {
    res = await postJson("/chat/cancel", { token, session_id: sessionId }, endpoint);
  } catch {
    return { ok: false, status: 0, error: "unreachable" };
  }
  const data = await readJson(res);
  return {
    ok: res.ok && data["ok"] !== false,
    status: res.status,
    error: typeof data["error"] === "string" ? data["error"] : undefined,
  };
}

export async function chatTerminal(
  token: string,
  sessionId: string,
  mode: "mirror" | "takeover",
  endpoint?: ChatEndpoint,
): Promise<{ ok: boolean; error?: string }> {
  let res: Response;
  try {
    res = await postJson("/chat/terminal", { token, session_id: sessionId, mode }, endpoint);
  } catch {
    return { ok: false, error: "unreachable" };
  }
  const data = await readJson(res);
  return {
    ok: res.ok && data["ok"] !== false,
    error: typeof data["error"] === "string" ? data["error"] : undefined,
  };
}

export async function chatMigrate(input: {
  token: string;
  sessionId: string;
  targetAgent: string;
  endpoint?: ChatEndpoint;
}): Promise<NewResult> {
  let res: Response;
  try {
    res = await postJson(
      "/chat/migrate",
      {
        token: input.token,
        session_id: input.sessionId,
        target_agent: input.targetAgent,
      },
      input.endpoint,
    );
  } catch {
    return { ok: false, status: 0, error: "unreachable" };
  }
  const data = await readJson(res);
  return {
    ok: res.ok && data["ok"] === true,
    session: data["session"] as SessionRef | undefined,
    capabilities: data["capabilities"] as ChatSessionCapabilities | undefined,
    terminal: data["terminal"] === true,
    status: res.status,
    error: typeof data["error"] === "string" ? data["error"] : undefined,
  };
}

export async function chatSessions(
  token: string,
  endpoint?: ChatEndpoint,
): Promise<SessionSummary[]> {
  try {
    const res = await fetch(
      `${chatBase(endpoint)}/chat/sessions?token=${encodeURIComponent(token)}`,
    );
    const data = await readJson(res);
    return Array.isArray(data["sessions"]) ? (data["sessions"] as SessionSummary[]) : [];
  } catch {
    return [];
  }
}

export async function chatHistory(
  token: string,
  sessionId: string,
  endpoint?: ChatEndpoint,
): Promise<ChatMessage[]> {
  try {
    const res = await fetch(
      `${chatBase(endpoint)}/chat/history?token=${encodeURIComponent(token)}&session_id=${encodeURIComponent(sessionId)}`,
    );
    const data = await readJson(res);
    return Array.isArray(data["messages"]) ? (data["messages"] as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

export function streamUrl(token: string, sessionId: string, endpoint?: ChatEndpoint): string {
  return `${chatBase(endpoint)}/chat/stream?token=${encodeURIComponent(token)}&session_id=${encodeURIComponent(sessionId)}`;
}

/** The /chat/pty WebSocket URL for the embedded terminal (ws://, token in the query like SSE). */
export function ptyUrl(token: string, sessionId: string, endpoint?: ChatEndpoint): string {
  const base = chatBase(endpoint).replace(/^http/, "ws");
  return `${base}/chat/pty?token=${encodeURIComponent(token)}&session_id=${encodeURIComponent(sessionId)}`;
}

export async function chatSettings(
  token: string,
  endpoint?: ChatEndpoint,
): Promise<ChatSettings | undefined> {
  try {
    const res = await fetch(
      `${chatBase(endpoint)}/chat/settings?token=${encodeURIComponent(token)}`,
    );
    const data = await readJson(res);
    return res.ok ? (data["settings"] as ChatSettings | undefined) : undefined;
  } catch {
    return undefined;
  }
}

export async function chatUpdateSettings(
  token: string,
  update: {
    defaultAgent?: string;
    safeMode?: boolean;
    transport?: "terminal" | "headless";
    models?: Record<string, string>;
    reasoningEfforts?: Record<string, string>;
  },
  endpoint?: ChatEndpoint,
): Promise<ChatSettings | undefined> {
  try {
    const res = await postJson(
      "/chat/settings",
      {
        token,
        ...(update.defaultAgent !== undefined ? { default_agent: update.defaultAgent } : {}),
        ...(update.safeMode !== undefined ? { safe_mode: update.safeMode } : {}),
        ...(update.transport !== undefined ? { transport: update.transport } : {}),
        ...(update.models !== undefined ? { models: update.models } : {}),
        ...(update.reasoningEfforts !== undefined
          ? { reasoning_efforts: update.reasoningEfforts }
          : {}),
      },
      endpoint,
    );
    const data = await readJson(res);
    return res.ok ? (data["settings"] as ChatSettings | undefined) : undefined;
  } catch {
    return undefined;
  }
}

export async function chatAgents(
  token: string,
  endpoint?: ChatEndpoint,
): Promise<ChatAgentStatus[]> {
  try {
    const res = await fetch(`${chatBase(endpoint)}/chat/agents?token=${encodeURIComponent(token)}`);
    const data = await readJson(res);
    return Array.isArray(data["agents"]) ? (data["agents"] as ChatAgentStatus[]) : [];
  } catch {
    return [];
  }
}

export async function chatConfigureAgent(
  token: string,
  agent: string,
  endpoint?: ChatEndpoint,
): Promise<{ ok: boolean; status: number; error?: string; agent?: ChatAgentStatus }> {
  try {
    const res = await postJson("/chat/agents/configure", { token, agent }, endpoint);
    const data = await readJson(res);
    return {
      ok: res.ok && data["ok"] === true,
      status: res.status,
      ...(typeof data["error"] === "string" ? { error: data["error"] } : {}),
      ...(isAgentStatus(data["agent"]) ? { agent: data["agent"] } : {}),
    };
  } catch {
    return { ok: false, status: 0 };
  }
}

function isAgentStatus(value: unknown): value is ChatAgentStatus {
  return typeof value === "object" && value !== null && "agent" in value && "available" in value;
}

/** Client→server pty frames. Raw pty output comes back the other way, unframed. */
export function ptyInputFrame(data: string): string {
  return JSON.stringify({ type: "input", data });
}
export function ptyResizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ type: "resize", cols, rows });
}
