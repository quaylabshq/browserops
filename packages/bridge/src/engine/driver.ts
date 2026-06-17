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

  /** Tear the session down completely (kill the process, end the stream). */
  stop(ref: SessionRef): Promise<void>;

  /**
   * Hand the session to an external terminal (the takeover eject): the driver
   * stops being a *writer* but may keep a read-only mirror alive. The pty
   * transport kills its own pty (one writer at a time) yet keeps tailing the
   * transcript the external `claude --resume` writes, so the panel chat stays a
   * live read-only view. Optional — drivers without a distinct eject (the
   * headless driver, whose `stop()` is already a soft eject) omit it and the
   * engine falls back to {@link stop}.
   */
  relinquish?(ref: SessionRef): Promise<void>;
}

/** A live raw-terminal handle the WS bridge binds an embedded xterm pane to. */
export interface TerminalHandle {
  /** Subscribe to raw pty output; the bounded scrollback is replayed first. */
  onData(listener: (data: string) => void): Unsubscribe;
  /** Forward keystrokes typed in the pane back to the pty. */
  write(data: string): void;
  /** Resize the pty to match the pane geometry. */
  resize(cols: number, rows: number): void;
}

/**
 * An optional capability on top of {@link AgentDriver}: exposing the live session
 * as a real terminal so the panel can embed an xterm pane (over `/chat/pty`).
 * Drivers that don't run a tty (the headless Claude driver) simply omit it.
 */
export interface TerminalAttachable {
  attachTerminal(ref: SessionRef): TerminalHandle;
  /**
   * Whether this ref currently has a live pty to attach (false once the session
   * has been stopped or ejected to an external terminal). Lets the engine tell
   * the panel whether to offer the embedded-terminal toggle.
   */
  terminalLive?(ref: SessionRef): boolean;
}

export function isTerminalAttachable(
  driver: AgentDriver,
): driver is AgentDriver & TerminalAttachable {
  return typeof (driver as Partial<TerminalAttachable>).attachTerminal === "function";
}
