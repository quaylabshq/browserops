/**
 * Capability E — hybrid delivery state machine:
 * prime-once → suppress, primer format, reNudge returns door, per-session isolation.
 *
 * Note on global digest: the plan mentions "global digest ≤10 ranked lines".
 * Inspecting delivery.ts, there is no separate `formatGlobalDigest` export —
 * the global digest concept is handled by the SiteContextManager.shouldPrime +
 * formatPrimer pattern (which is the primer for the special "global" origin).
 * We verify digest-relevant ordering via formatPrimer directly, which IS exported
 * and is the canonical formatter for both site and global contexts.
 */
import type { MemoryRecord } from "@browserops/shared";
import {
  SiteContextManager,
  formatPrimer,
} from "../../../packages/bridge/src/memory/delivery.js";
import { check, checkEqual, defineEval } from "../harness.js";

function makeBlocker(name: string, origin: string, overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    schema_version: 1,
    name,
    scope: "site",
    kind: "blocker",
    title: "cookie consent modal blocks all interaction",
    origin,
    detail: {
      wall: "modal blocks all clicks until dismissed",
      door: "click the accept button to dismiss the modal",
    },
    severity: "high",
    stats: {
      hits: 5,
      resolved: 4,
      door_failures: 1,
      captures: 1,
    },
    ...overrides,
  };
}

function makeLesson(name: string, overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    schema_version: 1,
    name,
    scope: "global",
    kind: "lesson",
    title: "A general lesson about modals",
    detail: { note: "modals should be dismissed before interacting" },
    severity: "med",
    ...overrides,
  };
}

defineEval({
  id: "E1",
  capability: "delivery",
  title: "prime-once → suppress: shouldPrime returns primer first call, null on second",
  run() {
    const mgr = new SiteContextManager();
    const session = "session-e1";
    const origin = "https://www.example.com";

    // Warm with records
    const blocker = makeBlocker("e1-blocker", origin);
    mgr.warm(origin, [blocker]);

    // First call: should prime
    const primer1 = mgr.shouldPrime(session, origin);
    check(primer1 !== null, "first shouldPrime should return a primer");
    checkEqual(primer1!.origin, origin, "primer origin should match");
    check(primer1!.records.length > 0, "primer should have records");

    // State should be PRIMED
    checkEqual(mgr.getState(session, origin), "PRIMED", "state should be PRIMED after first prime");

    // Second call: should suppress (return null)
    const primer2 = mgr.shouldPrime(session, origin);
    check(primer2 === null, "second shouldPrime should return null (suppressed)");
  },
});

defineEval({
  id: "E2",
  capability: "delivery",
  title: "primer contains ≤5 records, confidence-ranked, titles only (no door inlined)",
  run() {
    const origin = "https://www.example.com";

    // Create 8 blocker records with varying confidences
    const records: MemoryRecord[] = Array.from({ length: 8 }, (_, i) => ({
      schema_version: 1 as const,
      name: `e2-blocker-${i + 1}`,
      scope: "site" as const,
      kind: "blocker" as const,
      title: `Blocker record ${i + 1}`,
      origin,
      detail: {
        wall: "modal blocks interaction",
        door: `SECRET_DOOR_TEXT_${i + 1} — this should not appear in primer`,
      },
      severity: (["high", "med", "low"][i % 3] ?? "med") as "high" | "med" | "low",
      stats: {
        hits: i + 1,
        resolved: i,
        door_failures: 1,
        captures: 1,
        last_hit: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
      },
    }));

    const primer = formatPrimer(origin, records);

    // Should cap at 5
    check(primer.records.length <= 5, `primer should have ≤5 records, got ${primer.records.length}`);

    // Should not inline door text
    const primerStr = JSON.stringify(primer);
    check(!primerStr.includes("SECRET_DOOR_TEXT"), "primer should not contain door text");

    // Should have name, kind, title, confidence per entry
    for (const entry of primer.records) {
      check(typeof entry.name === "string", "entry should have name");
      check(typeof entry.kind === "string", "entry should have kind");
      check(typeof entry.title === "string", "entry should have title");
      check(typeof entry.confidence === "number", "entry should have confidence");
      check(entry.confidence >= 0 && entry.confidence <= 1, "confidence should be in [0,1]");
    }

    // Should be confidence-ranked (descending)
    for (let i = 1; i < primer.records.length; i++) {
      check(
        primer.records[i - 1]!.confidence >= primer.records[i]!.confidence,
        `record ${i - 1} confidence ${primer.records[i - 1]!.confidence} should be >= record ${i} confidence ${primer.records[i]!.confidence}`,
      );
    }

    // Hint should be present
    check(primer.hint.length > 0, "primer should have a non-empty hint");
  },
});

