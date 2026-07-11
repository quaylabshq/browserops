/**
 * Live transcript tailer — the clean, structured chat feed for the terminal
 * transport. The interactive `claude` session writes its turns to the same
 * `~/.claude/projects/.../<id>.jsonl` it always does (verified: it appends
 * incrementally during the session); we tail that file rather than scrape the
 * TUI. The embedded xterm pane shows the raw terminal separately — this module
 * is only about normalized ChatMessages / status.
 *
 * Two hard problems the design solves:
 *  - **Turn-end detection.** There is no `result` event on the transcript feed.
 *    {@link detectTurnState} uses a terminal `stop_reason` (`end_turn` /
 *    `stop_sequence`) as the primary signal and a quiescence timeout as the
 *    universal fallback (covers interrupts and turns typed in the terminal).
 *  - **Safe incremental reads.** Records are appended (never re-sorted), so we
 *    byte-offset tail and advance only to the last newline — never feeding a
 *    partial line or a split UTF-8 sequence. We poll rather than `fs.watch`
 *    (robust across macOS/FS quirks and deterministic to test).
 */
import { promises as fs } from "node:fs";
import type { ChatEvent, ChatMessage } from "@browserops/shared";
import { stopReasonOf } from "./normalize.js";
import { createTranscriptReducer, findTranscriptPath, parseJsonlLine } from "./transcript.js";

export type TurnState = "thinking" | "idle";

const TERMINAL_STOP = new Set(["end_turn", "stop_sequence"]);

/**
 * Decide mid-turn vs idle from transcript signals alone. A terminal
 * `stop_reason` on the latest assistant record wins immediately; otherwise the
 * session is idle once it has been quiet for `quiescenceMs` (the only signal
 * that also survives an interrupt or a turn typed directly in the terminal).
 */
export function detectTurnState(opts: {
  stopReason: string | undefined;
  msSinceActivity: number;
  quiescenceMs: number;
}): TurnState {
  if (opts.stopReason !== undefined && TERMINAL_STOP.has(opts.stopReason)) return "idle";
  if (opts.msSinceActivity >= opts.quiescenceMs) return "idle";
  return "thinking";
}

/**
 * Feed appended transcript text, get back the messages to (re)emit in order
 * while tracking the current turn's terminal `stop_reason`. Pure (no IO) and
 * buffers partial lines, so the parse + turn-tracking logic is unit-testable by
 * handing it arbitrary chunks.
 */
export class IncrementalTranscript {
  private readonly reducer = createTranscriptReducer();
  private buf = "";
  private stop: string | undefined;

  /** The current turn's stop_reason; reset to undefined when a new user turn opens. */
  get stopReason(): string | undefined {
    return this.stop;
  }

  push(chunk: string): ChatMessage[] {
    this.buf += chunk;
    const out: ChatMessage[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const record = parseJsonlLine(line);
      if (!record) continue;
      const reduced = this.reducer.push(record);
      if (!reduced) continue;
      // A real user turn (role "user"; a tool_result-only record normalizes to
      // role "tool") opens a new turn → clear the prior turn's terminal marker.
      if (reduced.message.role === "user") this.stop = undefined;
      if (record["type"] === "assistant") {
        const sr = stopReasonOf(record);
        if (sr !== undefined) this.stop = sr;
      }
      out.push(reduced.message);
    }
    return out;
  }
}

export type TailerListener = (event: ChatEvent) => void;

export interface TailerOptions {
  /** Polling cadence for appended bytes (ms). */
  pollMs?: number;
  /** Idle once no message-bearing bytes have appeared for this long (ms). */
  quiescenceMs?: number;
  /** Override Claude's projects root (tests). */
  projectsRoot?: string;
  /** Injectable clock (tests). */
  now?: () => number;
}

const DEFAULT_POLL_MS = 150;
// Long on purpose: a terminal stop_reason ends a normal turn promptly, so this
// only fires for a genuinely stuck/interrupted turn — NOT during the multi-second
// gaps between an injected turn and Claude's first transcript write.
const DEFAULT_QUIESCENCE_MS = 10000;

/**
 * Tail a Claude session transcript and emit normalized ChatEvents (`message` +
 * `status`). Tolerates the file not existing yet (it is created on the first
 * turn) and only advances its byte offset on newline boundaries.
 */
export class TranscriptTailer {
  private readonly inc = new IncrementalTranscript();
  private readonly pollMs: number;
  private readonly quiescenceMs: number;
  private readonly projectsRoot: string | undefined;
  private readonly now: () => number;

  private path: string | null = null;
  private offset = 0;
  private lastActivity = 0; // ms of the last message-bearing append
  private state: TurnState = "idle"; // last emitted state
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly listener: TailerListener,
    opts: TailerOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.quiescenceMs = opts.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;
    this.projectsRoot = opts.projectsRoot;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Mark the session as actively working. The driver calls this when it injects a
   * turn — the tailer can't see the injection itself (only the transcript Claude
   * writes afterwards), so without this its state machine could already be `idle`
   * when a fast complete turn lands and it would never emit the matching `idle`
   * transition. This seeds `thinking` so the eventual terminal stop_reason (or
   * quiescence) produces a real thinking→idle edge.
   */
  markThinking(): void {
    this.lastActivity = this.now();
    if (this.state !== "thinking") {
      this.state = "thinking";
      this.listener({ type: "status", state: "thinking" });
    }
  }

  /** The driver interrupted the current TUI turn (Ctrl+C). */
  markIdle(): void {
    this.lastActivity = 0;
    if (this.state !== "idle") {
      this.state = "idle";
      this.listener({ type: "status", state: "idle" });
    }
  }

  private async resolvePath(): Promise<string | null> {
    if (this.path) return this.path;
    const found = await findTranscriptPath(this.sessionId, {
      ...(this.projectsRoot !== undefined ? { projectsRoot: this.projectsRoot } : {}),
      cwd: this.cwd,
    });
    if (found) this.path = found;
    return this.path;
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const path = await this.resolvePath();
      if (path) await this.readDelta(path);
      this.reassess();
    } catch {
      // Transient fs errors (file rotating, mid-write race) — retry next tick.
    } finally {
      this.ticking = false;
    }
  }

  private async readDelta(path: string): Promise<void> {
    const fh = await fs.open(path, "r");
    try {
      const { size } = await fh.stat();
      if (size < this.offset) this.offset = 0; // truncation / rotation
      const len = size - this.offset;
      if (len <= 0) return;
      const raw = Buffer.alloc(len);
      await fh.read(raw, 0, len, this.offset);
      // Advance only to the last newline so we never feed a partial line or a
      // UTF-8 sequence split across reads.
      const lastNl = raw.lastIndexOf(0x0a);
      if (lastNl < 0) return;
      const chunk = raw.subarray(0, lastNl + 1).toString("utf8");
      this.offset += lastNl + 1;
      const messages = this.inc.push(chunk);
      if (messages.length > 0) {
        this.lastActivity = this.now();
        for (const message of messages) this.listener({ type: "message", message });
      }
    } finally {
      await fh.close();
    }
  }

  private reassess(): void {
    const next = detectTurnState({
      stopReason: this.inc.stopReason,
      msSinceActivity: this.now() - this.lastActivity,
      quiescenceMs: this.quiescenceMs,
    });
    if (next !== this.state) {
      this.state = next;
      this.listener({ type: "status", state: next });
    }
  }
}
