/**
 * Per-session action trace ring buffer (Phase 5.1).
 *
 * Records a bounded ring of recent tool call outcomes keyed by session_id.
 * Readable cross-session so the memory-scribe subagent (a different session)
 * can fetch the originating session's trace via memory_session_trace.
 *
 * Lifetime: daemon instance (instantiated once, like RateLimiter).
 */

export interface TraceEntry {
  /** MCP tool name (e.g. "browser_click", "procedures_execute"). */
  method: string;
  /** Hostname of the tab that was active during the call, if any. */
  origin?: string;
  /** Error code if the tool call failed. */
  error_code?: string;
  /**
   * Short summary of the page effect envelope (e.g. "dom+3 url→changed",
   * "no-op", "net:2"). "none" when there was no effect envelope.
   */
  effect_summary: string;
  /** ISO-8601 timestamp when the entry was recorded. */
  ts: string;
}

const RING_CAPACITY = 50;

export class TraceBuffer {
  private readonly rings = new Map<string, TraceEntry[]>();

  /**
   * Record a new entry for the given session, evicting the oldest when the
   * ring exceeds capacity.
   */
  record(session_id: string, entry: TraceEntry): void {
    let ring = this.rings.get(session_id);
    if (!ring) {
      ring = [];
      this.rings.set(session_id, ring);
    }
    ring.push(entry);
    if (ring.length > RING_CAPACITY) {
      ring.splice(0, ring.length - RING_CAPACITY);
    }
  }

  /**
   * Return the most recent `limit` entries for the given session (oldest first).
   * Returns an empty array for unknown sessions.
   */
  recent(session_id: string, limit: number = RING_CAPACITY): TraceEntry[] {
    const ring = this.rings.get(session_id);
    if (!ring || ring.length === 0) return [];
    const cap = Math.max(1, Math.min(limit, RING_CAPACITY));
    if (ring.length <= cap) return [...ring];
    return ring.slice(ring.length - cap);
  }

  /** Visible for testing: current ring size for a session. */
  size(session_id: string): number {
    return this.rings.get(session_id)?.length ?? 0;
  }
}
