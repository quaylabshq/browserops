/**
 * Phase 6 — Hybrid delivery: SiteContextManager + primer formatter.
 *
 * SiteContextManager tracks per-(session, origin) delivery state:
 *   UNPRIMED  — records loaded but not yet injected into any response
 *   PRIMED    — terse primer injected for this session+origin
 *   RE-NUDGED — a blocker's door was re-delivered after a roadblock event
 *
 * It also caches the loaded MemoryRecord[] for each origin so the delivery
 * path in mcp-server.ts can call formatPrimer() without a disk hit.
 *
 * Daemon-lifetime instance — one per daemon process, shared across sessions.
 */

import { confidence } from "./confidence.js";
import type { MemoryRecord } from "@browserops/shared";

// ---------------------------------------------------------------------------
// State enum
// ---------------------------------------------------------------------------

export type DeliveryState = "UNPRIMED" | "PRIMED" | "RE-NUDGED";

// ---------------------------------------------------------------------------
// Primer payload shape (attached as site_context in tool responses)
// ---------------------------------------------------------------------------

/**
 * Terse per-site primer: a title-only, confidence-ranked index (≤5 entries).
 *
 * Full detail is NOT inlined here — the agent calls memory_get to pull it.
 * This keeps the injection small (~5 lines of text) while signalling that
 * relevant memory exists.
 */
export interface SitePrimer {
  origin: string;
  records: Array<{
    name: string;
    kind: string;
    title: string;
    confidence: number;
  }>;
  hint: string;
}

/** Maximum records shown in the terse primer index. */
const PRIMER_MAX = 5;

// ---------------------------------------------------------------------------
// SiteContextManager
// ---------------------------------------------------------------------------

export class SiteContextManager {
  /** (session_id + "::" + origin) → DeliveryState */
  private readonly state = new Map<string, DeliveryState>();
  /** origin → MemoryRecord[] (warmed cache, updated on navigation) */
  private readonly cache = new Map<string, MemoryRecord[]>();

  // ---------------------------------------------------------------------------
  // Cache warm-up
  // ---------------------------------------------------------------------------

  /**
   * Pre-load records for an origin (called on page_navigated).
   * Replaces any stale cache for the origin — navigation may reveal new pages
   * but the store itself hasn't changed; we just ensure the cache is fresh.
   */
  warm(origin: string, records: MemoryRecord[]): void {
    this.cache.set(origin, records);
  }

  /**
   * Return the warmed records for an origin, or an empty array if not yet loaded.
   */
  recordsFor(origin: string): MemoryRecord[] {
    return this.cache.get(origin) ?? [];
  }

  // ---------------------------------------------------------------------------
  // State key
  // ---------------------------------------------------------------------------

  private key(session_id: string, origin: string): string {
    return `${session_id}::${origin}`;
  }

  // ---------------------------------------------------------------------------
  // shouldPrime — first-call primer resolution
  // ---------------------------------------------------------------------------

  /**
   * Check whether the given session+origin pair should receive a primer.
   *
   * Returns a SitePrimer payload on the FIRST call for an UNPRIMED pair
   * (and transitions to PRIMED).  Returns null on all subsequent calls
   * (PRIMED or RE-NUDGED already) — suppressing repeated injection.
   *
   * Also returns null when there are no warmed records for the origin.
   */
  shouldPrime(session_id: string, origin: string): SitePrimer | null {
    const k = this.key(session_id, origin);
    const st = this.state.get(k) ?? "UNPRIMED";
    if (st !== "UNPRIMED") return null;

    const records = this.recordsFor(origin);
    if (records.length === 0) return null;

    // Transition to PRIMED
    this.state.set(k, "PRIMED");
    return formatPrimer(origin, records);
  }

  // ---------------------------------------------------------------------------
  // reNudge — re-deliver a blocker door after a roadblock
  // ---------------------------------------------------------------------------

  /**
   * Re-nudge: called when a capture_hint roadblock fired AND the origin has a
   * matching blocker record with a door.  Transitions state to RE-NUDGED and
   * returns the full door text (the workaround) so the MCP response can carry
   * it in site_context.blocker_door.
   *
   * Returns null when:
   *   - No warmed blocker records exist for the origin.
   *   - No blocker record has a door that matches (or no door at all).
   */
  reNudge(session_id: string, origin: string, blocker: string): ReNudgeResult | null {
    const records = this.recordsFor(origin);
    const blockerRecords = records.filter(
      (r) => r.kind === "blocker" && r.detail.door,
    );
    if (blockerRecords.length === 0) return null;

    // Pick the best matching blocker by confidence, then by whether blocker
    // string appears in title/detail.
    const sorted = blockerRecords
      .map((r) => ({ r, conf: confidence(r) }))
      .sort((a, b) => b.conf - a.conf);

    // Prefer one whose wall/door mentions the blocker hint
    const lower = blocker.toLowerCase();
    const matched =
      sorted.find(({ r }) =>
        r.detail.wall?.toLowerCase().includes(lower) ||
        r.detail.door?.toLowerCase().includes(lower) ||
        r.title.toLowerCase().includes(lower),
      ) ?? sorted[0];

    if (!matched) return null;

    const k = this.key(session_id, origin);
    this.state.set(k, "RE-NUDGED");

    return {
      name: matched.r.name,
      title: matched.r.title,
      door: matched.r.detail.door!,
      confidence: matched.conf,
    };
  }

  // ---------------------------------------------------------------------------
  // Introspection (for tests and self-heal)
  // ---------------------------------------------------------------------------

  /** Return the current delivery state for a session+origin pair. */
  getState(session_id: string, origin: string): DeliveryState {
    return this.state.get(this.key(session_id, origin)) ?? "UNPRIMED";
  }

  /** True when the pair is PRIMED or RE-NUDGED (primer was delivered). */
  wasPrimed(session_id: string, origin: string): boolean {
    const st = this.getState(session_id, origin);
    return st === "PRIMED" || st === "RE-NUDGED";
  }
}

// ---------------------------------------------------------------------------
// ReNudgeResult
// ---------------------------------------------------------------------------

export interface ReNudgeResult {
  name: string;
  title: string;
  door: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Primer formatter (pure function — unit-testable)
// ---------------------------------------------------------------------------

/**
 * Format a terse, confidence-ranked title-only index of at most PRIMER_MAX
 * records for the given origin.
 *
 * Deliberately minimal — one line per record so the agent sees the signal
 * without context-bloat.  Full detail is retrieved via memory_get.
 */
export function formatPrimer(origin: string, records: MemoryRecord[]): SitePrimer {
  const ranked = records
    .map((r) => ({ r, conf: confidence(r) }))
    .sort((a, b) => b.conf - a.conf)
    .slice(0, PRIMER_MAX);

  return {
    origin,
    records: ranked.map(({ r, conf }) => ({
      name: r.name,
      kind: r.kind,
      title: r.title,
      confidence: Math.round(conf * 100) / 100,
    })),
    hint: "Memory exists for this site. Call memory_get(name) to read full detail.",
  };
}
