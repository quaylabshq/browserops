import { createWriteStream, type WriteStream } from "node:fs";
import { ensureStateDir } from "./token.js";
import { logPath } from "./paths.js";

export type LogLevel = "normal" | "audit";

export type LogDirection =
  | "mcp_in"
  | "mcp_out"
  | "ws_in"
  | "ws_out"
  | "ws_event"
  | "safety"
  | "rate_limit"
  | "system";

export interface LogRecord {
  ts: string;
  dir: LogDirection;
  id?: string;
  method?: string;
  [key: string]: unknown;
}

const TRUNCATE_AT_CHARS_NORMAL = 200;

export class Logger {
  private stream?: WriteStream;
  private readonly level: LogLevel;
  private ready: Promise<void>;

  constructor(level: LogLevel = "normal") {
    this.level = level;
    this.ready = this.open();
  }

  private async open(): Promise<void> {
    await ensureStateDir();
    this.stream = createWriteStream(logPath(), { flags: "a" });
  }

  async write(record: Omit<LogRecord, "ts">): Promise<void> {
    await this.ready;
    const line =
      JSON.stringify({ ts: new Date().toISOString(), ...this.sanitize(record) }) + "\n";
    this.stream?.write(line);
  }

  private sanitize(record: Omit<LogRecord, "ts">): Omit<LogRecord, "ts"> {
    if (this.level === "audit") return record;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      out[k] = truncate(v);
    }
    return out as Omit<LogRecord, "ts">;
  }

  async close(): Promise<void> {
    await this.ready;
    await new Promise<void>((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(() => resolve());
    });
  }
}

function truncate(v: unknown): unknown {
  if (typeof v === "string") {
    return v.length > TRUNCATE_AT_CHARS_NORMAL
      ? v.slice(0, TRUNCATE_AT_CHARS_NORMAL) + `…(+${v.length - TRUNCATE_AT_CHARS_NORMAL} chars)`
      : v;
  }
  if (Array.isArray(v)) return v.map(truncate);
  if (v && typeof v === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v)) obj[k] = truncate(vv);
    return obj;
  }
  return v;
}
