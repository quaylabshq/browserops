/**
 * Tests for TraceBuffer (Phase 5.1) and detectRoadblock (Phase 5.4).
 * Covers ring eviction, per-session isolation, cross-session read by tab_id,
 * and capture signal detection thresholds.
 */
import { describe, expect, it } from "vitest";
import { TraceBuffer, type TraceEntry } from "./trace.js";
import { detectRoadblock } from "./capture-signals.js";
import { buildMemorySessionTraceHandler } from "./handlers.js";
import { TabRegistry } from "../tab-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  method: string,
  overrides: Partial<TraceEntry> = {},
): TraceEntry {
  return {
    method,
    effect_summary: "no-op",
    ts: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TraceBuffer — ring eviction
// ---------------------------------------------------------------------------

describe("TraceBuffer — ring eviction", () => {
  it("stores up to 50 entries per session", () => {
    const buf = new TraceBuffer();
    for (let i = 0; i < 50; i++) {
      buf.record("s_1", makeEntry(`browser_click_${i}`));
    }
    expect(buf.size("s_1")).toBe(50);
  });

  it("evicts oldest entries when capacity is exceeded", () => {
    const buf = new TraceBuffer();
    for (let i = 0; i < 55; i++) {
      buf.record("s_1", makeEntry(`browser_click`, { ts: `2024-01-01T00:00:${String(i).padStart(2, "0")}.000Z` }));
    }
    // Should still be 50
    expect(buf.size("s_1")).toBe(50);

    // recent(50) should return the latest 50
    const entries = buf.recent("s_1", 50);
    expect(entries).toHaveLength(50);

    // The first 5 (indices 0–4) should be evicted
    // Entry at position 0 should have ts for i=5
    expect(entries[0]!.ts).toBe("2024-01-01T00:00:05.000Z");
    expect(entries[49]!.ts).toBe("2024-01-01T00:00:54.000Z");
  });

  it("recent() with limit < ring size returns only latest", () => {
    const buf = new TraceBuffer();
    for (let i = 0; i < 20; i++) {
      buf.record("s_1", makeEntry("browser_read", { ts: `2024-01-01T00:00:${String(i).padStart(2, "0")}.000Z` }));
    }
    const entries = buf.recent("s_1", 5);
    expect(entries).toHaveLength(5);
    expect(entries[0]!.ts).toBe("2024-01-01T00:00:15.000Z");
    expect(entries[4]!.ts).toBe("2024-01-01T00:00:19.000Z");
  });

  it("recent() returns empty array for unknown session", () => {
    const buf = new TraceBuffer();
    expect(buf.recent("s_unknown", 10)).toEqual([]);
  });

  it("recent() clamps limit to 1 minimum", () => {
    const buf = new TraceBuffer();
    buf.record("s_1", makeEntry("browser_navigate"));
    buf.record("s_1", makeEntry("browser_click"));
    const entries = buf.recent("s_1", 0);
    expect(entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TraceBuffer — per-session isolation
// ---------------------------------------------------------------------------

describe("TraceBuffer — per-session isolation", () => {
  it("sessions do not share rings", () => {
    const buf = new TraceBuffer();
    buf.record("s_a", makeEntry("browser_click"));
    buf.record("s_b", makeEntry("browser_navigate"));
    buf.record("s_b", makeEntry("browser_type"));

    expect(buf.size("s_a")).toBe(1);
    expect(buf.size("s_b")).toBe(2);

    const a = buf.recent("s_a");
    const b = buf.recent("s_b");
    expect(a[0]!.method).toBe("browser_click");
    expect(b[0]!.method).toBe("browser_navigate");
    expect(b[1]!.method).toBe("browser_type");
  });
});

// ---------------------------------------------------------------------------
// Cross-session read by tab_id via buildMemorySessionTraceHandler
// ---------------------------------------------------------------------------

describe("memory_session_trace — cross-session read by tab_id", () => {
  it("resolves tab_id to owning session and returns its entries", async () => {
    const buf = new TraceBuffer();
    buf.record("s_main", makeEntry("browser_click", { origin: "example.com" }));
    buf.record("s_main", makeEntry("browser_type", { origin: "example.com" }));

    // Mint a tab owned by s_main
    const tabs = new TabRegistry();
    const rec = tabs.mint(1001, { url: "https://example.com", active: true, window_id: 1, title: "Example" });
    tabs.claim(rec.tab_id, "s_main");

    const handler = buildMemorySessionTraceHandler(buf, tabs);
    const result = await handler({ tab_id: rec.tab_id });

    expect(result.entries).toHaveLength(2);
    expect(result.session_id).toBe("s_main");
    expect(result.entries[0]!.method).toBe("browser_click");
    expect(result.entries[1]!.method).toBe("browser_type");
  });

  it("returns empty entries for a tab with no owning session", async () => {
    const buf = new TraceBuffer();
    const tabs = new TabRegistry();
    const rec = tabs.mint(2001, { url: "https://example.com", active: true, window_id: 1 });
    // Tab NOT claimed — owner_session_id is null

    const handler = buildMemorySessionTraceHandler(buf, tabs);
    const result = await handler({ tab_id: rec.tab_id });

    expect(result.entries).toEqual([]);
  });

  it("prefers explicit session_id over tab_id lookup", async () => {
    const buf = new TraceBuffer();
    buf.record("s_alpha", makeEntry("browser_navigate"));
    buf.record("s_beta", makeEntry("browser_click"));

    const tabs = new TabRegistry();
    const rec = tabs.mint(3001, { url: "https://example.com", active: true, window_id: 1 });
    tabs.claim(rec.tab_id, "s_beta");

    const handler = buildMemorySessionTraceHandler(buf, tabs);
    // Explicitly pass s_alpha — should ignore the tab_id → s_beta mapping
    const result = await handler({ session_id: "s_alpha", tab_id: rec.tab_id });

    expect(result.session_id).toBe("s_alpha");
    expect(result.entries[0]!.method).toBe("browser_navigate");
  });

  it("respects limit parameter", async () => {
    const buf = new TraceBuffer();
    for (let i = 0; i < 20; i++) {
      buf.record("s_1", makeEntry("browser_read"));
    }
    const handler = buildMemorySessionTraceHandler(buf, undefined);
    const result = await handler({ session_id: "s_1", limit: 5 });
    expect(result.entries).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// detectRoadblock — signal thresholds
// ---------------------------------------------------------------------------

describe("detectRoadblock", () => {
  it("returns null for a normal successful read", () => {
    const hint = detectRoadblock([], {
      method: "browser_read",
      origin: "example.com",
      effect_summary: "no-op",
    });
    expect(hint).toBeNull();
  });

  it("fires on WRITE_NOT_REFLECTED error code", () => {
    const hint = detectRoadblock([], {
      method: "browser_type",
      origin: "slack.com",
      error_code: "WRITE_NOT_REFLECTED",
      effect_summary: "none",
    });
    expect(hint).not.toBeNull();
    expect(hint!.reason).toBe("roadblock");
    expect(hint!.signals).toContain("error:WRITE_NOT_REFLECTED");
    expect(hint!.origin).toBe("slack.com");
  });

  it("fires on USER_DECLINED error code", () => {
    const hint = detectRoadblock([], {
      method: "browser_execute_js",
      error_code: "USER_DECLINED",
      effect_summary: "none",
    });
    expect(hint).not.toBeNull();
    expect(hint!.signals).toContain("error:USER_DECLINED");
  });

  it("fires on ELEMENT_NOT_ACTIONABLE", () => {
    const hint = detectRoadblock([], {
      method: "browser_click",
      error_code: "ELEMENT_NOT_ACTIONABLE",
      effect_summary: "none",
    });
    expect(hint).not.toBeNull();
    expect(hint!.signals).toContain("error:ELEMENT_NOT_ACTIONABLE");
  });

  it("fires on no-op after an action method (browser_click)", () => {
    const hint = detectRoadblock([], {
      method: "browser_click",
      origin: "notion.so",
      effect_summary: "no-op",
    });
    expect(hint).not.toBeNull();
    expect(hint!.signals).toContain("no-op-after-action");
  });

  it("does NOT fire on no-op for a read method", () => {
    const hint = detectRoadblock([], {
      method: "browser_read",
      origin: "example.com",
      effect_summary: "no-op",
    });
    expect(hint).toBeNull();
  });

  it("does NOT fire on no-op for browser_screenshot", () => {
    const hint = detectRoadblock([], {
      method: "browser_screenshot",
      effect_summary: "no-op",
    });
    expect(hint).toBeNull();
  });

  it("fires on timeout cluster (≥2 TIMEOUT errors in window)", () => {
    const trace: TraceEntry[] = [
      makeEntry("browser_wait_for", { error_code: "TIMEOUT", origin: "app.com" }),
      makeEntry("browser_wait_for", { error_code: "TIMEOUT", origin: "app.com" }),
    ];
    const hint = detectRoadblock(trace, {
      method: "browser_read",
      origin: "app.com",
      effect_summary: "no-op",
    });
    expect(hint).not.toBeNull();
    expect(hint!.signals.some((s) => s.startsWith("timeout-cluster"))).toBe(true);
  });

  it("does NOT fire on a single TIMEOUT in the window", () => {
    const trace: TraceEntry[] = [
      makeEntry("browser_wait_for", { error_code: "TIMEOUT", origin: "app.com" }),
    ];
    const hint = detectRoadblock(trace, {
      method: "browser_read",
      origin: "app.com",
      effect_summary: "no-op",
    });
    expect(hint).toBeNull();
  });

  it("fires on repeated retries: same (origin, method) ≥3 times", () => {
    const trace: TraceEntry[] = [
      makeEntry("browser_click", { origin: "gmail.com" }),
      makeEntry("browser_click", { origin: "gmail.com" }),
    ];
    // Current call is 3rd occurrence
    const hint = detectRoadblock(trace, {
      method: "browser_click",
      origin: "gmail.com",
      effect_summary: "no-op",
    });
    expect(hint).not.toBeNull();
    expect(hint!.signals.some((s) => s.startsWith("repeated:"))).toBe(true);
  });

  it("does NOT fire on repeated retries when count is < 3", () => {
    const trace: TraceEntry[] = [
      makeEntry("browser_click", { origin: "gmail.com" }),
    ];
    // Current call is 2nd occurrence — below threshold
    const hint = detectRoadblock(trace, {
      method: "browser_click",
      origin: "gmail.com",
      effect_summary: "dom+2",
    });
    expect(hint).toBeNull();
  });

  it("fires on prior WRITE_NOT_REFLECTED errors at same origin", () => {
    const trace: TraceEntry[] = [
      makeEntry("browser_type", { origin: "discord.com", error_code: "WRITE_NOT_REFLECTED" }),
    ];
    const hint = detectRoadblock(trace, {
      method: "browser_navigate",
      origin: "discord.com",
      effect_summary: "url→changed",
    });
    expect(hint).not.toBeNull();
    expect(hint!.signals).toContain("prior-error:WRITE_NOT_REFLECTED");
  });

  it("does NOT fire prior-error signals for different origins", () => {
    const trace: TraceEntry[] = [
      makeEntry("browser_type", { origin: "other-site.com", error_code: "WRITE_NOT_REFLECTED" }),
    ];
    const hint = detectRoadblock(trace, {
      method: "browser_click",
      origin: "discord.com",
      effect_summary: "no-op",
    });
    // discord.com has no-op after action — would fire that, but
    // prior-error should NOT be in signals (wrong origin).
    if (hint) {
      expect(hint.signals).not.toContain("prior-error:WRITE_NOT_REFLECTED");
    }
  });

  it("considers only the last 10 entries in the cluster window for timeouts", () => {
    // Build 11 entries — first has TIMEOUT but should be outside the 10-entry window.
    // Use distinct methods so repeated-retries rule doesn't co-fire.
    const trace: TraceEntry[] = [
      // Entry 0: old TIMEOUT — should be outside the cluster window of 10
      makeEntry("browser_navigate", { error_code: "TIMEOUT", origin: "app.com" }),
      // Entries 1–10: 10 more entries with no errors, different methods
      ...Array.from({ length: 10 }, () =>
        makeEntry("browser_screenshot", { origin: "app.com" }),
      ),
    ];
    // Current call has no error, method different from the window entries
    const hint = detectRoadblock(trace, {
      method: "browser_observe",
      origin: "app.com",
      effect_summary: "dom+1",
    });
    // The single TIMEOUT at index 0 is outside the 10-entry window → no cluster
    expect(hint).toBeNull();
  });
});
