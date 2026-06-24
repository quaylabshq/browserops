/**
 * ClaudePtyDriver — the interactive-terminal implementation of AgentDriver.
 *
 * Unlike the headless ClaudeDriver (one `claude --print` process per turn), this
 * spawns ONE long-lived INTERACTIVE `claude` on a pty and keeps it. That is the
 * whole point of the transport: to Anthropic it is an ordinary interactive
 * session (no `--print`, no `--dangerously-skip-permissions`), indistinguishable
 * from hand-usage.
 *
 *  - send  → inject the turn at the tty (PtySession.submit; two-step Enter).
 *  - read  → the clean chat feed comes from tailing Claude's own transcript
 *            (TranscriptTailer), NOT from scraping the TUI. The raw TUI is
 *            exposed separately as a terminal (attachTerminal → /chat/pty).
 *  - browser_* still works: the spawned interactive claude loads the user's
 *    browserops MCP → shim → same daemon socket → same Chrome.
 *
 * One in-memory state per session mirrors ClaudeDriver: a serialized submit queue
 * (so two quick sends don't interleave keystrokes; Claude itself queues the
 * turns), a capped replay buffer (so seed-turn events survive the gap before the
 * panel subscribes), and the live listener set.
 */
import { promises as fs } from "node:fs";
import { randomUUID as nodeRandomUUID } from "node:crypto";
import { homedir } from "node:os";
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
import { workspaceDir } from "../../paths.js";
import type { Logger } from "../../logger.js";
import type {
  AgentDriver,
  ChatEventListener,
  StartOpts,
  TerminalAttachable,
  TerminalHandle,
  Unsubscribe,
} from "../driver.js";
import { EngineError } from "../errors.js";
import { appendBrowserTranscriptMessage, readBrowserTranscript } from "../transcript.js";
import { resolveClaudeBin, resolveLoginEnv } from "./bin.js";
import {
  PtySession,
  PtyUnavailableError,
  loadPtySpawner,
  type PtyLoaderDeps,
  type PtySpawner,
  type SubmitOptions,
} from "./pty.js";
import { TranscriptTailer } from "./tail.js";
import { loadHistory } from "./transcript.js";

const EVENT_BUFFER_CAP = 4000;
const DEFAULT_ALLOWED_TOOLS = "mcp__browserops";

interface PtyState {
  ref: SessionRef;
  systemPrompt: string;
  safeMode: boolean;
  listeners: Set<ChatEventListener>;
  events: ChatEvent[];
  queue: Promise<void>;
  ready: Promise<void>;
  session?: PtySession;
  tailer?: TranscriptTailer;
  stopped: boolean;
  /** Ejected to an external terminal: the pty is killed but the tailer lives on. */
  ejected: boolean;
}

export interface ClaudePtyDriverDeps {
  /** Resolved claude binary; defaults to a login-shell PATH lookup. */
  bin?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Inject a pty spawner (tests) instead of lazy-loading node-pty. */
  spawner?: PtySpawner;
  loaderDeps?: PtyLoaderDeps;
  randomUUID?: () => string;
  now?: () => number;
  buildSystemPrompt?: () => string;
  buildPrompt?: (page: ChatPageContext, instruction?: string) => string;
  /** Override the ~/.claude/projects root (tests). */
  projectsRoot?: string;
  /** Override ~/.claude.json for the workspace trust pre-seed (tests). */
  claudeConfigPath?: string;
  /** `--allowedTools` value pre-allowed in non-safe mode (so browser_* doesn't prompt). */
  allowedTools?: string;
  tailer?: { pollMs?: number; quiescenceMs?: number };
  ready?: { quietMs?: number; timeoutMs?: number };
  submit?: SubmitOptions;
  logger?: Logger;
}

export class ClaudePtyDriver implements AgentDriver, TerminalAttachable {
  readonly id: AgentId = "claude";

  private readonly bin: string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawner?: PtySpawner;
  private readonly loaderDeps?: PtyLoaderDeps;
  private readonly randomUUID: () => string;
  private readonly now: () => number;
  private readonly buildSystemPrompt: () => string;
  private readonly buildPrompt: (page: ChatPageContext, instruction?: string) => string;
  private readonly projectsRoot?: string;
  private readonly claudeConfigPath: string;
  private readonly allowedTools: string;
  private readonly tailerOpts: { pollMs?: number; quiescenceMs?: number };
  private readonly readyOpts: { quietMs?: number; timeoutMs?: number };
  private readonly submitOpts?: SubmitOptions;
  private readonly logger?: Logger;
  private readonly sessions = new Map<string, PtyState>();

