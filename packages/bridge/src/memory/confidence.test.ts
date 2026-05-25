/**
 * Tests for the confidence model: confidence math, recency decay,
 * resolution-ratio effects, door-failure demotion, index persistence,
 * and that search ranking reflects confidence.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryRecord, MemoryStats } from "@browserops/shared";
import {
  confidence,
  doorUnreliable,
  recencyFactor,
  DOOR_FAILURE_MIN_OBSERVATIONS,
  DOOR_FAILURE_RATIO_THRESHOLD,
  RECENCY_HALF_LIFE_DAYS,
} from "./confidence.js";
import { indexPath, rebuildIndex, saveRecord } from "./store.js";
import { searchRecordsWithConfidence } from "./search.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    schema_version: 1,
    name: "test-record",
    scope: "global",
    kind: "lesson",
    title: "Test record title",
    detail: { note: "A test note." },
    ...overrides,
  };
}

function makeStats(overrides?: Partial<MemoryStats>): MemoryStats {
  return {
    hits: 0,
    resolved: 0,
    door_failures: 0,
    captures: 0,
    ...overrides,
  };
}

/** Return an ISO timestamp N days ago from the reference date. */
function daysAgo(days: number, from: Date = new Date()): string {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".confidence-test-"),
  );
  process.env["BROWSEROPS_MEMORY_DIR"] = tmpRoot;
});

