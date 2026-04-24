/**
 * Persistent observed-facts store for learned dispatch hints.
 *
 * Tracks per-hostname, per-action-class, per-dispatch-mode observation
 * counts so the bridge can learn over time whether a given dispatch mode
 * produces a measurable page effect on a given site.
 *
 * Enabled by default. Disabled via BROWSEROPS_OBSERVED_FACTS=0.
 * Directory override: BROWSEROPS_OBSERVED_DIR=<path>.
 *
 * File format: ~/browserops/observed/facts.json
 * Save strategy: atomic (write to .tmp then rename). Debounced at 5 s
 * so rapid observation bursts don't thrash the disk.
 */
import * as fs from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ObservedFact {
  hostname: string;
  action_class: "click" | "type" | "press";
  dispatch_mode: "synthetic" | "trusted" | "insertText";
  /** Total number of observations recorded. */
  samples: number;
  /**
   * How many of those observations produced a measurable page effect.
   * Effect = non-zero DOM mutations OR URL changed OR focus changed OR
   * network requests > 0 (as reported by the extension result).
   */
  effect_count: number;
  /** ISO-8601 timestamp of the last update. */
  updated_at: string;
}

export interface ObservedFactsStore {
  /** Returns all facts for a given hostname (may be empty). */
  getFacts(hostname: string): ObservedFact[];
  /** Record a single observation. Mutates in-memory state and schedules a debounced save. */
  recordObservation(params: {
    hostname: string;
    action_class: ObservedFact["action_class"];
    dispatch_mode: ObservedFact["dispatch_mode"];
    had_effect: boolean;
  }): void;
  /** Returns all facts as a flat array (for debugging / inspection). */
  snapshot(): ObservedFact[];
  /** Flush in-memory state to disk (atomic write). */
  save(): Promise<void>;
  /** Final save + cancel any pending debounce timer. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/** Composite key used as map key in memory. */
function factKey(
  hostname: string,
  action_class: ObservedFact["action_class"],
  dispatch_mode: ObservedFact["dispatch_mode"],
): string {
  return `${hostname}\0${action_class}\0${dispatch_mode}`;
}

// ---------------------------------------------------------------------------
// No-op store
// ---------------------------------------------------------------------------

const NOOP_STORE: ObservedFactsStore = {
  getFacts: () => [],
  recordObservation: () => {},
  snapshot: () => [],
  save: async () => {},
  close: async () => {},
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createObservedFactsStore(options: {
  /** Override the default facts.json path. */
  path?: string;
  /** When false returns a no-op store. Defaults to true. */
  enabled?: boolean;
}): ObservedFactsStore {
  if (options.enabled === false) {
    return NOOP_STORE;
  }

  const factsPath =
    options.path ??
    join(homedir(), ".browserops", "observed", "facts.json");

  // In-memory index: composite key → ObservedFact.
  const index = new Map<string, ObservedFact>();

  // Debounce timer reference.
  let saveTimer: NodeJS.Timeout | null = null;
  // Guard against concurrent saves.
  let savePromise: Promise<void> | null = null;

  // -------------------------------------------------------------------------
  // Boot: load existing facts from disk.
  // -------------------------------------------------------------------------

  // Ensure parent directory exists synchronously at construction time so the
  // first save never races with a missing directory.
  try {
    mkdirSync(dirname(factsPath), { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `browserops: warn: observed-facts dir creation failed (${dirname(factsPath)}): ${msg}\n`,
    );
    // Fall back to no-op — don't crash the bridge.
    return NOOP_STORE;
  }

  // Load is synchronous enough via a top-level async IIFE; we use a lazy init
  // flag to surface load errors without blocking the factory return.
  let loaded = false;

  loadFromDisk().catch(() => {
    // Error is logged inside loadFromDisk; we swallow here so the store still
    // works (starting empty) even if the file can't be read.
  });

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  async function loadFromDisk(): Promise<void> {
    if (loaded) return;
    try {
      const raw = await fs.readFile(factsPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        process.stderr.write(
          `browserops: warn: observed-facts file is malformed (expected array), starting empty\n`,
        );
        loaded = true;
        return;
      }
      for (const item of parsed) {
        if (!isValidFact(item)) continue;
        const key = factKey(item.hostname, item.action_class, item.dispatch_mode);
        index.set(key, item);
      }
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "ENOENT") {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `browserops: warn: observed-facts load failed (${factsPath}): ${msg}, starting empty\n`,
        );
      }
      // ENOENT is expected on first run — silent.
    }
    loaded = true;
  }

  function isValidFact(v: unknown): v is ObservedFact {
    if (!v || typeof v !== "object") return false;
    const f = v as Record<string, unknown>;
    return (
      typeof f["hostname"] === "string" &&
      (f["action_class"] === "click" ||
        f["action_class"] === "type" ||
        f["action_class"] === "press") &&
      (f["dispatch_mode"] === "synthetic" ||
        f["dispatch_mode"] === "trusted" ||
        f["dispatch_mode"] === "insertText") &&
      typeof f["samples"] === "number" &&
      typeof f["effect_count"] === "number" &&
      typeof f["updated_at"] === "string"
    );
  }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  function getFacts(hostname: string): ObservedFact[] {
    const results: ObservedFact[] = [];
    for (const fact of index.values()) {
      if (fact.hostname === hostname) results.push(fact);
    }
    return results;
  }

  function recordObservation(params: {
    hostname: string;
    action_class: ObservedFact["action_class"];
    dispatch_mode: ObservedFact["dispatch_mode"];
    had_effect: boolean;
  }): void {
    const key = factKey(params.hostname, params.action_class, params.dispatch_mode);
    const existing = index.get(key);
    if (existing) {
      existing.samples += 1;
      if (params.had_effect) existing.effect_count += 1;
      existing.updated_at = new Date().toISOString();
    } else {
      index.set(key, {
        hostname: params.hostname,
        action_class: params.action_class,
        dispatch_mode: params.dispatch_mode,
        samples: 1,
        effect_count: params.had_effect ? 1 : 0,
        updated_at: new Date().toISOString(),
      });
    }

    // Schedule debounced save (max 1 flush per 5 s).
    if (!saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        save().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`browserops: warn: observed-facts debounce save failed: ${msg}\n`);
        });
      }, 5_000);
    }
  }

  function snapshot(): ObservedFact[] {
    return Array.from(index.values());
  }

  async function save(): Promise<void> {
    // Serialize the full index.
    const facts = Array.from(index.values());
    const tmp = `${factsPath}.tmp`;
    const json = JSON.stringify(facts, null, 2);

    // Chain saves so concurrent calls don't interleave file I/O.
    if (savePromise) {
      savePromise = savePromise.then(() => atomicWrite(tmp, factsPath, json));
    } else {
      savePromise = atomicWrite(tmp, factsPath, json);
    }
    return savePromise.finally(() => {
      savePromise = null;
    });
  }

  async function close(): Promise<void> {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await save();
  }

  return { getFacts, recordObservation, snapshot, save, close };
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

async function atomicWrite(tmp: string, dest: string, content: string): Promise<void> {
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, dest);
}
