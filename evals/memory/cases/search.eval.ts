/**
 * Capability D — search + confidence/decay: ranking, filters, recency, doorUnreliable.
 */
import type { MemoryRecord, MemoryStats } from "@browserops/shared";
import {
  searchRecords,
  searchRecordsWithConfidence,
} from "../../../packages/bridge/src/memory/search.js";
import {
  confidence,
  recencyFactor,
  doorUnreliable,
  DOOR_FAILURE_RATIO_THRESHOLD,
  DOOR_FAILURE_MIN_OBSERVATIONS,
  RECENCY_HALF_LIFE_DAYS,
} from "../../../packages/bridge/src/memory/confidence.js";
import { check, checkEqual, defineEval } from "../harness.js";

function makeLesson(name: string, overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    schema_version: 1,
    name,
    scope: "global",
    kind: "lesson",
    title: "A test lesson record",
    detail: { note: "this is a test note" },
    ...overrides,
  };
}

function makeSiteBlocker(
  name: string,
  origin: string,
  overrides?: Partial<MemoryRecord>,
): MemoryRecord {
  return {
    schema_version: 1,
    name,
    scope: "site",
    kind: "blocker",
    title: "cookie consent blocks interaction",
    origin,
    detail: {
      wall: "modal blocks all interaction until dismissed",
      door: "click the dismiss button to proceed",
    },
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

defineEval({
  id: "D1",
  capability: "search",
  title: "confidence-first ranking: higher confidence record ranks above token-match tie",
  run() {
    const now = new Date("2025-01-01T00:00:00.000Z");

    // Two records that both match "cookie consent modal"
    // rec1 has higher confidence (more resolved, recent hit)
    const rec1 = makeLesson("d1-high-confidence-lesson", {
      title: "cookie consent modal blocks interaction",
      detail: { note: "dismiss the cookie consent modal first" },
      severity: "high",
      stats: makeStats({
        hits: 10,
        resolved: 8,
        door_failures: 1,
        last_hit: "2025-01-01T00:00:00.000Z", // same day as "now"
      }),
    });

    // rec2 matches but has zero stats (lower confidence)
    const rec2 = makeLesson("d1-low-confidence-lesson", {
      title: "cookie consent modal blocks interaction",
      detail: { note: "dismiss the cookie consent modal first" },
      severity: "low",
      stats: makeStats({ hits: 0, resolved: 0, door_failures: 5 }),
    });

    const result = searchRecordsWithConfidence([rec1, rec2], "cookie consent modal", {});
    check(result.matches.length >= 2, "should have at least 2 results");
    checkEqual(result.matches[0].name, rec1.name, "high-confidence record should rank first");
  },
});

defineEval({
  id: "D2",
  capability: "search",
  title: "scope filter: scope=global excludes site-scoped records",
  run() {
    const globalRec = makeLesson("d2-global-lesson", {
      title: "cookie modal issue",
      detail: { note: "cookie modal lesson" },
    });
    const siteRec = makeSiteBlocker("d2-site-blocker", "https://example.com", {
      title: "cookie modal blocks page",
    });

    const result = searchRecords([globalRec, siteRec], "cookie modal", {
      scope: "global",
    });

    check(result.matches.every((m) => m.scope === "global"), "all results should be global-scoped");
    check(result.matches.some((m) => m.name === globalRec.name), "global record should appear");
    check(!result.matches.some((m) => m.name === siteRec.name), "site record should be excluded");
  },
});

defineEval({
  id: "D3",
  capability: "search",
  title: "origin filter: only site records with matching origin are returned",
  run() {
    const origin1 = "https://www.notion.so";
    const origin2 = "https://www.github.com";

    const rec1 = makeSiteBlocker("d3-notion-blocker", origin1, {
      title: "notion cookie consent modal",
    });
    const rec2 = makeSiteBlocker("d3-github-blocker", origin2, {
      title: "github cookie consent modal",
    });
    const globalRec = makeLesson("d3-global-lesson", {
      title: "cookie consent modal global lesson",
      detail: { note: "cookie consent lesson" },
    });

    const result = searchRecords([rec1, rec2, globalRec], "cookie consent modal", {
      origin: origin1,
    });

    check(result.matches.some((m) => m.name === rec1.name), "notion record should appear");
    check(!result.matches.some((m) => m.name === rec2.name), "github record should be excluded");
    check(!result.matches.some((m) => m.name === globalRec.name), "global record should be excluded by origin filter");
  },
});

defineEval({
  id: "D4",
  capability: "search",
  title: "kind filter: only records with matching kind are returned",
  run() {
    const blockerRec = makeSiteBlocker("d4-site-blocker", "https://example.com", {
      title: "modal blocks interaction",
    });
    const lessonRec = makeLesson("d4-global-lesson", {
      title: "modal interaction lesson",
      detail: { note: "lesson about modal interaction" },
    });

    const result = searchRecords([blockerRec, lessonRec], "modal interaction", {
      kind: "blocker",
    });

    check(result.matches.every((m) => m.kind === "blocker"), "all results should be blockers");
    check(result.matches.some((m) => m.name === blockerRec.name), "blocker should appear");
    check(!result.matches.some((m) => m.name === lessonRec.name), "lesson should be excluded");
  },
});

defineEval({
  id: "D5",
  capability: "search",
  title: "recency decay: older last_hit lowers confidence score",
  run() {
    const now = new Date("2025-06-01T00:00:00.000Z");

    // recent: hit 1 day ago
    const recentFactor = recencyFactor("2025-05-31T00:00:00.000Z", now);

    // old: hit 90 days ago (3 half-lives)
    const oldFactor = recencyFactor("2025-03-03T00:00:00.000Z", now);

    check(recentFactor > oldFactor, `recent recency factor ${recentFactor} should be > old factor ${oldFactor}`);

    // After 1 half-life (~30 days), factor should be ~0.5
    const halfLifeDate = new Date(now.getTime() - RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000);
    const halfLifeFactor = recencyFactor(halfLifeDate.toISOString(), now);
    check(
      Math.abs(halfLifeFactor - 0.5) < 0.05,
      `factor at exactly one half-life should be ~0.5, got ${halfLifeFactor}`,
    );

    // No last_hit → neutral 0.5
    const noHitFactor = recencyFactor(undefined, now);
    checkEqual(noHitFactor, 0.5, "no last_hit should return 0.5");

    // Verify confidence with old stats is lower
    const freshRecord = makeLesson("d5-fresh", {
      severity: "high",
      stats: makeStats({
        hits: 5,
        resolved: 4,
        door_failures: 1,
        last_hit: "2025-05-31T00:00:00.000Z", // 1 day ago
      }),
    });
    const oldRecord = makeLesson("d5-old", {
      severity: "high",
      stats: makeStats({
        hits: 5,
        resolved: 4,
        door_failures: 1,
        last_hit: "2025-01-01T00:00:00.000Z", // ~150 days ago
      }),
    });

    const freshConf = confidence(freshRecord, now);
    const oldConf = confidence(oldRecord, now);
    check(freshConf > oldConf, `fresh confidence ${freshConf} should be > old confidence ${oldConf}`);
  },
});

defineEval({
  id: "D6",
  capability: "search",
  title: "doorUnreliable flips true when failure ratio exceeds threshold with enough observations",
  run() {
    // Below minimum observations — should not flip
    const fewObsStats: MemoryStats = makeStats({
      resolved: 0,
      door_failures: DOOR_FAILURE_MIN_OBSERVATIONS - 1,
    });
    check(
      !doorUnreliable(fewObsStats),
      `doorUnreliable should be false below DOOR_FAILURE_MIN_OBSERVATIONS (${DOOR_FAILURE_MIN_OBSERVATIONS})`,
    );

    // Enough observations but below ratio — should not flip
    const lowRatioStats: MemoryStats = makeStats({
      resolved: 5,
      door_failures: 1, // ratio = 1/6 ≈ 0.167 < DOOR_FAILURE_RATIO_THRESHOLD
    });
    check(!doorUnreliable(lowRatioStats), "doorUnreliable should be false when ratio is low");

    // At threshold — should flip
    // ratio = 0.6 → door_failures / (door_failures + resolved) = 0.6
    // e.g. door_failures=3, resolved=2 → ratio = 3/5 = 0.6
    const atThresholdStats: MemoryStats = makeStats({
      resolved: 2,
      door_failures: 3, // ratio = 3/5 = 0.6 = DOOR_FAILURE_RATIO_THRESHOLD
    });
    check(doorUnreliable(atThresholdStats), "doorUnreliable should be true at exactly the threshold");

    // Above threshold
    const highRatioStats: MemoryStats = makeStats({
      resolved: 1,
      door_failures: 5, // ratio = 5/6 ≈ 0.833 > threshold
    });
    check(doorUnreliable(highRatioStats), "doorUnreliable should be true above threshold");
  },
});

defineEval({
  id: "D7",
  capability: "search",
  title: "severity ordering: high-severity records rank above low-severity when no usage stats",
  run() {
    const highSeverity = makeLesson("d7-high-severity", {
      title: "consent modal blocks everything",
      detail: { note: "consent modal issue" },
      severity: "high",
    });
    const lowSeverity = makeLesson("d7-low-severity", {
      title: "consent modal blocks everything",
      detail: { note: "consent modal issue" },
      severity: "low",
    });

    const highConf = confidence(highSeverity);
    const lowConf = confidence(lowSeverity);
    check(highConf > lowConf, `high severity confidence ${highConf} should exceed low severity ${lowConf}`);

    // In search, higher confidence ranks first
    const result = searchRecordsWithConfidence(
      [lowSeverity, highSeverity], // low first
      "consent modal",
      {},
    );
    check(result.matches.length >= 2, "should have both results");
    checkEqual(result.matches[0].name, highSeverity.name, "high severity should rank first");
  },
});