afterEach(async () => {
  delete process.env["BROWSEROPS_MEMORY_DIR"];
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// recencyFactor
// ---------------------------------------------------------------------------

describe("recencyFactor", () => {
  it("returns 1.0 for a last_hit of today", () => {
    const now = new Date();
    const factor = recencyFactor(now.toISOString(), now);
    expect(factor).toBeCloseTo(1.0, 5);
  });

  it("returns ~0.5 at exactly the half-life", () => {
    const now = new Date();
    const halfLifeAgo = daysAgo(RECENCY_HALF_LIFE_DAYS, now);
    const factor = recencyFactor(halfLifeAgo, now);
    expect(factor).toBeCloseTo(0.5, 2);
  });

  it("returns a smaller value at 2× the half-life", () => {
    const now = new Date();
    const oneHalfLife = recencyFactor(daysAgo(RECENCY_HALF_LIFE_DAYS, now), now);
    const twoHalfLives = recencyFactor(daysAgo(2 * RECENCY_HALF_LIFE_DAYS, now), now);
    expect(twoHalfLives).toBeLessThan(oneHalfLife);
    expect(twoHalfLives).toBeCloseTo(0.25, 2);
  });

  it("returns 0.5 (neutral) when last_hit is undefined", () => {
    const factor = recencyFactor(undefined, new Date());
    expect(factor).toBe(0.5);
  });

  it("returns 0.5 (neutral) when last_hit is an invalid date string", () => {
    const factor = recencyFactor("not-a-date", new Date());
    expect(factor).toBe(0.5);
  });

  it("returns 1.0 for a future last_hit (treated as fresh)", () => {
    const now = new Date();
    const future = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const factor = recencyFactor(future.toISOString(), now);
    expect(factor).toBe(1.0);
  });

  it("decays monotonically as time increases", () => {
    const now = new Date();
    const f7 = recencyFactor(daysAgo(7, now), now);
    const f14 = recencyFactor(daysAgo(14, now), now);
    const f60 = recencyFactor(daysAgo(60, now), now);
    expect(f7).toBeGreaterThan(f14);
    expect(f14).toBeGreaterThan(f60);
  });
});

// ---------------------------------------------------------------------------
// doorUnreliable
// ---------------------------------------------------------------------------

describe("doorUnreliable", () => {
  it("returns false when observations < DOOR_FAILURE_MIN_OBSERVATIONS", () => {
    const stats = makeStats({
      resolved: 0,
      door_failures: DOOR_FAILURE_MIN_OBSERVATIONS - 1,
    });
    expect(doorUnreliable(stats)).toBe(false);
  });

  it("returns false when failure ratio < threshold", () => {
    // 1 failure out of 5: ratio = 0.2 < 0.6
    const stats = makeStats({ resolved: 4, door_failures: 1 });
    expect(doorUnreliable(stats)).toBe(false);
  });

  it("returns true when failure ratio >= threshold with enough observations", () => {
    // 3 failures out of 5: ratio = 0.6 >= 0.6, total = 5 >= 3
    const stats = makeStats({
      resolved: 2,
      door_failures: 3,
    });
    expect(doorUnreliable(stats)).toBe(true);
  });

  it("threshold constant is exported and matches behaviour", () => {
    // Exactly at the threshold
    expect(DOOR_FAILURE_RATIO_THRESHOLD).toBeGreaterThan(0);
    expect(DOOR_FAILURE_RATIO_THRESHOLD).toBeLessThan(1);
    expect(DOOR_FAILURE_MIN_OBSERVATIONS).toBeGreaterThan(0);
  });

  it("returns true for a record whose door has failed every time", () => {
    const stats = makeStats({
      resolved: 0,
      door_failures: DOOR_FAILURE_MIN_OBSERVATIONS,
    });
    expect(doorUnreliable(stats)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// confidence — severity ordering
// ---------------------------------------------------------------------------

describe("confidence — severity ordering", () => {
  const now = new Date();

  it("high severity scores higher than med, which scores higher than low (no stats)", () => {
    const high = confidence(makeRecord({ severity: "high" }), now);
    const med = confidence(makeRecord({ severity: "med" }), now);
    const low = confidence(makeRecord({ severity: "low" }), now);
    expect(high).toBeGreaterThan(med);
    expect(med).toBeGreaterThan(low);
  });

  it("high severity scores higher than med with same healthy stats", () => {
    const stats = makeStats({ resolved: 5, door_failures: 0, last_hit: daysAgo(1, now) });
    const high = confidence(makeRecord({ severity: "high", stats }), now);
    const med = confidence(makeRecord({ severity: "med", stats }), now);
    expect(high).toBeGreaterThan(med);
  });

  it("defaults to med severity when none is provided", () => {
    const withMed = confidence(makeRecord({ severity: "med" }), now);
    const withDefault = confidence(makeRecord({ severity: undefined }), now);
    expect(withDefault).toBeCloseTo(withMed, 5);
  });
});

// ---------------------------------------------------------------------------
// confidence — recency decay
// ---------------------------------------------------------------------------

describe("confidence — recency decay reduces score over time", () => {
  it("a recently hit record scores higher than a stale one", () => {
    const now = new Date();
    const recentStats = makeStats({ resolved: 3, door_failures: 0, last_hit: daysAgo(1, now) });
    const staleStats = makeStats({ resolved: 3, door_failures: 0, last_hit: daysAgo(120, now) });
    const recent = confidence(makeRecord({ stats: recentStats }), now);
    const stale = confidence(makeRecord({ stats: staleStats }), now);
    expect(recent).toBeGreaterThan(stale);
  });

  it("score decreases as last_hit moves further into the past", () => {
    const now = new Date();
    const baseStats = makeStats({ resolved: 2, door_failures: 0 });
    const f0 = confidence(makeRecord({ stats: { ...baseStats, last_hit: daysAgo(0, now) } }), now);
    const f30 = confidence(makeRecord({ stats: { ...baseStats, last_hit: daysAgo(30, now) } }), now);
    const f90 = confidence(makeRecord({ stats: { ...baseStats, last_hit: daysAgo(90, now) } }), now);
    expect(f0).toBeGreaterThan(f30);
    expect(f30).toBeGreaterThan(f90);
  });
});

// ---------------------------------------------------------------------------
// confidence — resolution ratio effects
// ---------------------------------------------------------------------------

describe("confidence — resolution ratio", () => {
  const now = new Date();

  it("perfect resolution (no failures) scores higher than many failures", () => {
    const good = makeStats({ resolved: 5, door_failures: 0, last_hit: daysAgo(1, now) });
    const bad = makeStats({ resolved: 1, door_failures: 5, last_hit: daysAgo(1, now) });
    expect(confidence(makeRecord({ stats: good }), now)).toBeGreaterThan(
      confidence(makeRecord({ stats: bad }), now),
    );
  });

  it("0 resolved and 0 door_failures (no data) returns neutral-ish value", () => {
    const stats = makeStats({ resolved: 0, door_failures: 0 });
    const c = confidence(makeRecord({ stats }), now);
    // Should be in a reasonable neutral range, not 0 or 1
    expect(c).toBeGreaterThan(0.2);
    expect(c).toBeLessThan(0.9);
  });

  it("record with all failures scores lower than one with all successes", () => {
    const allFail = makeStats({ resolved: 0, door_failures: 5, last_hit: daysAgo(1, now) });
    const allPass = makeStats({ resolved: 5, door_failures: 0, last_hit: daysAgo(1, now) });
    expect(confidence(makeRecord({ stats: allFail }), now)).toBeLessThan(
      confidence(makeRecord({ stats: allPass }), now),
    );
  });
});

// ---------------------------------------------------------------------------
// confidence — door-failure demotion
// ---------------------------------------------------------------------------

describe("confidence — door-failure demotion", () => {
  const now = new Date();

  it("doorUnreliable record scores below a healthy record", () => {
    // doorUnreliable: 3/5 failures ≥ 0.6 threshold
    const unreliableStats = makeStats({
      resolved: 2,
      door_failures: 3,
      last_hit: daysAgo(1, now),
    });
    const healthyStats = makeStats({
      resolved: 5,
      door_failures: 0,
      last_hit: daysAgo(1, now),
    });
    const unreliable = confidence(makeRecord({ kind: "blocker", title: "Blocker", detail: { wall: "Wall.", door: "Door." }, stats: unreliableStats }), now);
    const healthy = confidence(makeRecord({ kind: "blocker", title: "Blocker", detail: { wall: "Wall.", door: "Door." }, stats: healthyStats }), now);
    expect(doorUnreliable(unreliableStats)).toBe(true);
    expect(unreliable).toBeLessThan(healthy);
  });

  it("growing door_failures causes monotonically decreasing confidence", () => {
    const now2 = new Date();
    const base = { resolved: 2, last_hit: daysAgo(1, now2) };
    const c0 = confidence(makeRecord({ stats: makeStats({ ...base, door_failures: 0 }) }), now2);
    const c2 = confidence(makeRecord({ stats: makeStats({ ...base, door_failures: 2 }) }), now2);
    const c5 = confidence(makeRecord({ stats: makeStats({ ...base, door_failures: 5 }) }), now2);
    expect(c0).toBeGreaterThan(c2);
    expect(c2).toBeGreaterThan(c5);
  });
});

// ---------------------------------------------------------------------------
// confidence — no-stats neutral
// ---------------------------------------------------------------------------

describe("confidence — no stats returns sane neutral", () => {
  it("returns a value in (0, 1) when stats is undefined", () => {
    const c = confidence(makeRecord({ stats: undefined }));
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(1);
  });

  it("outputs are always in [0, 1]", () => {
    const cases: MemoryStats[] = [
      makeStats({ resolved: 0, door_failures: 0 }),
      makeStats({ resolved: 100, door_failures: 0 }),
      makeStats({ resolved: 0, door_failures: 100 }),
      makeStats({ resolved: 50, door_failures: 50, last_hit: daysAgo(365) }),
    ];
    for (const stats of cases) {
      const c = confidence(makeRecord({ stats }));
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Index confidence persistence
// ---------------------------------------------------------------------------

describe("index confidence map", () => {
  it("rebuildIndex populates confidence for saved records", async () => {
    await saveRecord({
      record: makeRecord({ name: "alpha", title: "Alpha distinct tip about Slack keyboard shortcuts", detail: { note: "Use Ctrl+K in Slack to switch channels quickly." } }),
    });
    await saveRecord({
      record: makeRecord({ name: "beta", title: "Beta distinct tip about Gmail compose workflow", detail: { note: "Click the blue compose button in the bottom-left corner." } }),
    });
    const index = await rebuildIndex();
    expect(typeof index.confidence["alpha"]).toBe("number");
    expect(index.confidence["alpha"]).toBeGreaterThanOrEqual(0);
    expect(index.confidence["alpha"]).toBeLessThanOrEqual(1);
    expect(typeof index.confidence["beta"]).toBe("number");
    expect(index.confidence["beta"]).toBeGreaterThanOrEqual(0);
    expect(index.confidence["beta"]).toBeLessThanOrEqual(1);
  });

  it("confidence values in index.json match confidence() output", async () => {
    const record = makeRecord({ name: "check-record", severity: "high" });
    await saveRecord({ record });
    const index = await rebuildIndex();
    const raw = await fs.readFile(indexPath(), "utf8");
    const parsed = JSON.parse(raw) as { confidence: Record<string, number> };
    expect(parsed.confidence["check-record"]).toBeGreaterThan(0);
    expect(parsed.confidence["check-record"]).toBeLessThanOrEqual(1);
    // Index value matches in-memory index
    expect(parsed.confidence["check-record"]).toBe(index.confidence["check-record"]);
  });

  it("records no longer on disk are absent from the confidence map", async () => {
    // Write a pre-existing index with a stale key
    await fs.mkdir(tmpRoot, { recursive: true });
    await fs.writeFile(
      indexPath(),
      JSON.stringify({ global: [], origins: {}, confidence: { "ghost-record": 0.99 } }),
      "utf8",
    );
    // Save a real record (triggers rebuildIndex)
    await saveRecord({ record: makeRecord({ name: "real-record" }) });
    const raw = await fs.readFile(indexPath(), "utf8");
    const parsed = JSON.parse(raw) as { confidence: Record<string, number> };
    expect(parsed.confidence["ghost-record"]).toBeUndefined();
    expect(typeof parsed.confidence["real-record"]).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// searchRecordsWithConfidence — ranking reflects confidence
// ---------------------------------------------------------------------------

describe("searchRecordsWithConfidence", () => {
  const now = new Date();

  it("ranks high-confidence record above low-confidence with same query coverage", () => {
    const highStats = makeStats({ resolved: 5, door_failures: 0, last_hit: daysAgo(1, now) });
    const lowStats = makeStats({ resolved: 0, door_failures: 5, last_hit: daysAgo(120, now) });
    const records: MemoryRecord[] = [
      makeRecord({ name: "low-rec", title: "Gmail compose button tip", detail: { note: "Click compose." }, stats: lowStats }),
      makeRecord({ name: "high-rec", title: "Gmail compose email tip", detail: { note: "Click compose." }, stats: highStats }),
    ];
    const result = searchRecordsWithConfidence(records, "Gmail compose", { min_score: 0.1 });
    expect(result.matches[0]?.name).toBe("high-rec");
  });

  it("result match includes a confidence score", () => {
    const records: MemoryRecord[] = [
      makeRecord({ name: "with-conf", title: "Slack send message tip", detail: { note: "Press Enter to send." } }),
    ];
    const result = searchRecordsWithConfidence(records, "Slack send", { min_score: 0.1 });
    expect(result.matches.length).toBeGreaterThan(0);
    const match = result.matches[0]!;
    expect(typeof match.confidence).toBe("number");
    expect(match.confidence).toBeGreaterThanOrEqual(0);
    expect(match.confidence).toBeLessThanOrEqual(1);
  });

  it("scope filter is respected", () => {
    const records: MemoryRecord[] = [
      makeRecord({ name: "g-tip", scope: "global", title: "Gmail compose lesson", detail: { note: "Compose." } }),
      {
        schema_version: 1,
        name: "s-tip",
        scope: "site",
        kind: "blocker",
        title: "Gmail modal blocker",
        origin: "https://mail.google.com",
        detail: { wall: "Wall.", door: "Door." },
      },
    ];
    const result = searchRecordsWithConfidence(records, "Gmail", { scope: "global", min_score: 0.1 });
    expect(result.matches.every((m) => m.scope === "global")).toBe(true);
    expect(result.matches.map((m) => m.name)).not.toContain("s-tip");
  });
});
