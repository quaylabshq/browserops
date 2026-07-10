/**
 * ClaudeDriver — the Claude implementation of AgentDriver.
 *
 * Owns one in-memory state per session: a serialized turn queue (so two quick
 * sends don't race a shared session), a capped replay buffer (so events emitted
 * by the seed turn aren't lost in the gap before the panel subscribes), the
 * set of live listeners, and the mirror-log path. Turns run via runClaudeTurn
 * (R2 respawn): the first turn mints the id with --session-id, every later turn
 * resumes it with --resume.
 *
 * One writer, many readers: stop() aborts the running turn and flips the
 * session to ejected (the takeover hands it to an interactive terminal). After
 * eject, sends are refused; history() and the mirror still resolve.
 */
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
import { buildPrompt, buildSystemPrompt } from "../../launch-agent.js";
import { chatDir as defaultChatDir, workspaceDir } from "../../paths.js";
import type { Logger } from "../../logger.js";
import type { AgentDriver, ChatEventListener, StartOpts, Unsubscribe } from "../driver.js";
import { EngineError } from "../errors.js";
import { resolveClaudeBin, resolveLoginEnv } from "./bin.js";
import { appendMirror, mirrorEventLine, mirrorHeader, mirrorUserLine } from "./mirror.js";
import { runClaudeTurn, type SpawnLike } from "./runtime.js";
import { findTranscriptPath, loadHistory } from "./transcript.js";
import { appendBrowserTranscriptMessage, readBrowserTranscript } from "../transcript.js";

const EVENT_BUFFER_CAP = 4000;

interface SessionState {
  ref: SessionRef;
  systemPrompt: string;
  safeMode: boolean;
  /** true only for a brand-new session we created (first turn uses --session-id). */
  createdHere: boolean;
  everRun: boolean;
  ejected: boolean;
  dirsReady: boolean;
  mirrorPath: string;
  listeners: Set<ChatEventListener>;
  events: ChatEvent[];
  queue: Promise<void>;
  abort?: AbortController;
  turnSeq: number;
  /** Compatibility-journal writes are drained before a completed turn resolves. */
  historyWrite: Promise<void>;
}

export interface ClaudeDriverDeps {
  /** Resolved claude binary; defaults to a login-shell PATH lookup. */
  bin?: string | null;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
  chatDir?: string;
  randomUUID?: () => string;
  now?: () => number;
  buildSystemPrompt?: () => string;
  buildPrompt?: (page: ChatPageContext, instruction?: string) => string;
  /** Override the ~/.claude/projects root (tests). */
  projectsRoot?: string;
  logger?: Logger;
}

export class ClaudeDriver implements AgentDriver {
  readonly id: AgentId = "claude";

  private readonly bin: string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawn?: SpawnLike;
  private readonly chatDir: string;
  private readonly randomUUID: () => string;
  private readonly now: () => number;
  private readonly buildSystemPrompt: () => string;
  private readonly buildPrompt: (page: ChatPageContext, instruction?: string) => string;
  private readonly projectsRoot?: string;
  private readonly logger?: Logger;
  private readonly sessions = new Map<string, SessionState>();

  constructor(deps: ClaudeDriverDeps = {}) {
    this.bin = deps.bin !== undefined ? deps.bin : resolveClaudeBin();
    this.env = deps.env ?? resolveLoginEnv();
    this.spawn = deps.spawn;
    this.chatDir = deps.chatDir ?? defaultChatDir();
    this.randomUUID = deps.randomUUID ?? (() => nodeRandomUUID());
    this.now = deps.now ?? (() => Date.now());
    this.buildSystemPrompt = deps.buildSystemPrompt ?? buildSystemPrompt;
    this.buildPrompt = deps.buildPrompt ?? ((p, i) => buildPrompt(p, i));
    this.projectsRoot = deps.projectsRoot;
    this.logger = deps.logger;
  }