  constructor(deps: ClaudePtyDriverDeps = {}) {
    this.bin = deps.bin !== undefined ? deps.bin : resolveClaudeBin();
    this.env = deps.env ?? resolveLoginEnv();
    this.spawner = deps.spawner;
    this.loaderDeps = deps.loaderDeps;
    this.randomUUID = deps.randomUUID ?? (() => nodeRandomUUID());
    this.now = deps.now ?? (() => Date.now());
    this.buildSystemPrompt = deps.buildSystemPrompt ?? buildSystemPrompt;
    this.buildPrompt = deps.buildPrompt ?? ((p, i) => buildPrompt(p, i));
    this.projectsRoot = deps.projectsRoot;
    this.claudeConfigPath = deps.claudeConfigPath ?? join(homedir(), ".claude.json");
    this.allowedTools = deps.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    this.tailerOpts = deps.tailer ?? {};
    this.readyOpts = deps.ready ?? {};
    this.submitOpts = deps.submit;
    this.logger = deps.logger;
  }

  async start(opts: StartOpts): Promise<SessionRef> {
    if (!this.bin) throw new EngineError("claude_not_found");
    const spawner = this.spawner ?? (await this.loadSpawner());

    const sessionId = this.randomUUID();
    const cwd = opts.cwd ?? workspaceDir();
    const title = (opts.instruction ?? opts.page.title ?? "New chat").trim().slice(0, 80);
    const ref: SessionRef = {
      agent: "claude",
      sessionId,
      cwd,
      createdAt: this.now(),
      ...(title ? { title } : {}),
      ...(opts.migratedFrom !== undefined ? { migratedFrom: opts.migratedFrom } : {}),
      ...(opts.migrationSourceAgent !== undefined
        ? { migrationSourceAgent: opts.migrationSourceAgent }
        : {}),
    };
    await this.ensureWorkspace(cwd);

    const state: PtyState = {
      ref,
      safeMode: opts.safeMode ?? false,
      systemPrompt: this.buildSystemPrompt(),
      listeners: new Set(),
      events: [],
      queue: Promise.resolve(),
      ready: Promise.resolve(),
      stopped: false,
      ejected: false,
    };
    this.sessions.set(sessionId, state);

    const session = await PtySession.start({
      file: this.bin,
      args: this.buildArgs(state),
      cwd,
      env: this.env,
      cols: 120,
      rows: 30,
      spawner,
    });
    state.session = session;
    session.onExit((e) => this.onExit(state, e));

    const tailer = new TranscriptTailer(sessionId, cwd, (ev) => this.dispatch(state, ev), {
      ...(this.projectsRoot !== undefined ? { projectsRoot: this.projectsRoot } : {}),
      ...(this.tailerOpts.pollMs !== undefined ? { pollMs: this.tailerOpts.pollMs } : {}),
      ...(this.tailerOpts.quiescenceMs !== undefined
        ? { quiescenceMs: this.tailerOpts.quiescenceMs }
        : {}),
    });
    state.tailer = tailer;
    tailer.start();

    state.ready = session.waitUntilReady(this.readyOpts);
    tailer.markThinking(); // show "working" while the pty boots + the seed turn lands

    const seed = this.buildPrompt(opts.page, opts.instruction);
    void this.enqueue(state, () => this.submitTurn(state, seed)).catch(() => {});
    return ref;
  }

  async send(ref: SessionRef, text: string): Promise<void> {
    const state = this.requireLive(ref);
    return this.enqueue(state, () => this.submitTurn(state, text));
  }

  subscribe(ref: SessionRef, listener: ChatEventListener): Unsubscribe {
    const state = this.sessions.get(ref.sessionId);
    if (!state) return () => {}; // cold session: no live pty (the panel uses history())
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
    const native = await loadHistory(ref.sessionId, {
      cwd: ref.cwd,
      ...(this.projectsRoot ? { projectsRoot: this.projectsRoot } : {}),
    });
    return native.length > 0 ? native : readBrowserTranscript(ref.sessionId);
  }

  async stop(ref: SessionRef): Promise<void> {
    const state = this.sessions.get(ref.sessionId);
    if (!state || state.stopped) return;
    state.stopped = true;
    state.tailer?.stop();
    state.session?.kill();
    this.dispatch(state, { type: "end", reason: "stopped" });
  }

  /**
   * Eject: hand the session to an external terminal. We kill OUR pty so the
   * resumed `claude --resume` is the session's sole writer (one writer at a
   * time), but KEEP the transcript tailer running — the panel chat stays a live
   * read-only mirror of the turns the external terminal writes. Unlike
   * {@link stop} this emits `ejected` (not `end`) and leaves the tailer alive.
   */
  async relinquish(ref: SessionRef): Promise<void> {
    const state = this.sessions.get(ref.sessionId);
    if (!state || state.stopped || state.ejected) return;
    state.ejected = true; // set BEFORE kill so onExit treats the death as expected
    state.session?.kill();
    this.dispatch(state, { type: "status", state: "ejected" });
  }

  /** TerminalAttachable: bind the embedded xterm pane to the live pty. */
  attachTerminal(ref: SessionRef): TerminalHandle {
    const state = this.requireLive(ref);
    const session = state.session!;
    return {
      onData: (listener) => session.onData(listener),
      write: (data) => session.write(data),
      resize: (cols, rows) => session.resize(cols, rows),
    };
  }

