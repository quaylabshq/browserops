/**
 * Shared long-lived terminal driver for provider CLIs with interactive TUIs.
 *
 * The transport deliberately separates responsibilities:
 * - a real PTY makes the provider behave exactly as it does in a user's terminal;
 * - a provider-native JSONL tailer produces clean structured chat events;
 * - the raw PTY remains available to the panel's embedded xterm view.
 *
 * Codex and Cursor use this base. Claude has the older, equivalent terminal
 * driver because it additionally supports a native external-terminal takeover.
 */
import { randomUUID as nodeRandomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  DEFAULT_CHAT_SESSION_CAPABILITIES,
  type AgentId,
  type ChatEvent,
  type ChatMessage,
  type ChatPageContext,
  type ChatSessionCapabilities,
  type SessionRef,
} from "@browserops/shared";
import { buildPrompt, buildSystemPrompt } from "../launch-agent.js";
import { chatDir as defaultChatDir, workspaceDir } from "../paths.js";
import type { Logger } from "../logger.js";
import { resetAgentBinCache, resolveAgentBin } from "./bin.js";
import type {
  AgentDriver,
  ChatEventListener,
  StartOpts,
  TerminalAttachable,
  TerminalHandle,
  Unsubscribe,
} from "./driver.js";
import { EngineError } from "./errors.js";
import { appendBrowserTranscriptMessage, readBrowserTranscript } from "./transcript.js";
import { resolveLoginEnv } from "./claude/bin.js";
import {
  PtySession,
  PtyUnavailableError,
  loadPtySpawner,
  type PtyLoaderDeps,
  type PtySpawner,
  type SubmitOptions,
} from "./claude/pty.js";
import type { ProviderTranscriptTailer } from "./pty-transcript.js";

const EVENT_BUFFER_CAP = 4000;

export interface InteractivePtyDriverDeps {
  bin?: string | null;
  env?: NodeJS.ProcessEnv;
  spawner?: PtySpawner;
  loaderDeps?: PtyLoaderDeps;
  randomUUID?: () => string;
  now?: () => number;
  chatDir?: string;
  buildSystemPrompt?: () => string;
  buildPrompt?: (page: ChatPageContext, instruction?: string) => string;
  ready?: { quietMs?: number; timeoutMs?: number };
  submit?: SubmitOptions;
  logger?: Logger;
}

export interface InteractivePtyBuildInput {
  ref: SessionRef;
  safeMode: boolean;
  /** True only when recreating a session after the bridge process restarted. */
  resume: boolean;
}

export interface InteractivePtyTailerContext {
  ref: SessionRef;
  emit: (event: ChatEvent) => void;
  onNativeSession: (sessionId: string) => void;
}

interface InteractivePtyState {
  ref: SessionRef;
  safeMode: boolean;
  listeners: Set<ChatEventListener>;
  events: ChatEvent[];
  queue: Promise<void>;
  ready: Promise<void>;
  readyResolved: boolean;
  seedCancelled: boolean;
  stopped: boolean;
  session?: PtySession;
  tailer?: ProviderTranscriptTailer;
}

/**
 * A base for terminal-native providers. Subclasses only provide their CLI args,
 * durable transcript adapter, and optional workspace preparation.
 */
export abstract class InteractivePtyDriver implements AgentDriver, TerminalAttachable {
  readonly id: AgentId;

  private bin: string | null;
  private readonly hasExplicitBin: boolean;
  private readonly binName: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawner?: PtySpawner;
  private readonly loaderDeps?: PtyLoaderDeps;
  private readonly randomUUID: () => string;
  private readonly now: () => number;
  private readonly chatDir: string;
  private readonly buildSystemPrompt: () => string;
  private readonly buildPrompt: (page: ChatPageContext, instruction?: string) => string;
  private readonly readyOpts: { quietMs?: number; timeoutMs?: number };
  private readonly submitOpts?: SubmitOptions;
  private readonly logger?: Logger;
  private readonly sessions = new Map<string, InteractivePtyState>();
  private readonly sessionUpdateListeners = new Set<(ref: SessionRef) => void>();

  protected constructor(id: AgentId, binName: string, deps: InteractivePtyDriverDeps = {}) {
    this.id = id;
    this.binName = binName;
    this.hasExplicitBin = deps.bin !== undefined;
    this.bin = resolveAgentBin(binName, deps.bin);
    this.env = deps.env ?? resolveLoginEnv();
    this.spawner = deps.spawner;
    this.loaderDeps = deps.loaderDeps;
    this.randomUUID = deps.randomUUID ?? (() => nodeRandomUUID());
    this.now = deps.now ?? (() => Date.now());
    this.chatDir = deps.chatDir ?? defaultChatDir();
    this.buildSystemPrompt = deps.buildSystemPrompt ?? buildSystemPrompt;
    this.buildPrompt = deps.buildPrompt ?? ((page, instruction) => buildPrompt(page, instruction));
    this.readyOpts = deps.ready ?? {};
    this.submitOpts = deps.submit;
    this.logger = deps.logger;
  }

