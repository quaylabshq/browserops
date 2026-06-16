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
import type { AgentDriver, ChatEventListener, Unsubscribe } from "./driver.js";
import { ClaudeDriver } from "./claude/driver.js";
import { EngineError } from "./errors.js";
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
  index?: SessionIndex;
  logger?: Logger;
  now?: () => number;
}

export class ChatEngine {
  private readonly drivers = new Map<AgentId, AgentDriver>();
  private readonly index: SessionIndex;
  private readonly refs = new Map<string, SessionRef>();
  private readonly now: () => number;

  constructor(deps: ChatEngineDeps = {}) {
    const provided = deps.drivers ?? {};
    if (Object.keys(provided).length > 0) {
      for (const [id, driver] of Object.entries(provided)) {
        if (driver) this.drivers.set(id as AgentId, driver);
      }
    } else {
      this.drivers.set("claude", new ClaudeDriver(deps.logger ? { logger: deps.logger } : {}));
    }
    this.index = deps.index ?? new SessionIndex();
    this.now = deps.now ?? (() => Date.now());
  }

  /** Begin a new session; the seed turn streams to subscribers. */
  async start(req: StartRequest): Promise<SessionRef> {
    const driver = this.driverFor(req.agent);
    const ref = await driver.start({
      page: req.page,
      ...(req.instruction !== undefined ? { instruction: req.instruction } : {}),
      ...(req.cwd !== undefined ? { cwd: req.cwd } : {}),
      ...(req.safeMode !== undefined ? { safeMode: req.safeMode } : {}),
    });
    this.refs.set(ref.sessionId, ref);
    await this.index.upsert({ ...ref, lastActive: this.now() });
    return ref;
  }

  async send(sessionId: string, text: string): Promise<void> {
    const ref = await this.resolveRef(sessionId);
    await this.index.touch(sessionId, this.now());
    await this.driverFor(ref.agent).send(ref, text);
  }

  async subscribe(sessionId: string, listener: ChatEventListener): Promise<Unsubscribe> {
    const ref = await this.resolveRef(sessionId);
    return this.driverFor(ref.agent).subscribe(ref, listener);
  }

  async history(sessionId: string): Promise<ChatMessage[]> {
    const ref = await this.resolveRef(sessionId);
    return this.driverFor(ref.agent).history(ref);
  }

  /** Eject: the driver lets go so a terminal can take over the same session. */
  async stop(sessionId: string): Promise<SessionRef> {
    const ref = await this.resolveRef(sessionId);
    await this.driverFor(ref.agent).stop(ref);
    await this.index.touch(sessionId, this.now());
    return ref;
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
