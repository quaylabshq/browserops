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
 * Provider streams and native transcripts are ingress feeds. BrowserOps writes
 * their normalized events to its own canonical session journal; provider
 * transcripts are only a compatibility import / native-resume detail.
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

/**
 * The public handle for a BrowserOps conversation. `sessionId` is minted by
 * BrowserOps and never changes when the active inference provider changes.
 */
export interface SessionRef {
  agent: AgentId;
  /** BrowserOps-owned stable conversation id. */
  sessionId: string;
  /** Native id for the currently active provider binding, if it has one. */
  nativeSessionId?: string;
  /** The active provider binding within this BrowserOps conversation. */
  bindingId?: string;
  /** Immutable model selected when this session was created. */
  model?: string;
  /** Immutable reasoning-effort selected when this session was created. */
  reasoningEffort?: string;
  /** Working dir the agent ran in — needed to locate Claude's transcript. */
  cwd: string;
  title?: string;
  createdAt: number;
  /** Source BrowserOps session id when this session was migrated from another agent. */
  migratedFrom?: string;
  /** Source agent for a migrated session. */
  migrationSourceAgent?: AgentId;
}

/** Provider-local state attached to a canonical BrowserOps conversation. */
export interface ChatProviderBinding {
  id: string;
  sessionId: string;
  agent: AgentId;
  /** Driver-local handle; may differ from the provider's eventual native id. */
  driverSessionId: string;
  nativeSessionId?: string;
  cwd: string;
  createdAt: number;
  model?: string;
  reasoningEffort?: string;
  /** Only one writer may own a binding at a time. */
  mode: "bridge" | "terminal" | "paused" | "stopped";
  /** Last canonical event delivered to this provider projection. */
  lastProjectedSequence: number;
}

export interface ChatEventMeta {
  /** Monotonic BrowserOps event number, assigned by the canonical session store. */
  sequence?: number;
  /** Durable event id, useful when an SSE client reconnects. */
  eventId?: string;
}

/**
 * Persisted preferences for the in-panel chat engine. Provider credentials stay
 * with the provider CLIs; this only stores non-secret routing preferences.
 */
export interface ChatSettings {
  defaultAgent: AgentId;
  /** Model override per provider. Omitted means use that provider's CLI default. */
  models: Partial<Record<AgentId, string>>;
  /** Optional per-provider reasoning effort accepted by the corresponding CLI. */
  reasoningEfforts: Partial<Record<AgentId, string>>;
  /** Restore normal provider approval prompts when true. */
  safeMode: boolean;
  /** Claude's panel transport. A change takes effect after a daemon restart. */
  transport: "terminal" | "headless";
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = {
  defaultAgent: "claude",
  models: {},
  reasoningEfforts: {},
  safeMode: false,
  transport: "terminal",
};

/** Runtime availability, surfaced before the panel lets a user choose an agent. */
export interface ChatAgentStatus {
  agent: AgentId;
  available: boolean;
  /** Installed CLI version when cheaply available; never a credential. */
  version?: string;
  reason?: string;
}

export interface ChatSessionCapabilities {
  embeddedTerminal: boolean;
  externalTakeover: boolean;
  migrationSource: boolean;
  migrationTarget: boolean;
}

export const DEFAULT_CHAT_SESSION_CAPABILITIES: ChatSessionCapabilities = {
  embeddedTerminal: false,
  externalTakeover: false,
  migrationSource: true,
  migrationTarget: true,
};

export type ChatStatusState = "starting" | "thinking" | "idle" | "ejected" | "error";

/** Server→client events streamed over SSE to the panel. */
export type ChatEvent =
  | ({ type: "session"; ref: SessionRef } & ChatEventMeta)
  | ({ type: "message"; message: ChatMessage } & ChatEventMeta)
  | ({ type: "status"; state: ChatStatusState; detail?: string } & ChatEventMeta)
  | ({ type: "end"; reason: string } & ChatEventMeta);

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
