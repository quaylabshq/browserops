import { spawn as nodeSpawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { randomUUID as nodeRandomUUID } from "node:crypto";
import { join } from "node:path";
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
import type { AgentDriver, ChatEventListener, StartOpts, Unsubscribe } from "./driver.js";
import { EngineError } from "./errors.js";
import { resetAgentBinCache, resolveAgentBin } from "./bin.js";
import { resolveLoginEnv } from "./claude/bin.js";
import { appendMirror, mirrorEventLine, mirrorHeader } from "./claude/mirror.js";
import {
  appendBrowserTranscriptMessage,
  formatMessagesForPrompt,
  readBrowserTranscript,
} from "./transcript.js";

const EVENT_BUFFER_CAP = 4000;

export interface ChildLike {
  stdout: {
    setEncoding(enc: string): void;
    on(ev: "data", cb: (chunk: string) => void): void;
  } | null;
  stderr: {
    setEncoding(enc: string): void;
    on(ev: "data", cb: (chunk: string) => void): void;
  } | null;
  on(ev: "error", cb: (err: Error) => void): void;
  on(ev: "close", cb: (code: number | null) => void): void;
}

export interface SpawnOptionsLike {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
  signal?: AbortSignal;
}

export type SpawnLike = (cmd: string, args: readonly string[], opts: SpawnOptionsLike) => ChildLike;

export interface NormalizedLine {
  events: ChatEvent[];
  nativeSessionId?: string;
}

/** Stable turn context lets a provider normalize partial output into one UI message. */
export interface NormalizeContext {
  turnId: string;
}

export interface ProcessDriverState {
  ref: SessionRef;
  systemPrompt: string;
  safeMode: boolean;
  ejected: boolean;
  stopped: boolean;
  dirsReady: boolean;
  mirrorPath: string;
  listeners: Set<ChatEventListener>;
  events: ChatEvent[];
  partialMessages: Map<string, ChatMessage>;
  queue: Promise<void>;
  activeTurn?: Promise<void>;
  abort?: AbortController;
  /** Set before the child exists too, so an early Stop still interrupts its turn. */
  cancelRequested: boolean;
  turnSeq: number;
}

export interface HeadlessProcessDriverDeps {
  bin?: string | null;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  chatDir?: string;
  randomUUID?: () => string;
  now?: () => number;
  buildSystemPrompt?: () => string;
  buildPrompt?: (page: ChatPageContext, instruction?: string) => string;
  logger?: Logger;
}

export interface BuildArgsInput {
  prompt: string;
  safeMode: boolean;
  cwd: string;
  first: boolean;
  nativeSessionId?: string;
  model?: string;
  reasoningEffort?: string;
}

export abstract class HeadlessProcessDriver implements AgentDriver {
  readonly id: AgentId;

  private bin: string | null;
  private readonly binName: string;
  private readonly hasExplicitBin: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawn?: SpawnLike;
  private readonly chatDir: string;
  private readonly randomUUID: () => string;
  private readonly now: () => number;
  private readonly buildSystemPrompt: () => string;
  private readonly buildPrompt: (page: ChatPageContext, instruction?: string) => string;
  private readonly logger?: Logger;
  private readonly sessions = new Map<string, ProcessDriverState>();
  private readonly sessionUpdateListeners = new Set<(ref: SessionRef) => void>();

  constructor(id: AgentId, binName: string, deps: HeadlessProcessDriverDeps = {}) {
    this.id = id;
    this.binName = binName;
    this.hasExplicitBin = deps.bin !== undefined;
    this.bin = resolveAgentBin(binName, deps.bin);
    this.env = deps.env ?? resolveLoginEnv();
    this.spawn = deps.spawn;
    this.chatDir = deps.chatDir ?? defaultChatDir();
    this.randomUUID = deps.randomUUID ?? (() => nodeRandomUUID());
    this.now = deps.now ?? (() => Date.now());
    this.buildSystemPrompt = deps.buildSystemPrompt ?? buildSystemPrompt;
    this.buildPrompt = deps.buildPrompt ?? ((p, i) => buildPrompt(p, i));
    this.logger = deps.logger;
  }

  async start(opts: StartOpts): Promise<SessionRef> {
    if (!this.resolveBin()) throw new EngineError("agent_not_found");
    // The manager supplies a private driver handle. The public BrowserOps
    // conversation id never reaches provider process state.
    const sessionId = opts.sessionId ?? this.randomUUID();
    const cwd = opts.cwd ?? workspaceDir();
    const title = (opts.instruction ?? opts.page.title ?? "New chat").trim().slice(0, 80);
    const ref: SessionRef = {
      agent: this.id,
      sessionId,
      cwd,
      createdAt: this.now(),
      ...(title ? { title } : {}),
      ...(opts.migratedFrom !== undefined ? { migratedFrom: opts.migratedFrom } : {}),
      ...(opts.migrationSourceAgent !== undefined
        ? { migrationSourceAgent: opts.migrationSourceAgent }
        : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(opts.nativeSessionId !== undefined ? { nativeSessionId: opts.nativeSessionId } : {}),
    };
    const state = this.makeState(ref, opts.safeMode ?? false);
    this.sessions.set(sessionId, state);

    await this.ensureDirs(state);
    await appendMirror(state.mirrorPath, mirrorHeader(sessionId));

    const visibleSeed = this.buildPrompt(opts.page, opts.instruction);
    const seed = [state.systemPrompt, visibleSeed]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");
    const displaySeed =
      opts.migratedFrom !== undefined
        ? `Continue conversation migrated from ${opts.migrationSourceAgent ?? "another agent"}.`
        : visibleSeed;
    const turn = this.enqueue(state, () => this.runTurn(state, seed, true, displaySeed));
    state.activeTurn = turn;
    void turn.catch(() => {});
    return ref;
  }

  async send(ref: SessionRef, text: string): Promise<void> {
    const state = this.ensureState(ref);
    if (state.ejected || state.stopped) throw new EngineError("session_ejected");
    const turn = this.enqueue(state, () => this.runTurn(state, text, false));
    state.activeTurn = turn;
    return turn;
  }

  subscribe(ref: SessionRef, listener: ChatEventListener): Unsubscribe {
    const state = this.ensureState(ref);
    for (const event of state.events) {
      try {
        listener(event);
      } catch {
        /* listener failure must not break replay */
      }
    }
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }

  history(ref: SessionRef): Promise<ChatMessage[]> {
    return readBrowserTranscript(ref.sessionId, this.chatDir);
  }

  async stop(ref: SessionRef): Promise<void> {
    const state = this.sessions.get(ref.sessionId);
    if (!state || state.stopped) return;
    state.stopped = true;
    state.ejected = true;
    state.abort?.abort();
    this.dispatch(state, { type: "end", reason: "stopped" });
  }

  async cancel(ref: SessionRef): Promise<void> {
    const state = this.sessions.get(ref.sessionId);
    if (!state || state.ejected || state.stopped) return;
    state.cancelRequested = true;
    state.abort?.abort();
    // Wait until the child has actually exited before releasing the panel to
    // switch providers or send another turn.
    await state.activeTurn?.catch(() => {});
  }

  capabilities(_ref: SessionRef): ChatSessionCapabilities {
    return { ...DEFAULT_CHAT_SESSION_CAPABILITIES };
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

  protected abstract buildArgs(input: BuildArgsInput): string[];
  protected abstract normalizeLine(raw: unknown, context: NormalizeContext): NormalizedLine;

  protected async buildTurnPrompt(
    state: ProcessDriverState,
    text: string,
    first: boolean,
  ): Promise<string> {
    if (first) return text;
    return text;
  }

  protected async replayPrompt(state: ProcessDriverState, text: string): Promise<string> {
    const prior = formatMessagesForPrompt(await this.history(state.ref));
    if (!prior) return text;
    return [
      "Continue this BrowserOps conversation. Prior transcript:",
      prior,
      "",
      "New user message:",
      text,
    ].join("\n");
  }

  private makeState(ref: SessionRef, safeMode: boolean): ProcessDriverState {
    return {
      ref,
      safeMode,
      systemPrompt: this.buildSystemPrompt(),
      ejected: false,
      stopped: false,
      dirsReady: false,
      mirrorPath: join(this.chatDir, `${ref.sessionId}.mirror.log`),
      listeners: new Set(),
      events: [],
      partialMessages: new Map(),
      queue: Promise.resolve(),
      cancelRequested: false,
      turnSeq: 0,
    };
  }

  private ensureState(ref: SessionRef): ProcessDriverState {
    let state = this.sessions.get(ref.sessionId);
    if (!state) {
      state = this.makeState(ref, false);
      state.ref.nativeSessionId = ref.nativeSessionId;
      this.sessions.set(ref.sessionId, state);
    }
    return state;
  }

  /**
   * A desktop daemon can start before a CLI is installed or added to PATH. Do
   * not make that first miss permanent: retry automatic discovery whenever the
   * provider is queried or started. Explicit test/user overrides remain fixed.
   */
  private resolveBin(): string | null {
    if (this.bin || this.hasExplicitBin) return this.bin;
    resetAgentBinCache();
    this.bin = resolveAgentBin(this.binName);
    return this.bin;
  }

  private enqueue(state: ProcessDriverState, fn: () => Promise<void>): Promise<void> {
    const next = state.queue.then(fn, fn);
    state.queue = next.catch(() => {});
    return next;
  }

  private async ensureDirs(state: ProcessDriverState): Promise<void> {
    if (state.dirsReady) return;
    await fs.mkdir(state.ref.cwd, { recursive: true });
    await fs.mkdir(this.chatDir, { recursive: true, mode: 0o700 });
    state.dirsReady = true;
  }

  private async runTurn(
    state: ProcessDriverState,
    text: string,
    first: boolean,
    displayText: string = text,
  ): Promise<void> {
    if (state.ejected || state.stopped) throw new EngineError("session_ejected");
    state.cancelRequested = false;
    if (!this.bin) {
      this.dispatch(state, { type: "status", state: "error", detail: "agent_not_found" });
      return;
    }
    await this.ensureDirs(state);
    this.dispatch(state, { type: "status", state: "thinking" });

    const userMessage = this.userMessage(state, displayText);
    this.dispatch(state, { type: "message", message: userMessage });
    const turnId = `${state.ref.sessionId}-turn-${state.turnSeq}`;

    const prompt = await this.buildTurnPrompt(state, text, first);
    const args = this.buildArgs({
      prompt,
      safeMode: state.safeMode,
      cwd: state.ref.cwd,
      first,
      ...(state.ref.nativeSessionId !== undefined
        ? { nativeSessionId: state.ref.nativeSessionId }
        : {}),
      ...(state.ref.model !== undefined ? { model: state.ref.model } : {}),
      ...(state.ref.reasoningEffort !== undefined
        ? { reasoningEffort: state.ref.reasoningEffort }
        : {}),
    });
    state.abort = new AbortController();
    if (state.cancelRequested) state.abort.abort();
    let stderr = "";
    const code = await this.runProcess({
      args,
      state,
      signal: state.abort.signal,
      turnId,
      onStderr: (chunk) => {
        stderr += chunk;
      },
    });
    const cancelled = state.cancelRequested || state.abort.signal.aborted;
    state.abort = undefined;
    if (state.ejected || state.stopped) return;

    if (cancelled) {
      this.dispatch(state, { type: "status", state: "idle" });
      return;
    }

    if (code !== 0) {
      this.dispatch(state, {
        type: "status",
        state: "error",
        detail: processFailureDetail(code, stderr),
      });
      if (this.logger && stderr.trim().length > 0) {
        void this.logger.write({
          dir: "system",
          event: "chat_turn_stderr",
          session: state.ref.sessionId,
          agent: this.id,
          detail: stderr.slice(-500),
        });
      }
    }
    this.dispatch(state, { type: "status", state: "idle" });
  }

  private userMessage(state: ProcessDriverState, text: string): ChatMessage {
    return {
      id: `${state.ref.sessionId}-user-${++state.turnSeq}`,
      role: "user",
      blocks: [{ kind: "text", text }],
      ts: this.now(),
    };
  }

  private runProcess(params: {
    args: readonly string[];
    state: ProcessDriverState;
    signal: AbortSignal;
    turnId: string;
    onStderr: (chunk: string) => void;
  }): Promise<number> {
    const spawn = this.spawn ?? (nodeSpawn as unknown as SpawnLike);
    return new Promise<number>((resolve) => {
      let settled = false;
      const done = (code: number): void => {
        if (!settled) {
          settled = true;
          resolve(code);
        }
      };

      let child: ChildLike;
      try {
        const bin = this.resolveBin();
        if (!bin) {
          this.dispatch(params.state, {
            type: "status",
            state: "error",
            detail: "agent_not_found",
          });
          done(-1);
          return;
        }
        child = spawn(bin, params.args, {
          cwd: params.state.ref.cwd,
          env: this.env,
          stdio: ["ignore", "pipe", "pipe"],
          signal: params.signal,
        });
      } catch (err) {
        if (!(err instanceof Error && err.name === "AbortError")) {
          this.dispatch(params.state, {
            type: "status",
            state: "error",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        done(-1);
        return;
      }

      let buf = "";
      if (child.stdout) {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          buf += chunk;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            this.emitLine(params.state, line, params.turnId);
          }
        });
      }
      if (child.stderr) {
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => params.onStderr(chunk));
      }
      child.on("error", (err) => {
        if (!(err instanceof Error && err.name === "AbortError")) {
          this.dispatch(params.state, {
            type: "status",
            state: "error",
            detail: err.message,
          });
        }
        done(-1);
      });
      child.on("close", (code) => {
        if (buf.trim().length > 0) this.emitLine(params.state, buf, params.turnId);
        done(code ?? 0);
      });
    });
  }

  private emitLine(state: ProcessDriverState, line: string, turnId: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return;
    }
    const normal = this.normalizeLine(raw, { turnId });
    if (normal.nativeSessionId && state.ref.nativeSessionId === undefined) {
      state.ref.nativeSessionId = normal.nativeSessionId;
      for (const listener of this.sessionUpdateListeners) {
        try {
          listener(state.ref);
        } catch {
          /* index persistence must not interrupt the live stream */
        }
      }
    }
    for (const event of normal.events) this.dispatch(state, event);
  }

  private dispatch(state: ProcessDriverState, event: ChatEvent): void {
    const normalized = this.coalescePartial(state, event);
    state.events.push(normalized);
    if (state.events.length > EVENT_BUFFER_CAP) state.events.shift();
    const line = mirrorEventLine(normalized);
    if (line) void appendMirror(state.mirrorPath, line);
    if (normalized.type === "message") {
      void appendBrowserTranscriptMessage(state.ref.sessionId, normalized.message, this.chatDir);
    }
    for (const listener of state.listeners) {
      try {
        listener(normalized);
      } catch {
        /* listener failure must not break the others */
      }
    }
  }

  /** Turn provider delta fragments into stable message snapshots for the panel. */
  private coalescePartial(state: ProcessDriverState, event: ChatEvent): ChatEvent {
    if (event.type !== "message") return event;
    const message = event.message;
    if (!message.partial) {
      state.partialMessages.delete(message.id);
      return event;
    }
    const prior = state.partialMessages.get(message.id);
    const priorText =
      prior?.blocks
        .filter(
          (block): block is Extract<ChatMessage["blocks"][number], { kind: "text" }> =>
            block.kind === "text",
        )
        .map((block) => block.text)
        .join("") ?? "";
    const delta = message.blocks
      .filter(
        (block): block is Extract<ChatMessage["blocks"][number], { kind: "text" }> =>
          block.kind === "text",
      )
      .map((block) => block.text)
      .join("");
    const merged: ChatMessage = {
      ...message,
      blocks: [{ kind: "text", text: priorText + delta }],
      partial: true,
    };
    state.partialMessages.set(message.id, merged);
    return { type: "message", message: merged };
  }
}

/** A concise, panel-safe process failure reason (never raw unlimited stderr). */
function processFailureDetail(code: number, stderr: string): string {
  const clean = stderr
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? `exit_${code}: ${clean.slice(-280)}` : `exit_${code}`;
}
