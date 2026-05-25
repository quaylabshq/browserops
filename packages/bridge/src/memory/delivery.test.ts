/**
 * Tests for Phase 6 hybrid delivery:
 *   - SiteContextManager state machine (prime-once → suppress → re-nudge)
 *   - formatPrimer (≤5, confidence order, titles only)
 *   - global digest content in buildServerInstructions
 *   - bumpDoorFailure / door-failure self-heal
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryRecord } from "@browserops/shared";
import {
  SiteContextManager,
  formatPrimer,
  type SitePrimer,
} from "./delivery.js";
import { buildServerInstructions } from "../server-instructions.js";
import { bumpDoorFailure, saveRecord } from "./store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function siteRecord(overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    schema_version: 1,
    name: "notion-upload-blocker",
    scope: "site",
    kind: "blocker",
    title: "Notion file upload blocked by dialog",
    origin: "https://www.notion.so",
    detail: {
      wall: "File upload dialog does not appear",
      door: "Click the + icon in the sidebar first to reveal the upload option",
    },
    severity: "high",
    ...overrides,
  };
}

function globalRecord(overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    schema_version: 1,
    name: "global-lesson",
    scope: "global",
    kind: "lesson",
    title: "Always check for cookie banners before interacting",
    detail: { note: "Dismiss cookie consent banners first." },
    severity: "med",
    ...overrides,
  };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".delivery-test-"),
  );
  process.env["BROWSEROPS_MEMORY_DIR"] = tmpRoot;
});

afterEach(async () => {
  delete process.env["BROWSEROPS_MEMORY_DIR"];
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// formatPrimer
// ---------------------------------------------------------------------------

describe("formatPrimer", () => {
  it("returns terse title-only index ≤5 entries", () => {
    const records: MemoryRecord[] = Array.from({ length: 8 }, (_, i) =>
      siteRecord({
        name: `blocker-${i}`,
        title: `Blocker ${i}`,
        severity: i < 3 ? "high" : "med",
      }),
    );

    const primer = formatPrimer("https://www.notion.so", records);

    expect(primer.records.length).toBeLessThanOrEqual(5);
    expect(primer.origin).toBe("https://www.notion.so");
    expect(primer.hint).toMatch(/memory_get/);
  });

  it("ranks by confidence (high severity first)", () => {
    const records: MemoryRecord[] = [
      siteRecord({ name: "low-sev", title: "Low severity record", severity: "low" }),
      siteRecord({ name: "high-sev", title: "High severity record", severity: "high" }),
      siteRecord({ name: "med-sev", title: "Med severity record", severity: "med" }),
    ];

    const primer = formatPrimer("https://www.notion.so", records);

    // Highest confidence (high severity) should be first
    expect(primer.records[0]!.name).toBe("high-sev");
    expect(primer.records[0]!.title).toBe("High severity record");
  });

  it("includes name, kind, title, confidence fields", () => {
    const primer = formatPrimer("https://www.notion.so", [siteRecord()]);
    const entry = primer.records[0]!;
    expect(entry).toHaveProperty("name");
    expect(entry).toHaveProperty("kind");
    expect(entry).toHaveProperty("title");
    expect(entry).toHaveProperty("confidence");
    expect(typeof entry.confidence).toBe("number");
    // Confirm no detail.door is inlined
    expect(JSON.stringify(entry)).not.toContain("Click the +");
  });

  it("returns empty records array for empty input", () => {
    const primer = formatPrimer("https://example.com", []);
    expect(primer.records).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SiteContextManager — state machine
// ---------------------------------------------------------------------------

describe("SiteContextManager — prime-once/suppress/re-nudge", () => {
  it("shouldPrime returns primer on first call (UNPRIMED → PRIMED)", () => {
    const scm = new SiteContextManager();
    const records = [siteRecord()];
    scm.warm("https://www.notion.so", records);

    const primer = scm.shouldPrime("s_1", "https://www.notion.so");
    expect(primer).not.toBeNull();
    expect((primer as SitePrimer).origin).toBe("https://www.notion.so");
    expect(scm.getState("s_1", "https://www.notion.so")).toBe("PRIMED");
  });

  it("shouldPrime suppresses on subsequent calls (PRIMED → null)", () => {
    const scm = new SiteContextManager();
    scm.warm("https://www.notion.so", [siteRecord()]);

    scm.shouldPrime("s_1", "https://www.notion.so"); // first call
    const second = scm.shouldPrime("s_1", "https://www.notion.so");
    expect(second).toBeNull();
  });

  it("shouldPrime is session-isolated (different sessions prime independently)", () => {
    const scm = new SiteContextManager();
    const records = [siteRecord()];
    scm.warm("https://www.notion.so", records);

    const p1 = scm.shouldPrime("s_1", "https://www.notion.so");
    const p2 = scm.shouldPrime("s_2", "https://www.notion.so");
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
  });

  it("shouldPrime returns null when no records are warmed", () => {
    const scm = new SiteContextManager();
    const result = scm.shouldPrime("s_1", "https://new.site");
    expect(result).toBeNull();
  });

  it("reNudge transitions to RE-NUDGED and returns door", () => {
    const scm = new SiteContextManager();
    scm.warm("https://www.notion.so", [siteRecord()]);
    scm.shouldPrime("s_1", "https://www.notion.so"); // prime first

    const nudge = scm.reNudge("s_1", "https://www.notion.so", "upload");
    expect(nudge).not.toBeNull();
    expect(nudge!.door).toContain("Click the +");
    expect(scm.getState("s_1", "https://www.notion.so")).toBe("RE-NUDGED");
  });

  it("reNudge returns null when no blocker records exist", () => {
    const scm = new SiteContextManager();
    scm.warm("https://www.notion.so", [
      siteRecord({ kind: "affordance", detail: { note: "Affordance note" } }),
    ]);
    const nudge = scm.reNudge("s_1", "https://www.notion.so", "");
    expect(nudge).toBeNull();
  });

  it("wasPrimed returns true after prime, false before", () => {
    const scm = new SiteContextManager();
    scm.warm("https://www.notion.so", [siteRecord()]);
    expect(scm.wasPrimed("s_1", "https://www.notion.so")).toBe(false);
    scm.shouldPrime("s_1", "https://www.notion.so");
    expect(scm.wasPrimed("s_1", "https://www.notion.so")).toBe(true);
  });

  it("warm replaces existing cache", () => {
    const scm = new SiteContextManager();
    scm.warm("https://www.notion.so", [siteRecord({ name: "old-record" })]);
    scm.warm("https://www.notion.so", [siteRecord({ name: "new-record" })]);
    expect(scm.recordsFor("https://www.notion.so")[0]!.name).toBe("new-record");
  });

  it("findBestBlocker returns highest-confidence blocker", () => {
    const scm = new SiteContextManager();
    const records = [
      siteRecord({ name: "low-blocker", severity: "low" }),
      siteRecord({ name: "high-blocker", severity: "high" }),
    ];
    scm.warm("https://www.notion.so", records);
    const best = scm.findBestBlocker("https://www.notion.so");
    expect(best).not.toBeNull();
    expect(best!.name).toBe("high-blocker");
  });

  it("findBestBlocker returns null when no blockers with door exist", () => {
    const scm = new SiteContextManager();
    scm.warm("https://www.notion.so", [
      siteRecord({ kind: "lesson", detail: { note: "A note" } }),
    ]);
    const best = scm.findBestBlocker("https://www.notion.so");
    expect(best).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildServerInstructions — global digest content
// ---------------------------------------------------------------------------

describe("buildServerInstructions — global digest", () => {
  it("includes globalDigest in instructions when provided", () => {
    const digest = "- [lesson] Always check for cookie banners  (global-lesson)";
    const instructions = buildServerInstructions(new Set(["memory"]), {
      globalDigest: digest,
    });
    expect(instructions).toContain("Global memory");
    expect(instructions).toContain(digest);
    expect(instructions).toContain("memory_get(name)");
  });

  it("omits global memory section when digest is not provided", () => {
    const instructions = buildServerInstructions(new Set(["memory"]));
    expect(instructions).not.toContain("Global memory (cross-site");
  });

  it("omits global memory section when digest is empty string", () => {
    const instructions = buildServerInstructions(new Set(["memory"]), {
      globalDigest: "",
    });
    expect(instructions).not.toContain("Global memory (cross-site");
  });
});

// ---------------------------------------------------------------------------
// bumpDoorFailure — store stats-bump
// ---------------------------------------------------------------------------

describe("bumpDoorFailure", () => {
  it("increments door_failures on an existing site record", async () => {
    const origin = "https://www.notion.so";
    const rec = siteRecord({
      name: "notion-upload-blocker",
      stats: { hits: 5, resolved: 2, door_failures: 0, captures: 1 },
    });
    await saveRecord({ record: rec });

    await bumpDoorFailure("notion-upload-blocker", "site", origin);

    const { listRecords } = await import("./store.js");
    const records = await listRecords({ scope: "site", origin });
    const found = records.find((r) => r.name === "notion-upload-blocker");
    expect(found).toBeDefined();
    expect(found!.stats!.door_failures).toBe(1);
    expect(found!.stats!.last_hit).toBeDefined();
  });

  it("starts from 0 when stats are absent", async () => {
    const origin = "https://www.notion.so";
    const rec = siteRecord({ name: "notion-no-stats" });
    // Remove stats explicitly
    const { stats: _stats, ...rest } = rec;
    await saveRecord({ record: { ...rest, name: "notion-no-stats" } as MemoryRecord });

    await bumpDoorFailure("notion-no-stats", "site", origin);

    const { listRecords } = await import("./store.js");
    const records = await listRecords({ scope: "site", origin });
    const found = records.find((r) => r.name === "notion-no-stats");
    expect(found!.stats!.door_failures).toBe(1);
  });

  it("is a no-op for a non-existent record (best-effort)", async () => {
    // Should not throw
    await expect(
      bumpDoorFailure("does-not-exist", "site", "https://www.notion.so"),
    ).resolves.toBeUndefined();
  });

  it("works on global-scope records", async () => {
    const rec = globalRecord({ name: "global-lesson" });
    await saveRecord({ record: rec });

    await bumpDoorFailure("global-lesson", "global");

    const { listRecords } = await import("./store.js");
    const records = await listRecords({ scope: "global" });
    const found = records.find((r) => r.name === "global-lesson");
    expect(found!.stats!.door_failures).toBe(1);
  });
});