  /** TerminalAttachable: live only while we own an un-ejected, un-stopped pty. */
  terminalLive(ref: SessionRef): boolean {
    const state = this.sessions.get(ref.sessionId);
    return !!state && !!state.session && !state.stopped && !state.ejected;
  }

  capabilities(ref: SessionRef): ChatSessionCapabilities {
    const live = this.terminalLive(ref);
    return {
      ...DEFAULT_CHAT_SESSION_CAPABILITIES,
      embeddedTerminal: live,
      externalTakeover: live,
    };
  }

  // --- internals ------------------------------------------------------------

  private async loadSpawner(): Promise<PtySpawner> {
    try {
      return await loadPtySpawner(this.loaderDeps ?? {});
    } catch (err) {
      if (err instanceof PtyUnavailableError) throw new EngineError("pty_unavailable");
      throw err;
    }
  }

  private requireLive(ref: SessionRef): PtyState {
    const state = this.sessions.get(ref.sessionId);
    if (!state || !state.session || state.stopped) throw new EngineError("unknown_session");
    if (state.ejected) throw new EngineError("session_ejected");
    return state;
  }

  private buildArgs(state: PtyState): string[] {
    // Interactive — NEVER --print or --dangerously-skip-permissions. acceptEdits
    // (non-safe) is the defensible middle ground; safe mode prompts in the pane.
    const args = [
      "--session-id",
      state.ref.sessionId,
      "--permission-mode",
      state.safeMode ? "default" : "acceptEdits",
    ];
    if (!state.safeMode && this.allowedTools) args.push("--allowedTools", this.allowedTools);
    args.push("--append-system-prompt", state.systemPrompt);
    return args;
  }

  private async submitTurn(state: PtyState, text: string): Promise<void> {
    if (state.stopped || state.ejected || !state.session) throw new EngineError("unknown_session");
    await state.ready; // gate the first turn on the TUI being mounted
    state.tailer?.markThinking();
    await state.session.submit(text, this.submitOpts);
  }

  private enqueue(state: PtyState, fn: () => Promise<void>): Promise<void> {
    const next = state.queue.then(fn, fn);
    state.queue = next.catch(() => {});
    return next;
  }

  private onExit(state: PtyState, e: { exitCode: number; signal?: number }): void {
    if (state.stopped) return;
    // Ejected: WE killed the pty to hand the session to an external terminal, so
    // the exit is expected — keep the tailer running (the live read-only mirror)
    // and emit nothing.
    if (state.ejected) return;
    state.stopped = true;
    state.tailer?.stop();
    if (e.exitCode !== 0) {
      this.dispatch(state, { type: "status", state: "error", detail: `exit_${e.exitCode}` });
      void this.logger?.write({
        dir: "system",
        event: "chat_pty_exit",
        session: state.ref.sessionId,
        detail: `code=${e.exitCode}`,
      });
    }
    this.dispatch(state, { type: "end", reason: "exited" });
  }

  private async ensureWorkspace(cwd: string): Promise<void> {
    await fs.mkdir(cwd, { recursive: true });
    await this.ensureTrusted(cwd);
  }

  /**
   * Pre-seed folder-trust for our workspace dir in ~/.claude.json so the
   * interactive session doesn't open on a "Do you trust this folder?" prompt
   * that would swallow the seed turn's Enter. Best-effort + atomic; only writes
   * when the flag isn't already set, so it's a one-time no-op afterwards.
   */
  private async ensureTrusted(cwd: string): Promise<void> {
    try {
      let cfg: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(this.claudeConfigPath, "utf8"));
        if (parsed && typeof parsed === "object") cfg = parsed as Record<string, unknown>;
      } catch {
        /* missing/corrupt → start a fresh object */
      }
      const rawProjects = cfg["projects"];
      const projects: Record<string, Record<string, unknown>> = rawProjects &&
      typeof rawProjects === "object"
        ? (rawProjects as Record<string, Record<string, unknown>>)
        : {};
      cfg["projects"] = projects;
      const existing = projects[cwd];
      const entry: Record<string, unknown> =
        existing && typeof existing === "object" ? existing : {};
      projects[cwd] = entry;
      if (entry["hasTrustDialogAccepted"] === true) return;
      entry["hasTrustDialogAccepted"] = true;

      const tmp = `${this.claudeConfigPath}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
      await fs.rename(tmp, this.claudeConfigPath);
    } catch {
      // Best-effort: if we can't pre-seed, the trust prompt shows in the pane.
    }
  }

  private dispatch(state: PtyState, event: ChatEvent): void {
    state.events.push(event);
    if (state.events.length > EVENT_BUFFER_CAP) state.events.shift();
    if (event.type === "message") {
      void appendBrowserTranscriptMessage(state.ref.sessionId, event.message);
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
