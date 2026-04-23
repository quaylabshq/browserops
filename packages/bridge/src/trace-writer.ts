/**
 * Opt-in trace writer for MCP tool call recording.
 *
 * When enabled (via BROWSEROPS_TRACE=1 or --trace CLI flag), writes one
 * TraceEvent per line to ~/browserops/traces/<timestamp>-<sessionId>.jsonl
 * using Node's default write-stream buffering.
 *
 * Never throws from append() — trace recording must not break tool calls.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TraceEvent } from "@browserops/shared";

export interface TraceWriter {
  /** Whether this writer is active. When false, all methods are no-ops. */
  enabled: boolean;
  /** Serialize and append a TraceEvent as a JSONL line. Never throws. */
  append(event: TraceEvent): void;
  /** Flush buffered writes to disk (best-effort). */
  flush(): Promise<void>;
  /** Flush and close the underlying file stream. */
  close(): Promise<void>;
}

export function createTraceWriter(options: {
  enabled: boolean;
  dir?: string;
  sessionId?: string;
}): TraceWriter {
  if (!options.enabled) {
    return {
      enabled: false,
      append: _noop,
      flush: async () => {},
      close: async () => {},
    };
  }

  const dir = options.dir ?? join(homedir(), ".browserops", "traces");
  const sessionId = options.sessionId ?? randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${timestamp}-${sessionId.slice(0, 8)}.jsonl`;
  const filePath = join(dir, filename);

  // Ensure directory exists. Failures here should surface immediately so the
  // user knows tracing is broken — we do NOT swallow this error.
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`browserops: warn: trace dir creation failed (${dir}): ${msg}\n`);
    // Fall back to no-op rather than crashing.
    return {
      enabled: false,
      append: _noop,
      flush: async () => {},
      close: async () => {},
    };
  }

  let stream: WriteStream;
  try {
    stream = createWriteStream(filePath, { flags: "a" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`browserops: warn: trace file open failed (${filePath}): ${msg}\n`);
    return {
      enabled: false,
      append: _noop,
      flush: async () => {},
      close: async () => {},
    };
  }

  // Track stream errors so append() can warn without re-throwing.
  let streamError: Error | undefined;
  stream.on("error", (err) => {
    streamError = err;
    process.stderr.write(`browserops: warn: trace stream error: ${err.message}\n`);
  });

  function append(event: TraceEvent): void {
    if (streamError) return;
    try {
      const line = JSON.stringify(event) + "\n";
      stream.write(line, (err) => {
        if (err) {
          process.stderr.write(`browserops: warn: trace write failed: ${err.message}\n`);
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`browserops: warn: trace append failed: ${msg}\n`);
    }
  }

  function flush(): Promise<void> {
    return new Promise((resolve) => {
      if (streamError || !stream.writable) return resolve();
      // If nothing is buffered the stream isn't draining — resolve immediately.
      if (!stream.writableNeedDrain) return resolve();
      stream.once("drain", resolve);
    });
  }

  function close(): Promise<void> {
    return new Promise((resolve) => {
      if (!stream.writable) return resolve();
      stream.end(() => resolve());
    });
  }

  process.stderr.write(`browserops: trace enabled → ${filePath}\n`);

  return { enabled: true, append, flush, close };
}

function _noop(): void {}
