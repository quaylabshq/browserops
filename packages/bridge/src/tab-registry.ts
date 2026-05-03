export interface TabRecord {
  tab_id: string;
  chrome_tab_id: number;
  url: string;
  title?: string;
  active: boolean;
  window_id: number;
  /**
   * Session that has claimed this tab, or null when it's user-owned and
   * still claimable by anyone. Other sessions cannot see or address a
   * tab once it's claimed: lookups by tab_id return undefined for them
   * (TAB_NOT_FOUND), and list views filter to own + user-owned only.
   */
  owner_session_id: string | null;
}

export type ClaimResult =
  | { ok: true; status: "claimed" | "already_yours"; record: TabRecord }
  | { ok: false; status: "owned_by_other"; owner_session_id: string }
  | { ok: false; status: "unknown" };

/**
 * Mints opaque tab ids (t_<base36-monotonic>), tracks tab metadata
 * from extension events, and enforces per-session ownership.
 *
 * Ownership rules (matches the multi-session design):
 *   • A tab is *user-owned* (owner_session_id === null) when it was
 *     opened outside any session — typically a Chrome tab the user
 *     created themselves.
 *   • The first mutating call from session S on a user-owned tab
 *     atomically transfers ownership to S via {@link claim}. From
 *     then on, only S can resolve that tab_id.
 *   • A session releases its tabs via {@link release} (explicit
 *     browser_release_tab) or {@link releaseAll} (session disconnect),
 *     which orphans them back to user-owned. Session-disconnect
 *     deliberately does *not* close the tabs — the user can keep
 *     working with what an agent left behind.
 */
export class TabRegistry {
  private seq = 0;
  private readonly byTabId = new Map<string, TabRecord>();
  private readonly byChromeId = new Map<number, string>();

  mint(chromeTabId: number, partial: Omit<TabRecord, "tab_id" | "chrome_tab_id" | "owner_session_id">): TabRecord {
    const existing = this.byChromeId.get(chromeTabId);
    if (existing) {
      const rec = this.byTabId.get(existing);
      if (rec) return rec;
    }
    this.seq += 1;
    const tab_id = `t_${this.seq.toString(36)}`;
    const rec: TabRecord = {
      tab_id,
      chrome_tab_id: chromeTabId,
      ...partial,
      owner_session_id: null,
    };
    this.byTabId.set(tab_id, rec);
    this.byChromeId.set(chromeTabId, tab_id);
    return rec;
  }

  /**
   * Inserts a record with a pre-allocated tab_id (no sequence bump). Used by
   * secondary processes to mirror the primary's authoritative id.
   */
  inject(
    chromeTabId: number,
    tabId: string,
    partial: Omit<TabRecord, "tab_id" | "chrome_tab_id" | "owner_session_id">,
  ): TabRecord {
    const existing = this.byTabId.get(tabId);
    if (existing) return existing;
    const rec: TabRecord = {
      tab_id: tabId,
      chrome_tab_id: chromeTabId,
      ...partial,
      owner_session_id: null,
    };
    this.byTabId.set(tabId, rec);
    this.byChromeId.set(chromeTabId, tabId);
    return rec;
  }

  update(tab_id: string, patch: Partial<TabRecord>): TabRecord | undefined {
    const rec = this.byTabId.get(tab_id);
    if (!rec) return undefined;
    Object.assign(rec, patch);
    return rec;
  }

  remove(tab_id: string): void {
    const rec = this.byTabId.get(tab_id);
    if (rec) this.byChromeId.delete(rec.chrome_tab_id);
    this.byTabId.delete(tab_id);
  }

  /** Raw lookup ignoring ownership. Use sparingly — daemon internals only. */
  get(tab_id: string): TabRecord | undefined {
    return this.byTabId.get(tab_id);
  }

  /** Raw lookup by chrome_tab_id ignoring ownership. Daemon internals only. */
  getByChromeId(chromeTabId: number): TabRecord | undefined {
    const tab_id = this.byChromeId.get(chromeTabId);
    return tab_id ? this.byTabId.get(tab_id) : undefined;
  }

  /**
   * Visibility-respecting lookup. Returns undefined if the tab is owned
   * by another session — same observable behaviour as a missing tab,
   * which is what we want: callers can map to TAB_NOT_FOUND uniformly.
   */
  getVisibleTo(tab_id: string, session_id: string): TabRecord | undefined {
    const rec = this.byTabId.get(tab_id);
    if (!rec) return undefined;
    if (rec.owner_session_id === null) return rec;
    return rec.owner_session_id === session_id ? rec : undefined;
  }

  /**
   * All tabs visible to a session: own claimed tabs plus every
   * user-owned (unclaimed) tab. Other sessions' tabs are filtered out.
   */
  listVisibleTo(session_id: string): TabRecord[] {
    const out: TabRecord[] = [];
    for (const rec of this.byTabId.values()) {
      if (rec.owner_session_id === null || rec.owner_session_id === session_id) {
        out.push(rec);
      }
    }
    return out;
  }

  /** All tabs currently owned by a given session. */
  listOwnedBy(session_id: string): TabRecord[] {
    const out: TabRecord[] = [];
    for (const rec of this.byTabId.values()) {
      if (rec.owner_session_id === session_id) out.push(rec);
    }
    return out;
  }

  /**
   * Atomically transfer ownership.
   *
   *  - already_yours: caller already owns the tab. No-op.
   *  - claimed:       tab was user-owned; ownership now belongs to
   *                   session_id.
   *  - owned_by_other: tab is owned by a different session — caller
   *                   should map to TAB_NOT_FOUND (other session's
   *                   tabs are invisible) or surface
   *                   TAB_CLAIMED_BY_OTHER if they were specifically
   *                   trying to claim a known-shared tab.
   *  - unknown:       tab_id doesn't exist.
   */
  claim(tab_id: string, session_id: string): ClaimResult {
    const rec = this.byTabId.get(tab_id);
    if (!rec) return { ok: false, status: "unknown" };
    if (rec.owner_session_id === session_id) {
      return { ok: true, status: "already_yours", record: rec };
    }
    if (rec.owner_session_id !== null) {
      return { ok: false, status: "owned_by_other", owner_session_id: rec.owner_session_id };
    }
    rec.owner_session_id = session_id;
    return { ok: true, status: "claimed", record: rec };
  }

  /**
   * Release a tab back to user-owned. Idempotent on missing tabs and
   * on tabs the session doesn't own (returns false in those cases so
   * the caller can map to TAB_NOT_FOUND).
   */
  release(tab_id: string, session_id: string): TabRecord | undefined {
    const rec = this.byTabId.get(tab_id);
    if (!rec) return undefined;
    if (rec.owner_session_id !== session_id) return undefined;
    rec.owner_session_id = null;
    return rec;
  }

  /**
   * Release every tab a session owns. Called when a session's shim
   * disconnects so its tabs orphan back to user-owned instead of
   * staying invisible forever. Returns the released chrome_tab_ids
   * so the caller can broadcast release_tab events.
   */
  releaseAll(session_id: string): TabRecord[] {
    const released: TabRecord[] = [];
    for (const rec of this.byTabId.values()) {
      if (rec.owner_session_id === session_id) {
        rec.owner_session_id = null;
        released.push(rec);
      }
    }
    return released;
  }

  /** Ungated full list — daemon internals only. */
  list(): TabRecord[] {
    return [...this.byTabId.values()];
  }

  clear(): void {
    this.byTabId.clear();
    this.byChromeId.clear();
  }
}
