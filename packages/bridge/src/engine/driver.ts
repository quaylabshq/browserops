/**
 * The pluggable seam. Every agent the chat engine can drive — Claude today,
 * Codex / Cursor later — implements this interface. Each does its own native
 * reading and sending (Claude speaks the `claude` CLI's stream-json protocol;
 * others will differ) and maps both directions onto the shared, agent-agnostic
 * ChatMessage / ChatEvent shapes. The ChatEngine and the HTTP/SSE surface only
 * ever see this interface, so adding an agent is a new driver file — nothing
 * upstream changes.
 */
import type {
  AgentId,
  ChatEvent,
  ChatMessage,
  ChatPageContext,
  SessionRef,
} from "@browserops/shared";

export type ChatEventListener = (event: ChatEvent) => void;
export type Unsubscribe = () => void;

export interface StartOpts {
  /** The tab the user launched from; woven into the seed turn as context. */
  page: ChatPageContext;
  /** The user's first message. */
  instruction?: string;
  /** Working dir to run the agent in (defaults to the engine workspace). */
  cwd?: string;
  /** When true, omit auto-approve / danger flags. */
  safeMode?: boolean;
}

export interface AgentDriver {
  readonly id: AgentId;

  /**
   * Begin a new session and kick off the seed turn (page context + first
   * message). Returns as soon as the session id is known; turn output streams
   * to subscribers. Events emitted before a subscriber attaches are buffered
   * and replayed on `subscribe`.
   */
  start(opts: StartOpts): Promise<SessionRef>;

  /** Send a follow-up user turn into an existing (or resumed) session. */
  send(ref: SessionRef, text: string): Promise<void>;

  /** Stream live events; replays any buffered events first. */
  subscribe(ref: SessionRef, listener: ChatEventListener): Unsubscribe;

  /** Re-read the agent's own transcript into normalized messages. */
  history(ref: SessionRef): Promise<ChatMessage[]>;

  /** Relinquish the session (engine stops writing) — used by the takeover eject. */
  stop(ref: SessionRef): Promise<void>;
}
