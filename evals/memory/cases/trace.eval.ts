/**
 * Capability G — trace buffer: ring eviction, per-session isolation, recent() ordering.
 */
import { TraceBuffer, type TraceEntry } from "../../../packages/bridge/src/memory/trace.js";
import { check, checkEqual, defineEval } from "../harness.js";

function makeEntry(method: string, i: number, origin = "https://www.example.com"): TraceEntry {
  return {
    method,
    origin,
    effect_summary: `effect-${i}`,
    ts: new Date(1000000 + i * 1000).toISOString(),
  };
}

defineEval({
  id: "G1",
  capability: "trace",
  title: "ring eviction: oldest entries are evicted when capacity (50) is exceeded",
  run() {
    const buf = new TraceBuffer();
    const session = "g1-session";

    // Fill 55 entries (capacity is 50)
    for (let i = 0; i < 55; i++) {
      buf.record(session, makeEntry("browser_click", i));
    }

    // Buffer should have exactly 50 entries
    checkEqual(buf.size(session), 50, "ring should be capped at 50 entries");

    // Most recent should be the last 50 entries (indices 5-54)
    const recent = buf.recent(session);
    checkEqual(recent.length, 50, "recent() should return 50 entries");

    // The first entry in the ring should have effect-5 (evicted 0-4)
    checkEqual(recent[0].effect_summary, "effect-5", "oldest entry should be effect-5 after eviction");
    // The last entry should have effect-54
    checkEqual(recent[49].effect_summary, "effect-54", "newest entry should be effect-54");
  },
});

defineEval({
  id: "G2",
  capability: "trace",
  title: "per-session isolation: recording on session A does not affect session B",
  run() {
    const buf = new TraceBuffer();
    const sessionA = "g2-session-a";
    const sessionB = "g2-session-b";

    // Record 5 entries for session A
    for (let i = 0; i < 5; i++) {
      buf.record(sessionA, makeEntry("browser_read", i));
    }

    // Session B should be empty
    checkEqual(buf.size(sessionB), 0, "session B should have no entries");
    const recentB = buf.recent(sessionB);
    checkEqual(recentB.length, 0, "session B recent() should be empty array");

    // Session A should have 5 entries
    checkEqual(buf.size(sessionA), 5, "session A should have 5 entries");
  },
});

defineEval({
  id: "G3",
  capability: "trace",
  title: "recent() returns entries oldest-first up to requested limit",
  run() {
    const buf = new TraceBuffer();
    const session = "g3-session";

    // Record 10 entries
    for (let i = 0; i < 10; i++) {
      buf.record(session, makeEntry("browser_navigate", i));
    }

    // Request last 5
    const recent5 = buf.recent(session, 5);
    checkEqual(recent5.length, 5, "should return 5 entries");
    // Should be entries 5-9 (oldest first)
    checkEqual(recent5[0].effect_summary, "effect-5", "first of recent-5 should be effect-5");
    checkEqual(recent5[4].effect_summary, "effect-9", "last of recent-5 should be effect-9");

    // Request all (default)
    const recentAll = buf.recent(session);
    checkEqual(recentAll.length, 10, "recent() with no limit should return all 10");
    checkEqual(recentAll[0].effect_summary, "effect-0", "oldest should come first");
    checkEqual(recentAll[9].effect_summary, "effect-9", "newest should come last");
  },
});

defineEval({
  id: "G4",
  capability: "trace",
  title: "cross-session read: a different session ID can read another session's trace",
  run() {
    const buf = new TraceBuffer();
    const writerSession = "g4-writer";
    const readerSession = "g4-reader";

    // Write to writerSession
    buf.record(writerSession, makeEntry("browser_type", 1));
    buf.record(writerSession, makeEntry("browser_click", 2));

    // Read writerSession from a different caller reference (simulating cross-session read)
    // In the real system the scribe subagent calls this with the originating session ID
    const entries = buf.recent(writerSession);
    checkEqual(entries.length, 2, "should read 2 entries from writer session");
    checkEqual(entries[0].method, "browser_type", "first entry should be browser_type");
    checkEqual(entries[1].method, "browser_click", "second entry should be browser_click");

    // readerSession itself should be empty
    checkEqual(buf.size(readerSession), 0, "reader session should have no entries");
  },
});

defineEval({
  id: "G5",
  capability: "trace",
  title: "unknown session returns empty array from recent()",
  run() {
    const buf = new TraceBuffer();
    const unknown = "g5-never-recorded";

    const result = buf.recent(unknown);
    checkEqual(result.length, 0, "unknown session should return empty array");
    checkEqual(buf.size(unknown), 0, "unknown session size should be 0");
  },
});