  async start(opts: StartOpts): Promise<SessionRef> {
    if (!this.resolveBin()) throw new EngineError("agent_not_found");
    const sessionId = opts.sessionId ?? this.randomUUID();
    const cwd = opts.cwd ?? workspaceDir();
    const title = (opts.instruction ?? opts.page.title ?? "New chat").trim().slice(0, 80);
    const ref: SessionRef = {
      agent: this.id,
      sessionId,
      cwd,
      createdAt: this.now(),
      ...(title ? { title } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(opts.migratedFrom !== undefined ? { migratedFrom: opts.migratedFrom } : {}),
      ...(opts.migrationSourceAgent !== undefined
        ? { migrationSourceAgent: opts.migrationSourceAgent }
        : {}),
      ...(opts.nativeSessionId !== undefined ? { nativeSessionId: opts.nativeSessionId } : {}),
    };
    const state = this.makeState(ref, opts.safeMode ?? false);
    this.sessions.set(sessionId, state);
    try {
      await this.ensureDirs(state);
      await this.prepareWorkspace(cwd);
      await this.openPty(state, false);
      state.tailer?.markThinking();
      const seed = this.seedText(opts);
      void this.enqueue(state, () => this.submitTurn(state, seed, true)).catch(() => {});
      return ref;
    } catch (err) {
      this.sessions.delete(sessionId);
      throw err;
    }
  }

  async send(ref: SessionRef, text: string): Promise<void> {
    const state = await this.ensureLive(ref);
    return this.enqueue(state, () => this.submitTurn(state, text));
  }

  subscribe(ref: SessionRef, listener: ChatEventListener): Unsubscribe {
    const state = this.sessions.get(ref.sessionId);
    if (!state) return () => {};
    for (const event of state.events) {
      try {
        listener(event);
      } catch {
        /* listener failure must not affect the native session */
      }
    }
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }

  async history(ref: SessionRef): Promise<ChatMessage[]> {
    const state = this.sessions.get(ref.sessionId);
    const native = state?.tailer ? await state.tailer.history() : await this.loadNativeHistory(ref);
    return native.length > 0 ? native : readBrowserTranscript(ref.sessionId, this.chatDir);
  }

  async stop(ref: SessionRef): Promise<void> {
    const state = this.sessions.get(ref.sessionId);
    if (!state || state.stopped) return;
    state.stopped = true;
    state.tailer?.stop();
    state.session?.kill();
    this.dispatch(state, { type: "end", reason: "stopped" });
  }

  async cancel(ref: SessionRef): Promise<void> {
    const state = await this.ensureLive(ref);
    if (!state.readyResolved) state.seedCancelled = true;
    state.session?.interrupt();
    state.tailer?.markIdle();
  }

  capabilities(_ref: SessionRef): ChatSessionCapabilities {
    return {
      ...DEFAULT_CHAT_SESSION_CAPABILITIES,
      embeddedTerminal: true,
      // Provider-native interactive takeovers are intentionally not advertised
      // until the OS launcher supports Codex/Cursor resume semantics too.
      externalTakeover: false,
    };
  }

  availability(): { available: boolean; reason?: string } {
    return this.resolveBin()
      ? { available: true }
      : { available: false, reason: "agent_not_found" };
  }

  onSessionUpdated(listener: (ref: SessionRef) => void): Unsubscribe {
    this.sessionUpdateListeners.add(listener);
    return () => this.sessionUpdateListeners.delete(listener);
  }

  attachTerminal(ref: SessionRef): TerminalHandle {
    const state = this.requireLive(ref);
    const session = state.session!;
    return {
      onData: (listener) => session.onData(listener),
      write: (data) => session.write(data),
      resize: (cols, rows) => session.resize(cols, rows),
    };
  }

  terminalLive(ref: SessionRef): boolean {
    const state = this.sessions.get(ref.sessionId);
    return !!state?.session && !state.stopped;
  }

  /** Build arguments for an actual interactive provider TUI: never print mode. */
  protected abstract buildInteractiveArgs(input: InteractivePtyBuildInput): string[];

  /** Create the provider-native durable transcript adapter for one live PTY. */
  protected abstract createTranscriptTailer(
    context: InteractivePtyTailerContext,
  ): ProviderTranscriptTailer;

  /** Re-read a provider transcript after a daemon restart, before its PTY is reattached. */
  protected abstract loadNativeHistory(ref: SessionRef): Promise<ChatMessage[]>;

  /** Provider-specific initial setup (e.g. an interactive workspace trust flag). */
  protected async prepareWorkspace(_cwd: string): Promise<void> {}

  /** Providers without append-system-prompt receive the contract in their seed turn. */
  protected seedText(opts: StartOpts): string {
    return [this.buildSystemPrompt(), this.buildPrompt(opts.page, opts.instruction)]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");
  }

  private makeState(ref: SessionRef, safeMode: boolean): InteractivePtyState {
    return {
      ref,
      safeMode,
      listeners: new Set(),
      events: [],
      queue: Promise.resolve(),
      ready: Promise.resolve(),
      readyResolved: false,
      seedCancelled: false,
      stopped: false,
    };
  }

  private async ensureLive(ref: SessionRef): Promise<InteractivePtyState> {
    const live = this.sessions.get(ref.sessionId);
    if (live) return this.requireLive(ref);
    if (!ref.nativeSessionId || !this.resolveBin()) throw new EngineError("unknown_session");

    // A bridge restart loses the in-memory PTY, not the native CLI session.
    // Resume the provider's persisted conversation in a new hidden terminal.
    const state = this.makeState(ref, false);
    this.sessions.set(ref.sessionId, state);
    try {
      await this.ensureDirs(state);
      await this.prepareWorkspace(ref.cwd);
      await this.openPty(state, true);
      return state;
    } catch (err) {
      this.sessions.delete(ref.sessionId);
      throw err;
    }
  }

  private async openPty(state: InteractivePtyState, resume: boolean): Promise<void> {
    const tailer = this.createTranscriptTailer({
      ref: state.ref,
      emit: (event) => this.dispatch(state, event),
      onNativeSession: (nativeSessionId) => this.updateNativeSession(state, nativeSessionId),
    });
    state.tailer = tailer;
    await tailer.prepare?.();
    let session: PtySession;
    try {
      const spawner = this.spawner ?? (await this.loadSpawner());
      session = await PtySession.start({
        file: this.bin!,
        args: this.buildInteractiveArgs({ ref: state.ref, safeMode: state.safeMode, resume }),
        cwd: state.ref.cwd,
        env: this.env,
        cols: 120,
        rows: 30,
        spawner,
      });
    } catch (err) {
      if (err instanceof PtyUnavailableError) throw new EngineError("pty_unavailable");
      throw err;
    }
    state.session = session;
    session.onExit((exit) => this.onExit(state, exit));
    tailer.start();
    state.ready = session.waitUntilReady(this.readyOpts).then(() => {
      state.readyResolved = true;
    });
  }

  private async submitTurn(state: InteractivePtyState, text: string, seed = false): Promise<void> {
    if (state.stopped || !state.session) throw new EngineError("unknown_session");
    await state.ready;
    if (seed && state.seedCancelled) return;
    state.tailer?.markThinking();
    await state.session.submit(text, this.submitOpts);
  }

  private async ensureDirs(state: InteractivePtyState): Promise<void> {
    await fs.mkdir(state.ref.cwd, { recursive: true });
    await fs.mkdir(this.chatDir, { recursive: true, mode: 0o700 });
  }

  private requireLive(ref: SessionRef): InteractivePtyState {
    const state = this.sessions.get(ref.sessionId);
    if (!state || !state.session || state.stopped) throw new EngineError("unknown_session");
    return state;
  }

  private enqueue(state: InteractivePtyState, fn: () => Promise<void>): Promise<void> {
    const next = state.queue.then(fn, fn);
    state.queue = next.catch(() => {});
    return next;
  }

  private async loadSpawner(): Promise<PtySpawner> {
    try {
      return await loadPtySpawner(this.loaderDeps ?? {});
    } catch (err) {
      if (err instanceof PtyUnavailableError) throw new EngineError("pty_unavailable");
      throw err;
    }
  }

  private resolveBin(): string | null {
    if (this.bin || this.hasExplicitBin) return this.bin;
    resetAgentBinCache();
    this.bin = resolveAgentBin(this.binName);
    return this.bin;
  }

  private updateNativeSession(state: InteractivePtyState, nativeSessionId: string): void {
    if (!nativeSessionId || state.ref.nativeSessionId === nativeSessionId) return;
    // Keep the ref object returned from start in sync as well. The manager
    // installs its binding immediately after start resolves, while a very fast
    // native TUI can create its transcript during that small interval.
    state.ref.nativeSessionId = nativeSessionId;
    for (const listener of this.sessionUpdateListeners) {
      try {
        listener(state.ref);
      } catch {
        /* persistence observers must not interfere with the live terminal */
      }
    }
  }

  private onExit(state: InteractivePtyState, exit: { exitCode: number; signal?: number }): void {
    if (state.stopped) return;
    state.stopped = true;
    state.tailer?.stop();
    if (exit.exitCode !== 0) {
      this.dispatch(state, { type: "status", state: "error", detail: `exit_${exit.exitCode}` });
      void this.logger?.write({
        dir: "system",
        event: "chat_pty_exit",
        agent: this.id,
        session: state.ref.sessionId,
        detail: `code=${exit.exitCode}`,
      });
    }
    this.dispatch(state, { type: "end", reason: "exited" });
  }

  private dispatch(state: InteractivePtyState, event: ChatEvent): void {
    state.events.push(event);
    if (state.events.length > EVENT_BUFFER_CAP) state.events.shift();
    if (event.type === "message") {
      void appendBrowserTranscriptMessage(state.ref.sessionId, event.message, this.chatDir);
    }
    for (const listener of state.listeners) {
      try {
        listener(event);
      } catch {
        /* listener failure must not interfere with the native session */
      }
    }
  }
}