  async start(opts: StartOpts): Promise<SessionRef> {
    const sessionId = opts.sessionId ?? this.randomUUID();
    // Claude accepts a caller-supplied native id. Keep it distinct from the
    // BrowserOps/driver handle so handoff never mistakes one for the other.
    const nativeSessionId = opts.nativeSessionId ?? sessionId;
    const cwd = opts.cwd ?? workspaceDir();
    const title = (opts.instruction ?? opts.page.title ?? "New chat").trim().slice(0, 80);
    const ref: SessionRef = {
      agent: "claude",
      sessionId,
      nativeSessionId,
      cwd,
      createdAt: this.now(),
      ...(title ? { title } : {}),
      ...(opts.migratedFrom !== undefined ? { migratedFrom: opts.migratedFrom } : {}),
      ...(opts.migrationSourceAgent !== undefined
        ? { migrationSourceAgent: opts.migrationSourceAgent }
        : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.reasoningEffort !== undefined ? { reasoningEffort: opts.reasoningEffort } : {}),
    };
    const state = this.makeState(ref, opts.safeMode ?? false, true);
    this.sessions.set(sessionId, state);

    await this.ensureDirs(state);
    await appendMirror(state.mirrorPath, mirrorHeader(sessionId));

    const seed = this.buildPrompt(opts.page, opts.instruction);
    const displaySeed =
      opts.migratedFrom !== undefined
        ? `Continue conversation migrated from ${opts.migrationSourceAgent ?? "another agent"}.`
        : seed;
    void this.enqueue(state, () => this.runTurn(state, seed, true, displaySeed)).catch(() => {});
    return ref;
  }

  async send(ref: SessionRef, text: string): Promise<void> {
    const state = this.ensureState(ref);
    if (state.ejected) throw new EngineError("session_ejected");
    return this.enqueue(state, () => this.runTurn(state, text, false));
  }

  subscribe(ref: SessionRef, listener: ChatEventListener): Unsubscribe {
    const state = this.ensureState(ref);
    for (const event of state.events) {
      try {
        listener(event);
      } catch {
        /* a listener's failure must not break replay */
      }
    }
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }

  async history(ref: SessionRef): Promise<ChatMessage[]> {
    const native = await loadHistory(ref.nativeSessionId ?? ref.sessionId, {
      cwd: ref.cwd,
      ...(this.projectsRoot ? { projectsRoot: this.projectsRoot } : {}),
    });
    return native.length > 0 ? native : readBrowserTranscript(ref.sessionId, this.chatDir);
  }

  async stop(ref: SessionRef): Promise<void> {
    const state = this.sessions.get(ref.sessionId);
    if (!state || state.ejected) return;
    state.ejected = true;
    state.abort?.abort();
    this.dispatch(state, { type: "status", state: "ejected" });
  }

  capabilities(_ref: SessionRef): ChatSessionCapabilities {
    return {
      ...DEFAULT_CHAT_SESSION_CAPABILITIES,
      externalTakeover: true,
    };
  }

  availability(): { available: boolean; reason?: string } {
    return this.bin ? { available: true } : { available: false, reason: "claude_not_found" };
  }

  async canTakeover(ref: SessionRef): Promise<{ ok: true } | { ok: false; error: string }> {
    const path = await findTranscriptPath(ref.nativeSessionId ?? ref.sessionId, {
      cwd: ref.cwd,
      ...(this.projectsRoot ? { projectsRoot: this.projectsRoot } : {}),
    });
    return path ? { ok: true } : { ok: false, error: "session_not_persisted" };
  }

  // --- internals ------------------------------------------------------------

  private makeState(ref: SessionRef, safeMode: boolean, createdHere: boolean): SessionState {
    return {
      ref,
      safeMode,
      createdHere,
      everRun: false,
      ejected: false,
      dirsReady: false,
      systemPrompt: this.buildSystemPrompt(),
      mirrorPath: join(this.chatDir, `${ref.sessionId}.mirror.log`),
      listeners: new Set(),
      events: [],
      queue: Promise.resolve(),
      turnSeq: 0,
      historyWrite: Promise.resolve(),
    };
  }

