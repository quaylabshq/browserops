/**
 * ChatEngine — the agent-agnostic orchestrator the HTTP/SSE surface talks to.
 *
 * It owns the driver registry (one per agent), the session index, and an
 * in-memory ref cache. Everything is keyed by session id: the panel sends a
 * session id, the engine resolves it to a SessionRef (from the live cache, or
 * cold from the index after a daemon restart) and routes to the owning driver.
 * Adding an agent = registering its driver here; nothing else changes.
 */
import type { AgentId, ChatMessage, ChatPageContext, SessionRef } from "@browserops/shared";
import type { Logger } from "../logger.js";
import { isTerminalAttachable } from "./driver.js";
import type {
  AgentDriver,
  ChatEventListener,
  StartOpts,
  TerminalHandle,
  Unsubscribe,
} from "./driver.js";
import { ClaudeDriver } from "./claude/driver.js";
import { EngineError, engineErrorCode } from "./errors.js";
import { SessionIndex, type SessionMeta } from "./sessions.js";

export interface StartRequest {
  agent: AgentId;
  page: ChatPageContext;
  instruction?: string;
  cwd?: string;
  safeMode?: boolean;
}

export interface ChatEngineDeps {
  /** Override or extend the default driver set (claude). Tests inject fakes. */
  drivers?: Partial<Record<AgentId, AgentDriver>>;
  /**
   * Per-agent fallback driver, used when the primary's start() reports
   * `pty_unavailable` (terminal transport requested but node-pty can't load).
   * The driver that wins is remembered per session so later calls route to it.
   */
  fallbacks?: Partial<Record<AgentId, AgentDriver>>;
  index?: SessionIndex;
  logger?: Logger;
  now?: () => number;
}

export class ChatEngine {
  private readonly drivers = new Map<AgentId, AgentDriver>();
  private readonly fallbacks = new Map<AgentId, AgentDriver>();
  private readonly sessionDrivers = new Map<string, AgentDriver>();
  private readonly index: SessionIndex;
  private readonly refs = new Map<string, SessionRef>();
  private readonly now: () => number;
  private readonly logger?: Logger;

  constructor(deps: ChatEngineDeps = {}) {
    this.logger = deps.logger;
    const provided = deps.drivers ?? {};
    if (Object.keys(provided).length > 0) {
      for (const [id, driver] of Object.entries(provided)) {
        if (driver) this.drivers.set(id as AgentId, driver);
      }
    } else {
      this.drivers.set("claude", new ClaudeDriver(deps.logger ? { logger: deps.logger } : {}));
    }
    for (const [id, driver] of Object.entries(deps.fallbacks ?? {})) {
      if (driver) this.fallbacks.set(id as AgentId, driver);
    }
    this.index = deps.index ?? new SessionIndex();
    this.now = deps.now ?? (() => Date.now());
  }

  /** Begin a new session; the seed turn streams to subscribers. */
  async start(req: StartRequest): Promise<SessionRef> {
    const opts: StartOpts = {
      page: req.page,
      ...(req.instruction !== undefined ? { instruction: req.instruction } : {}),
      ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
      ...(req.safeMode !== undefined ? { safeMode: req.safeMode } : {}),
    };
    const primary = this.driverFor(req.agent);
    let owner = primary;
    let ref: SessionRef;
    try {
      ref = await primary.start(opts);
    } catch (err) {
      const fallback = this.fallbacks.get(req.agent);
      if (fallback && engineErrorCode(err) === "pty_unavailable") {
        void this.logger?.write({
          dir: "system",
          event: "chat_transport_fallback",
          agent: req.agent,
          detail: "pty_unavailable",
        });
        owner = fallback;
        ref = await fallback.start(opts);
      } else {
        throw err;
      }
    }
    this.sessionDrivers.set(ref.sessionId, owner);
    this.refs.set(ref.sessionId, ref);
    await this.index.upsert({ ...ref, lastActive: this.now() });
    return ref;
  }

