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
  ChatMessage,
  ChatSessionCapabilities,
  ChatStatusState,
  SessionRef,
} from "@browserops/shared";
import { clampText, grabPageMeta, type PageMeta } from "./launch-client.js";

export { grabPageMeta };
export type { PageMeta, ChatEvent, ChatMessage, SessionRef };

/** Loopback bridge base. Hardcoded like the onboard page's /pair fetch. */
export const CHAT_BASE = "http://127.0.0.1:57321";

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
  ejected: boolean;
  capabilities: ChatSessionCapabilities;
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
    const pending = messages.findIndex((m) => m.role === "user" && isOptimistic(m.id));
    if (pending >= 0) {
      const next = messages.slice();
      next[pending] = { ...messages[pending]!, id: incoming.id };
      return next;
    }
  }
  return [...messages, incoming];
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
  return { ...state, messages: [...state.messages, message], status: "thinking" };
}

export function statusLabel(status: ChatStatusState, ejected: boolean): string {
  if (ejected) return "Controlled in your terminal";
  switch (status) {
    case "starting":
      return "Starting…";
    case "thinking":
      return "Working…";
    case "error":
      return "Something went wrong";
    default:
      return "";
  }
}

// --- impure: bridge calls ---------------------------------------------------

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${CHAT_BASE}${path}`, {
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
}): Promise<NewResult> {
  let res: Response;
  try {
    res = await postJson("/chat/new", buildNewBody(input));
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
): Promise<{ ok: boolean; status: number; error?: string }> {
  let res: Response;
  try {
    res = await postJson("/chat/send", { token, session_id: sessionId, text });
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

export async function chatTerminal(
  token: string,
  sessionId: string,
  mode: "mirror" | "takeover",
): Promise<{ ok: boolean; error?: string }> {
  let res: Response;
  try {
    res = await postJson("/chat/terminal", { token, session_id: sessionId, mode });
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
}): Promise<NewResult> {
  let res: Response;
  try {
    res = await postJson("/chat/migrate", {
      token: input.token,
      session_id: input.sessionId,
      target_agent: input.targetAgent,
    });
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

export async function chatSessions(token: string): Promise<SessionSummary[]> {
  try {
    const res = await fetch(`${CHAT_BASE}/chat/sessions?token=${encodeURIComponent(token)}`);
    const data = await readJson(res);
    return Array.isArray(data["sessions"]) ? (data["sessions"] as SessionSummary[]) : [];
  } catch {
    return [];
  }
}

export async function chatHistory(token: string, sessionId: string): Promise<ChatMessage[]> {
  try {
    const res = await fetch(
      `${CHAT_BASE}/chat/history?token=${encodeURIComponent(token)}&session_id=${encodeURIComponent(sessionId)}`,
    );
    const data = await readJson(res);
    return Array.isArray(data["messages"]) ? (data["messages"] as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

export function streamUrl(token: string, sessionId: string): string {
  return `${CHAT_BASE}/chat/stream?token=${encodeURIComponent(token)}&session_id=${encodeURIComponent(sessionId)}`;
}

/** The /chat/pty WebSocket URL for the embedded terminal (ws://, token in the query like SSE). */
export function ptyUrl(token: string, sessionId: string): string {
  const base = CHAT_BASE.replace(/^http/, "ws");
  return `${base}/chat/pty?token=${encodeURIComponent(token)}&session_id=${encodeURIComponent(sessionId)}`;
}

/** Client→server pty frames. Raw pty output comes back the other way, unframed. */
export function ptyInputFrame(data: string): string {
  return JSON.stringify({ type: "input", data });
}
export function ptyResizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ type: "resize", cols, rows });
}
