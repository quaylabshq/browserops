/**
 * Generic durable JSONL tailing for interactive provider terminals.
 *
 * Claude, Codex, and Cursor each persist a native transcript while their TUI
 * is running. The PTY is for input (and optional raw-terminal display); this
 * tailer is the source of the clean BrowserOps chat feed. Keeping those two
 * channels separate avoids trying to parse ANSI screens into messages.
 */
import { promises as fs } from "node:fs";
import type { ChatEvent, ChatMessage } from "@browserops/shared";

export interface DiscoveredTranscript {
  path: string;
  nativeSessionId?: string;
}

export interface TranscriptReducer {
  push(record: Record<string, unknown>): {
    events: ChatEvent[];
    nativeSessionId?: string;
  };
}

export interface ProviderTranscriptTailer {
  /** Snapshot any existing native transcripts before the provider TUI starts. */
  prepare?(): Promise<void>;
  start(): void;
  stop(): void;
  markThinking(): void;
  markIdle(): void;
  history(): Promise<ChatMessage[]>;
}

export interface PollingJsonlTailerOptions {
  /** Run before the provider process starts (used to snapshot existing sessions). */
  prepare?: () => Promise<void>;
  discover: () => Promise<DiscoveredTranscript | null>;
  createReducer: () => TranscriptReducer;
  listener: (event: ChatEvent) => void;
  onNativeSession?: (sessionId: string) => void;
  pollMs?: number;
  /** Only a fallback: normal provider turn-complete records end a turn sooner. */
  quiescenceMs?: number;
  now?: () => number;
}

const DEFAULT_POLL_MS = 150;
const DEFAULT_QUIESCENCE_MS = 15_000;

function parseLine(line: string): Record<string, unknown> | null {
  if (line.trim().length === 0) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Tail any append-only provider JSONL file. Discovery may return null while an
 * interactive CLI is still mounting its TUI and creating its first transcript.
 */
export class PollingJsonlTranscriptTailer implements ProviderTranscriptTailer {
  private readonly discover: () => Promise<DiscoveredTranscript | null>;
  private readonly prepareHook?: () => Promise<void>;
  private readonly createReducer: () => TranscriptReducer;
  private readonly listener: (event: ChatEvent) => void;
  private readonly onNativeSession?: (sessionId: string) => void;
  private readonly pollMs: number;
  private readonly quiescenceMs: number;
  private readonly now: () => number;

  private path: string | undefined;
  private offset = 0;
  private buffer = "";
  private reducer: TranscriptReducer;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private stopped = false;
  private state: "thinking" | "idle" = "idle";
  private lastActivity = 0;

  constructor(opts: PollingJsonlTailerOptions) {
    this.discover = opts.discover;
    this.prepareHook = opts.prepare;
    this.createReducer = opts.createReducer;
    this.listener = opts.listener;
    this.onNativeSession = opts.onNativeSession;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.quiescenceMs = opts.quiescenceMs ?? DEFAULT_QUIESCENCE_MS;
    this.now = opts.now ?? (() => Date.now());
    this.reducer = this.createReducer();
  }

  async prepare(): Promise<void> {
    await this.prepareHook?.();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  markThinking(): void {
    this.lastActivity = this.now();
    this.setState("thinking");
  }

  markIdle(): void {
    this.lastActivity = 0;
    this.setState("idle");
  }

  async history(): Promise<ChatMessage[]> {
    const path = await this.resolvePath();
    if (!path) return [];
    let text: string;
    try {
      text = await fs.readFile(path, "utf8");
    } catch {
      return [];
    }
    const reducer = this.createReducer();
    const messages = new Map<string, ChatMessage>();
    for (const line of text.split(/\r?\n/)) {
      const record = parseLine(line);
      if (!record) continue;
      const out = reducer.push(record);
      if (out.nativeSessionId) this.onNativeSession?.(out.nativeSessionId);
      for (const event of out.events) {
        if (event.type === "message") messages.set(event.message.id, event.message);
      }
    }
    return [...messages.values()];
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const path = await this.resolvePath();
      if (path) await this.readDelta(path);
      this.reassess();
    } catch {
      // Provider transcript writes and rotations are transient; retry next poll.
    } finally {
      this.ticking = false;
    }
  }

  private async resolvePath(): Promise<string | undefined> {
    if (this.path) return this.path;
    const found = await this.discover();
    if (!found) return undefined;
    this.path = found.path;
    if (found.nativeSessionId) this.onNativeSession?.(found.nativeSessionId);
    return this.path;
  }

  private async readDelta(path: string): Promise<void> {
    const handle = await fs.open(path, "r");
    try {
      const { size } = await handle.stat();
      if (size < this.offset) {
        this.offset = 0;
        this.buffer = "";
        this.reducer = this.createReducer();
      }
      const length = size - this.offset;
      if (length <= 0) return;
      const raw = Buffer.alloc(length);
      await handle.read(raw, 0, length, this.offset);
      this.offset = size;
      this.buffer += raw.toString("utf8");
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const record = parseLine(line);
        if (!record) continue;
        const out = this.reducer.push(record);
        if (out.nativeSessionId) this.onNativeSession?.(out.nativeSessionId);
        if (out.events.length > 0) this.lastActivity = this.now();
        for (const event of out.events) {
          this.listener(event);
          if (event.type === "status")
            this.state = event.state === "thinking" ? "thinking" : "idle";
        }
      }
    } finally {
      await handle.close();
    }
  }

  private reassess(): void {
    if (
      this.state === "thinking" &&
      this.lastActivity > 0 &&
      this.now() - this.lastActivity >= this.quiescenceMs
    ) {
      this.setState("idle");
    }
  }

  private setState(state: "thinking" | "idle"): void {
    if (this.state === state) return;
    this.state = state;
    this.listener({ type: "status", state });
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      const record = asRecord(item);
      if (!record) return "";
      for (const key of ["text", "input_text", "output_text", "content"]) {
        if (typeof record[key] === "string") return record[key] as string;
      }
      return "";
    })
    .join("");
}