defineEval({
  id: "E3",
  capability: "delivery",
  title: "reNudge returns the door text when state is PRIMED",
  run() {
    const mgr = new SiteContextManager();
    const session = "session-e3";
    const origin = "https://www.example.com";
    const doorText = "click the dismiss button to close the consent modal";

    const blocker: MemoryRecord = {
      schema_version: 1,
      name: "e3-consent-blocker",
      scope: "site",
      kind: "blocker",
      title: "consent modal blocks page interaction",
      origin,
      detail: {
        wall: "all clicks are intercepted by the consent overlay",
        door: doorText,
      },
      severity: "high",
    };

    mgr.warm(origin, [blocker]);

    // Prime first
    mgr.shouldPrime(session, origin);
    checkEqual(mgr.getState(session, origin), "PRIMED", "should be PRIMED");

    // Trigger reNudge — simulate a roadblock event
    const result = mgr.reNudge(session, origin, "consent modal");
    check(result !== null, "reNudge should return a result when a matching blocker exists");
    checkEqual(result!.door, doorText, "reNudge should return the door text");
    check(result!.name === blocker.name, "reNudge result should have the blocker name");

    // State should transition to RE-NUDGED
    checkEqual(mgr.getState(session, origin), "RE-NUDGED", "state should be RE-NUDGED after reNudge");
  },
});

defineEval({
  id: "E4",
  capability: "delivery",
  title: "per-session isolation: different sessions get independent primers",
  run() {
    const mgr = new SiteContextManager();
    const origin = "https://www.example.com";
    const session1 = "session-e4-a";
    const session2 = "session-e4-b";

    const blocker = makeBlocker("e4-blocker", origin);
    mgr.warm(origin, [blocker]);

    // Session 1 primes
    const primer1 = mgr.shouldPrime(session1, origin);
    check(primer1 !== null, "session1 should get a primer");
    checkEqual(mgr.getState(session1, origin), "PRIMED", "session1 should be PRIMED");

    // Session 2 is independent — should also get a primer
    const primer2 = mgr.shouldPrime(session2, origin);
    check(primer2 !== null, "session2 should also get a primer (independent)");
    checkEqual(mgr.getState(session2, origin), "PRIMED", "session2 should be PRIMED");

    // Session 1 should now suppress on second call
    const primer1again = mgr.shouldPrime(session1, origin);
    check(primer1again === null, "session1 second call should be suppressed");

    // Session 2 should suppress too now
    const primer2again = mgr.shouldPrime(session2, origin);
    check(primer2again === null, "session2 second call should be suppressed");
  },
});

defineEval({
  id: "E5",
  capability: "delivery",
  title: "shouldPrime returns null when no warmed records exist for origin",
  run() {
    const mgr = new SiteContextManager();
    const session = "session-e5";
    const origin = "https://www.unwarmed.com";

    // Do NOT warm the origin
    const result = mgr.shouldPrime(session, origin);
    check(result === null, "shouldPrime should return null when origin has no warmed records");

    // State should remain UNPRIMED
    checkEqual(mgr.getState(session, origin), "UNPRIMED", "state should stay UNPRIMED");
  },
});

defineEval({
  id: "E6",
  capability: "delivery",
  title: "formatPrimer respects confidence ordering across records with different severities",
  run() {
    // Test the global digest ordering: records of different severities ranked by confidence
    // This covers the 'global digest' requirement from the plan (via the formatter)
    const origin = "https://www.example.com";

    const highSeverityNew = makeLesson("e6-high-lesson", {
      scope: "site",
      kind: "blocker",
      origin,
      title: "High severity recent blocker",
      detail: { wall: "modal blocks everything", door: "click accept" },
      severity: "high",
      stats: {
        hits: 10,
        resolved: 9,
        door_failures: 1,
        captures: 2,
        last_hit: new Date().toISOString(),
      },
    });
    const lowSeverityOld = makeLesson("e6-low-lesson", {
      scope: "site",
      kind: "blocker",
      origin,
      title: "Low severity old blocker",
      detail: { wall: "minor issue", door: "minor fix" },
      severity: "low",
      stats: {
        hits: 1,
        resolved: 0,
        door_failures: 5,
        captures: 1,
        last_hit: "2020-01-01T00:00:00.000Z",
      },
    });

    const primer = formatPrimer(origin, [lowSeverityOld, highSeverityNew]); // low first in input

    check(primer.records.length >= 2, "should have both records");
    checkEqual(
      primer.records[0].name,
      highSeverityNew.name,
      "high-severity recent record should rank first in primer",
    );
  },
});