  async send(sessionId: string, text: string): Promise<void> {
    const ref = await this.resolveRef(sessionId);
    await this.index.touch(sessionId, this.now());
    await this.driverForSession(sessionId, ref.agent).send(ref, text);
  }

  async subscribe(sessionId: string, listener: ChatEventListener): Promise<Unsubscribe> {
    const ref = await this.resolveRef(sessionId);
    return this.driverForSession(sessionId, ref.agent).subscribe(ref, listener);
  }

  async history(sessionId: string): Promise<ChatMessage[]> {
    const ref = await this.resolveRef(sessionId);
    return this.driverForSession(sessionId, ref.agent).history(ref);
  }

  /** Tear a session down completely (kill the process, end the stream). */
  async stop(sessionId: string): Promise<SessionRef> {
    const ref = await this.resolveRef(sessionId);
    await this.driverForSession(sessionId, ref.agent).stop(ref);
    await this.index.touch(sessionId, this.now());
    return ref;
  }

  /**
   * Eject: hand the session to an external terminal. Prefers the driver's
   * {@link AgentDriver.relinquish} (the pty transport kills its pty but keeps a
   * read-only transcript mirror alive); falls back to {@link AgentDriver.stop}
   * for drivers without a distinct eject (the headless driver's soft-eject).
   */
  async eject(sessionId: string): Promise<SessionRef> {
    const ref = await this.resolveRef(sessionId);
    const driver = this.driverForSession(sessionId, ref.agent);
    if (driver.relinquish) await driver.relinquish(ref);
    else await driver.stop(ref);
    await this.index.touch(sessionId, this.now());
    return ref;
  }

  /**
   * Bind a raw terminal handle for the embedded xterm pane. Live sessions only —
   * a cold (post-restart) session has no live pty, and a session driven by a
   * non-terminal driver (the headless fallback) reports `pty_unavailable`.
   */
  attachTerminal(sessionId: string): TerminalHandle {
    const ref = this.refs.get(sessionId);
    if (!ref) throw new EngineError("unknown_session");
    const driver = this.driverForSession(sessionId, ref.agent);
    if (!isTerminalAttachable(driver)) throw new EngineError("pty_unavailable");
    return driver.attachTerminal(ref);
  }

  /**
   * Whether the panel should offer the embedded-terminal toggle for a session:
   * it must be live and driven by a terminal-attachable driver that still owns
   * its pty — false for the headless fallback, cold post-restart sessions, and
   * sessions already ejected to an external terminal.
   */
  terminalCapable(sessionId: string): boolean {
    const ref = this.refs.get(sessionId);
    if (!ref) return false;
    const driver = this.driverForSession(sessionId, ref.agent);
    if (!isTerminalAttachable(driver)) return false;
    return driver.terminalLive ? driver.terminalLive(ref) : true;
  }

  listSessions(): Promise<SessionMeta[]> {
    return this.index.load();
  }

  getSession(sessionId: string): Promise<SessionMeta | undefined> {
    return this.index.get(sessionId);
  }

  // --- internals ------------------------------------------------------------

  private driverFor(agent: AgentId): AgentDriver {
    const driver = this.drivers.get(agent);
    if (!driver) throw new EngineError("agent_unavailable");
    return driver;
  }

  /**
   * Route to the driver that actually owns the session — the primary, or the
   * fallback that took over at start(). Cold sessions reconstructed after a
   * daemon restart fall back to the agent's primary (best-effort).
   */
  private driverForSession(sessionId: string, agent: AgentId): AgentDriver {
    return this.sessionDrivers.get(sessionId) ?? this.driverFor(agent);
  }

  /** Live ref if we have it, else reconstruct from the index (cold resume). */
  private async resolveRef(sessionId: string): Promise<SessionRef> {
    const cached = this.refs.get(sessionId);
    if (cached) return cached;
    const meta = await this.index.get(sessionId);
    if (!meta) throw new EngineError("unknown_session");
    const ref: SessionRef = {
      agent: meta.agent,
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      ...(meta.title !== undefined ? { title: meta.title } : {}),
    };
    this.refs.set(sessionId, ref);
    return ref;
  }
}
