import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObservedFactsStore, type ObservedFact } from "./observed-facts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "browserops-observed-test-"));
}

function factsPath(dir: string): string {
  return join(dir, "facts.json");
}

function readFacts(dir: string): ObservedFact[] {
  const raw = readFileSync(factsPath(dir), "utf8");
  return JSON.parse(raw) as ObservedFact[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createObservedFactsStore", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  // -------------------------------------------------------------------------
  // enabled: false — no-op store
  // -------------------------------------------------------------------------

  it("disabled store: getFacts returns empty array", () => {
    const store = createObservedFactsStore({ enabled: false });
    expect(store.getFacts("app.slack.com")).toEqual([]);
  });

  it("disabled store: snapshot returns empty array", () => {
    const store = createObservedFactsStore({ enabled: false });
    expect(store.snapshot()).toEqual([]);
  });

  it("disabled store: recordObservation does nothing and does not throw", () => {
    const store = createObservedFactsStore({ enabled: false });
    expect(() =>
      store.recordObservation({
        hostname: "app.slack.com",
        action_class: "click",
        dispatch_mode: "synthetic",
        had_effect: true,
      }),
    ).not.toThrow();
  });

  it("disabled store: save resolves without error", async () => {
    const store = createObservedFactsStore({ enabled: false });
    await expect(store.save()).resolves.toBeUndefined();
  });

  it("disabled store: close resolves without error", async () => {
    const store = createObservedFactsStore({ enabled: false });
    await expect(store.close()).resolves.toBeUndefined();
  });

  it("disabled store: no file is created even if path provided", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const path = factsPath(dir);
    const store = createObservedFactsStore({ enabled: false, path });
    store.recordObservation({
      hostname: "example.com",
      action_class: "click",
      dispatch_mode: "trusted",
      had_effect: true,
    });
    await store.save();
    expect(existsSync(path)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Basic in-memory state
  // -------------------------------------------------------------------------

  it("recordObservation creates a new fact for unseen (hostname, action_class, dispatch_mode)", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const store = createObservedFactsStore({ path: factsPath(dir) });
    store.recordObservation({
      hostname: "app.slack.com",
      action_class: "click",
      dispatch_mode: "synthetic",
      had_effect: false,
    });
    const facts = store.getFacts("app.slack.com");
    expect(facts).toHaveLength(1);
    const f = facts[0]!;
    expect(f.hostname).toBe("app.slack.com");
    expect(f.action_class).toBe("click");
    expect(f.dispatch_mode).toBe("synthetic");
    expect(f.samples).toBe(1);
    expect(f.effect_count).toBe(0);
    expect(typeof f.updated_at).toBe("string");
    await store.close();
  });

  it("recordObservation increments samples and effect_count correctly", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const store = createObservedFactsStore({ path: factsPath(dir) });

    store.recordObservation({ hostname: "h.com", action_class: "click", dispatch_mode: "synthetic", had_effect: false });
    store.recordObservation({ hostname: "h.com", action_class: "click", dispatch_mode: "synthetic", had_effect: true });
    store.recordObservation({ hostname: "h.com", action_class: "click", dispatch_mode: "synthetic", had_effect: true });

    const facts = store.getFacts("h.com");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.samples).toBe(3);
    expect(facts[0]!.effect_count).toBe(2);
    await store.close();
  });

  it("getFacts returns only facts for the requested hostname", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const store = createObservedFactsStore({ path: factsPath(dir) });

    store.recordObservation({ hostname: "a.com", action_class: "click", dispatch_mode: "synthetic", had_effect: true });
    store.recordObservation({ hostname: "b.com", action_class: "type", dispatch_mode: "trusted", had_effect: false });

    expect(store.getFacts("a.com")).toHaveLength(1);
    expect(store.getFacts("b.com")).toHaveLength(1);
    expect(store.getFacts("c.com")).toHaveLength(0);
    await store.close();
  });

  it("multiple action_class/dispatch_mode per hostname are tracked separately", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const store = createObservedFactsStore({ path: factsPath(dir) });

    store.recordObservation({ hostname: "app.slack.com", action_class: "click", dispatch_mode: "synthetic", had_effect: false });
    store.recordObservation({ hostname: "app.slack.com", action_class: "click", dispatch_mode: "trusted", had_effect: true });
    store.recordObservation({ hostname: "app.slack.com", action_class: "type", dispatch_mode: "insertText", had_effect: true });

    const facts = store.getFacts("app.slack.com");
    expect(facts).toHaveLength(3);

    const synthetic = facts.find((f) => f.dispatch_mode === "synthetic");
    const trusted = facts.find((f) => f.dispatch_mode === "trusted");
    const insert = facts.find((f) => f.dispatch_mode === "insertText");

    expect(synthetic?.effect_count).toBe(0);
    expect(trusted?.effect_count).toBe(1);
    expect(insert?.action_class).toBe("type");
    await store.close();
  });

  it("snapshot returns all facts across all hostnames", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const store = createObservedFactsStore({ path: factsPath(dir) });

    store.recordObservation({ hostname: "x.com", action_class: "click", dispatch_mode: "synthetic", had_effect: false });
    store.recordObservation({ hostname: "y.com", action_class: "press", dispatch_mode: "trusted", had_effect: true });

    expect(store.snapshot()).toHaveLength(2);
    await store.close();
  });

  // -------------------------------------------------------------------------
  // Persistence: save + reload
  // -------------------------------------------------------------------------

  it("save writes facts to disk and reload restores them", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const path = factsPath(dir);

    const store1 = createObservedFactsStore({ path });
    store1.recordObservation({ hostname: "example.com", action_class: "click", dispatch_mode: "trusted", had_effect: true });
    store1.recordObservation({ hostname: "example.com", action_class: "click", dispatch_mode: "trusted", had_effect: true });
    await store1.save();

    // Verify file exists on disk.
    expect(existsSync(path)).toBe(true);
    const onDisk = readFacts(dir);
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]!.samples).toBe(2);
    expect(onDisk[0]!.effect_count).toBe(2);

    // New store loads from existing file.
    const store2 = createObservedFactsStore({ path });
    // Allow the async load to settle.
    await new Promise((r) => setTimeout(r, 50));
    const facts = store2.getFacts("example.com");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.samples).toBe(2);
    expect(facts[0]!.effect_count).toBe(2);
    await store2.close();
  });

  it("save + reload preserves multiple hostnames and fact entries", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const path = factsPath(dir);

    const store1 = createObservedFactsStore({ path });
    store1.recordObservation({ hostname: "a.com", action_class: "click", dispatch_mode: "synthetic", had_effect: false });
    store1.recordObservation({ hostname: "b.com", action_class: "type", dispatch_mode: "insertText", had_effect: true });
    store1.recordObservation({ hostname: "b.com", action_class: "press", dispatch_mode: "trusted", had_effect: true });
    await store1.save();

    const store2 = createObservedFactsStore({ path });
    await new Promise((r) => setTimeout(r, 50));

    expect(store2.getFacts("a.com")).toHaveLength(1);
    expect(store2.getFacts("b.com")).toHaveLength(2);
    expect(store2.snapshot()).toHaveLength(3);
    await store2.close();
  });

  it("close() triggers a final save before resolving", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const path = factsPath(dir);

    const store = createObservedFactsStore({ path });
    store.recordObservation({ hostname: "close-test.com", action_class: "click", dispatch_mode: "synthetic", had_effect: true });
    await store.close();

    expect(existsSync(path)).toBe(true);
    const facts = readFacts(dir);
    expect(facts[0]!.hostname).toBe("close-test.com");
  });

  // -------------------------------------------------------------------------
  // Atomic save uses .tmp + rename
  // -------------------------------------------------------------------------

  it("atomic save: no .tmp file remains after save completes", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const path = factsPath(dir);

    const store = createObservedFactsStore({ path });
    store.recordObservation({ hostname: "atomic.com", action_class: "click", dispatch_mode: "synthetic", had_effect: true });
    await store.save();

    // The final facts.json must exist.
    expect(existsSync(path)).toBe(true);
    // No stray .tmp file should remain after a successful atomic save.
    expect(existsSync(`${path}.tmp`)).toBe(false);

    // Content must be valid JSON with the expected fact.
    const facts = readFacts(dir);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.hostname).toBe("atomic.com");
    await store.close();
  });

  // -------------------------------------------------------------------------
  // Malformed file on load → starts empty, warns to stderr
  // -------------------------------------------------------------------------

  it("malformed file on load: starts empty and warns to stderr", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const path = factsPath(dir);

    // Write a malformed JSON file.
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "NOT VALID JSON", "utf8");

    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as NodeJS.WriteStream).write = (chunk: unknown): boolean => {
      stderrLines.push(String(chunk));
      return true;
    };

    let store: ReturnType<typeof createObservedFactsStore> | undefined;
    try {
      store = createObservedFactsStore({ path });
      // Wait for async load to complete.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      (process.stderr as NodeJS.WriteStream).write = originalWrite;
    }

    // Should warn about the failure.
    const allOutput = stderrLines.join("");
    expect(allOutput).toMatch(/warn:/);

    // Should start with empty state.
    expect(store!.getFacts("any.com")).toEqual([]);
    expect(store!.snapshot()).toHaveLength(0);

    await store!.close();
  });

  it("malformed file on load: non-array JSON warns to stderr and starts empty", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const path = factsPath(dir);

    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ not: "an array" }), "utf8");

    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as NodeJS.WriteStream).write = (chunk: unknown): boolean => {
      stderrLines.push(String(chunk));
      return true;
    };

    let store: ReturnType<typeof createObservedFactsStore> | undefined;
    try {
      store = createObservedFactsStore({ path });
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      (process.stderr as NodeJS.WriteStream).write = originalWrite;
    }

    const allOutput = stderrLines.join("");
    expect(allOutput).toMatch(/malformed/);
    expect(store!.snapshot()).toHaveLength(0);
    await store!.close();
  });

  // -------------------------------------------------------------------------
  // Missing file on first run → starts empty, no warning
  // -------------------------------------------------------------------------

  it("missing file on first run: starts empty without warning", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    // Use a path that doesn't exist yet (the dir was just created, file absent).
    const path = factsPath(dir);

    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as NodeJS.WriteStream).write = (chunk: unknown): boolean => {
      stderrLines.push(String(chunk));
      return true;
    };

    let store: ReturnType<typeof createObservedFactsStore> | undefined;
    try {
      store = createObservedFactsStore({ path });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      (process.stderr as NodeJS.WriteStream).write = originalWrite;
    }

    // No warning for ENOENT.
    const allOutput = stderrLines.join("");
    expect(allOutput).not.toMatch(/warn:/);
    expect(store!.snapshot()).toHaveLength(0);
    await store!.close();
  });

  // -------------------------------------------------------------------------
  // updated_at is updated on each observation
  // -------------------------------------------------------------------------

  it("updated_at advances on subsequent observations", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const store = createObservedFactsStore({ path: factsPath(dir) });

    store.recordObservation({ hostname: "ts.com", action_class: "click", dispatch_mode: "synthetic", had_effect: false });
    const ts1 = store.getFacts("ts.com")[0]!.updated_at;

    // Small delay to guarantee timestamp differs.
    await new Promise((r) => setTimeout(r, 10));

    store.recordObservation({ hostname: "ts.com", action_class: "click", dispatch_mode: "synthetic", had_effect: true });
    const ts2 = store.getFacts("ts.com")[0]!.updated_at;

    expect(new Date(ts2) >= new Date(ts1)).toBe(true);
    await store.close();
  });
});