  /** Reconstruct in-memory state for a cold session (resumed after restart). */
  private ensureState(ref: SessionRef): SessionState {
    let state = this.sessions.get(ref.sessionId);
    if (!state) {
      state = this.makeState(ref, false, false);
      state.everRun = true; // cold session: continue with --resume, never --session-id
      this.sessions.set(ref.sessionId, state);
    }
    return state;
  }

  private enqueue(state: SessionState, fn: () => Promise<void>): Promise<void> {
    const next = state.queue.then(fn, fn);
    state.queue = next.catch(() => {});
    return next;
  }

  private async ensureDirs(state: SessionState): Promise<void> {
    if (state.dirsReady) return;
    await fs.mkdir(state.ref.cwd, { recursive: true });
    await fs.mkdir(this.chatDir, { recursive: true });
    state.dirsReady = true;
  }

  private buildArgs(state: SessionState, userText: string, first: boolean): string[] {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--append-system-prompt",
      state.systemPrompt,
    ];
    args.push(
      first ? "--session-id" : "--resume",
      state.ref.nativeSessionId ?? state.ref.sessionId,
    );
    if (state.ref.model) args.push("--model", state.ref.model);
    if (state.ref.reasoningEffort) args.push("--effort", state.ref.reasoningEffort);
    if (!state.safeMode) args.push("--dangerously-skip-permissions");
    args.push("--", userText); // -- guards user text that starts with '-'
    return args;
  }

  private async runTurn(
    state: SessionState,
    userText: string,
    first: boolean,
    displayText: string = userText,
  ): Promise<void> {
    if (state.ejected) throw new EngineError("session_ejected");
    if (!this.bin) {
      this.dispatch(state, { type: "status", state: "error", detail: "claude_not_found" });
      return;
    }
    await this.ensureDirs(state);
    this.dispatch(state, { type: "status", state: "thinking" });
    this.dispatch(state, {
      type: "message",
      message: {
        id: `${state.ref.sessionId}-user-${++state.turnSeq}`,
        role: "user",
        blocks: [{ kind: "text", text: displayText }],
        ts: this.now(),
      },
    });
    await appendMirror(state.mirrorPath, mirrorUserLine(userText));

    const useFirst = first && state.createdHere && !state.everRun;
    const args = this.buildArgs(state, userText, useFirst);
    state.abort = new AbortController();
    let stderr = "";

    const code = await runClaudeTurn({
      bin: this.bin,
      args,
      cwd: state.ref.cwd,
      env: this.env,
      ...(this.spawn ? { spawn: this.spawn } : {}),
      signal: state.abort.signal,
      onEvent: (event) => this.dispatch(state, event),
      onStderr: (chunk) => {
        stderr += chunk;
      },
    });

    state.everRun = true;
    state.abort = undefined;
    if (state.ejected) return; // stop() owns the terminal status

    if (code !== 0) {
      this.dispatch(state, { type: "status", state: "error", detail: `exit_${code}` });
      if (this.logger && stderr.trim().length > 0) {
        void this.logger.write({
          dir: "system",
          event: "chat_turn_stderr",
          session: state.ref.sessionId,
          detail: stderr.slice(-500),
        });
      }
    }
    this.dispatch(state, { type: "status", state: "idle" });
    await state.historyWrite;
  }

  private dispatch(state: SessionState, event: ChatEvent): void {
    state.events.push(event);
    if (state.events.length > EVENT_BUFFER_CAP) state.events.shift();
    const line = mirrorEventLine(event);
    if (line) void appendMirror(state.mirrorPath, line);
    if (event.type === "message") {
      state.historyWrite = appendBrowserTranscriptMessage(
        state.ref.sessionId,
        event.message,
        this.chatDir,
      );
    }
    for (const listener of state.listeners) {
      try {
        listener(event);
      } catch {
        /* a listener's failure must not break the others */
      }
    }
  }
}
