import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TraceEvent } from "@browserops/shared";
import { createTraceWriter } from "./trace-writer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "browserops-trace-test-"));
}

function makeEvent(n: number): TraceEvent {
  return {
    id: `req-${n}`,
    timestamp: new Date().toISOString(),
    tool_name: "browser_click",
    duration_ms: 42 + n,
    input: { tab_id: "t_1", ref: `r_${n}` },
    result: { ok: true, value: { clicked: true } },
  };
}

/** Return the first file in dir, throwing if none. */
function firstFile(dir: string): string {
  const files = readdirSync(dir);
  const f = files[0];
  if (!f) throw new Error(`No files found in ${dir}`);
  return f;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTraceWriter", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  // -------------------------------------------------------------------------
  // No-op writer
  // -------------------------------------------------------------------------

  it("no-op writer: enabled is false", () => {
    const w = createTraceWriter({ enabled: false });
    expect(w.enabled).toBe(false);
  });

  it("no-op writer: append does not throw", () => {
    const w = createTraceWriter({ enabled: false });
    expect(() => w.append(makeEvent(1))).not.toThrow();
  });

  it("no-op writer: flush resolves without error", async () => {
    const w = createTraceWriter({ enabled: false });
    await expect(w.flush()).resolves.toBeUndefined();
  });

  it("no-op writer: close resolves without error", async () => {
    const w = createTraceWriter({ enabled: false });
    await expect(w.close()).resolves.toBeUndefined();
  });

  it("no-op writer: no file is created", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const w = createTraceWriter({ enabled: false, dir });
    w.append(makeEvent(1));
    expect(readdirSync(dir)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Enabled writer: file creation & content
  // -------------------------------------------------------------------------

  it("enabled writer: enabled is true", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const w = createTraceWriter({ enabled: true, dir, sessionId: "test-session-id" });
    expect(w.enabled).toBe(true);
    return w.close();
  });

  it("enabled writer: creates exactly one .jsonl file in the dir", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const w = createTraceWriter({ enabled: true, dir, sessionId: "abcdef01-1234-5678-abcd-ef0123456789" });
    await w.close();
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
  });

  it("enabled writer: filename starts with ISO timestamp and contains first 8 chars of sessionId", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const sessionId = "abcdef01-1234-5678-abcd-ef0123456789";
    const w = createTraceWriter({ enabled: true, dir, sessionId });
    await w.close();
    const filename = firstFile(dir);
    expect(filename).toBeDefined();
    // Timestamp-first: starts with a year prefix like 20
    expect(filename).toMatch(/^20\d{2}/);
    // Contains first 8 chars of sessionId
    expect(filename).toContain("abcdef01");
    expect(filename).toMatch(/\.jsonl$/);
  });

  it("enabled writer: writes N events as N JSONL lines", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const N = 5;
    const w = createTraceWriter({ enabled: true, dir, sessionId: "test-0001-1234-5678-abcdef012345" });
    for (let i = 0; i < N; i++) {
      w.append(makeEvent(i));
    }
    await w.close();

    const filename = firstFile(dir);
    const raw = readFileSync(join(dir, filename), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(N);
  });

  it("enabled writer: each line is valid JSON matching TraceEvent shape", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const events = [makeEvent(0), makeEvent(1), makeEvent(2)];
    const w = createTraceWriter({ enabled: true, dir, sessionId: "shape-test-1234-abcd-ef01" });
    for (const ev of events) w.append(ev);
    await w.close();

    const filename = firstFile(dir);
    const raw = readFileSync(join(dir, filename), "utf8");
    const parsed = raw.trim().split("\n").map((l) => JSON.parse(l) as TraceEvent);

    expect(parsed).toHaveLength(events.length);
    for (let i = 0; i < events.length; i++) {
      const p = parsed[i]!;
      const e = events[i]!;
      expect(p.id).toBe(e.id);
      expect(p.tool_name).toBe("browser_click");
      expect(typeof p.duration_ms).toBe("number");
      expect(p.result.ok).toBe(true);
    }
  });

  it("enabled writer: error result is preserved in JSONL", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const errorEvent: TraceEvent = {
      id: "req-err",
      timestamp: new Date().toISOString(),
      tool_name: "browser_navigate",
      duration_ms: 100,
      input: { tab_id: "t_1", url: "https://example.com" },
      result: { ok: false, error_code: "TIMEOUT", error_message: "request timed out" },
    };
    const w = createTraceWriter({ enabled: true, dir, sessionId: "err-test-0000-0000-000000000000" });
    w.append(errorEvent);
    await w.close();

    const filename = firstFile(dir);
    const raw = readFileSync(join(dir, filename), "utf8");
    const parsed = JSON.parse(raw.trim()) as TraceEvent;
    expect(parsed.result.ok).toBe(false);
    if (!parsed.result.ok) {
      expect(parsed.result.error_code).toBe("TIMEOUT");
    }
  });

  // -------------------------------------------------------------------------
  // close() flushes pending writes
  // -------------------------------------------------------------------------

  it("close() flushes pending writes before resolving", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const w = createTraceWriter({ enabled: true, dir, sessionId: "flush-test-1234-5678-abcdef01" });
    const N = 10;
    for (let i = 0; i < N; i++) w.append(makeEvent(i));
    // close() should flush all writes
    await w.close();

    const filename = firstFile(dir);
    const raw = readFileSync(join(dir, filename), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(N);
  });

  // -------------------------------------------------------------------------
  // flush() resolves
  // -------------------------------------------------------------------------

  it("flush() resolves after writes", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const w = createTraceWriter({ enabled: true, dir, sessionId: "drain-test-1234-5678-abcdef01" });
    w.append(makeEvent(1));
    await w.flush();
    await w.close();
  });

  // -------------------------------------------------------------------------
  // Crashes gracefully on unwritable dir
  // -------------------------------------------------------------------------

  it("crashes gracefully on unwritable dir: warns to stderr, does not throw", () => {
    // Use a path guaranteed to be unwritable: a file path as a "dir"
    const dir = "/dev/null/browserops-trace-unreachable";
    const stderrWrites: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // Temporarily capture stderr
    (process.stderr as NodeJS.WriteStream).write = (chunk: unknown): boolean => {
      stderrWrites.push(String(chunk));
      return true;
    };

    let w: ReturnType<typeof createTraceWriter> | undefined;
    try {
      expect(() => {
        w = createTraceWriter({ enabled: true, dir, sessionId: "unwritable-test" });
      }).not.toThrow();
    } finally {
      (process.stderr as NodeJS.WriteStream).write = original;
    }

    // Should have warned about failure
    const allWarns = stderrWrites.join("");
    expect(allWarns).toMatch(/warn:/);
    // Should fall back to a no-op writer
    expect(w).toBeDefined();
    expect(w!.enabled).toBe(false);
  });
});
