/**
 * Normalized chat vocabulary shared by the bridge's agent engine and the
 * extension's side-panel chat client.
 *
 * The point of this module is agent-agnosticism. Each agent driver (Claude
 * today; Codex / Cursor later) reads and sends messages in its own native
 * format — Claude speaks the `claude` CLI's stream-json protocol; others will
 * differ — and maps both directions onto the shapes here. The HTTP/SSE surface
 * and the side-panel UI only ever see these normalized types, so neither
 * depends on any particular agent's wire protocol.
 *
 * Two feeds normalize into the same `ChatMessage`:
 *  - live: `--output-format stream-json` events streamed off the agent process;
 *  - history: the agent's own on-disk transcript, re-read by session id.
 */
import type { AgentId } from "./agents.js";

export type ChatRole = "user" | "assistant" | "system" | "tool";

export const CHAT_ROLES = ["user", "assistant", "system", "tool"] as const;

export function isChatRole(value: unknown): value is ChatRole {
  return typeof value === "string" && (CHAT_ROLES as readonly string[]).includes(value);
}

/**
 * One renderable unit of a turn. `thinking` carries reasoning text (the
 * cryptographic signature is dropped on normalize); `tool_result.preview` is a
 * length-capped, already-stringified rendering of the raw result.
 */
export type ChatBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; ok: boolean; preview: string };

export interface ChatMessage {
  /** Stable id from the native transcript when available, else synthesised. */
  id: string;
  role: ChatRole;
  blocks: ChatBlock[];
  /** Epoch ms when the message was produced, if the source records it. */
  ts?: number;
  /** True while streaming partial deltas before the turn closes. */
  partial?: boolean;
}

/** A started conversation, addressable by its native session id. */
export interface SessionRef {
  agent: AgentId;
  /** Native session id (Claude uuid; later Codex / Cursor ids). */
  sessionId: string;
  /** Working dir the agent ran in — needed to locate Claude's transcript. */
  cwd: string;
  title?: string;
  createdAt: number;
}

export type ChatStatusState = "starting" | "thinking" | "idle" | "ejected" | "error";

/** Server→client events streamed over SSE to the panel. */
export type ChatEvent =
  | { type: "session"; ref: SessionRef }
  | { type: "message"; message: ChatMessage }
  | { type: "status"; state: ChatStatusState; detail?: string }
  | { type: "end"; reason: string };

/**
 * Lightweight context about the tab the user launched from. Sent with the first
 * turn and woven into the agent's seed prompt; the agent decides relevance.
 */
export interface ChatPageContext {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
}

/**
 * How a live session can be surfaced in a real terminal:
 *  - `mirror`:   read-only `tail` of the engine's mirror log; engine keeps driving.
 *  - `takeover`: stop the engine and hand the session to an interactive
 *                `claude --resume <id>` — the terminal becomes the sole writer.
 */
export const TERMINAL_MODES = ["mirror", "takeover"] as const;
export type TerminalMode = (typeof TERMINAL_MODES)[number];

export function isTerminalMode(value: unknown): value is TerminalMode {
  return typeof value === "string" && (TERMINAL_MODES as readonly string[]).includes(value);
}
