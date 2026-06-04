/**
 * Per-tab ref cache.
 *
 * `browser_read(mode: "a11y_tree")` produces a numbered list of elements.
 * Those refs are looked up here by later click/type/hover handlers.
 *
 * Staleness model: a snapshot is dropped
 * when the tab navigates (chrome.webNavigation.onCommitted), when a new
 * read replaces it, or when the tab URL no longer matches what we stored
 * (restored from session storage after SW eviction).
 *
 * We mirror a light form of each snapshot (selector + role + name + attrs,
 * not live DOM handles) to chrome.storage.session so refs survive MV3
 * service-worker eviction. On restore, if the tab's current URL differs
 * from the snapshot URL, the snapshot is considered stale and get() returns
 * undefined.
 */

export interface RefEntry {
  /** 1-based ref number. 0 is reserved for "no ref". */
  ref: number;
  /** Stable-ish CSS selector — #id, [data-testid=...], or nth-of-type path. */
  selector: string;
  /** ARIA role or a tag-derived default (e.g. "button", "link", "textbox"). */
  role: string;
  /** Accessible name, truncated to 80 chars. */
  name: string;
  /**
   * Diagnostic + tier-1 locator-match info. Common keys:
   *   - domType, inputType, type   — legacy diagnostic fields
   *   - aria-label, data-testid,
   *     data-test, data-qa, href,
   *     name (form controls only)  — tier-1 stable signals used by the
   *     locator resolver and the uniqueness scorer (see lib/tier1-attrs.ts)
   */
  attrs?: Record<string, string>;
}

export interface RefSnapshot {
  tab_id: string;
  url: string;
  createdAt: number;
  entries: Map<number, RefEntry>;
}

interface PersistedSnapshot {
  tab_id: string;
  url: string;
  createdAt: number;
  entries: Array<[number, RefEntry]>;
}

const STORAGE_PREFIX = "refSnapshot:";

function storageKey(tabId: string): string {
  return `${STORAGE_PREFIX}${tabId}`;
}

function isPersistedSnapshot(value: unknown): value is PersistedSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["tab_id"] === "string" &&
    typeof v["url"] === "string" &&
    typeof v["createdAt"] === "number" &&
    Array.isArray(v["entries"])
  );
}

export class RefCache {
  private readonly snapshots = new Map<string, RefSnapshot>();
  // One-deep history: when a new snapshot replaces the current one, the
  // outgoing snapshot moves here. This lets lookupWithFallback() resolve
  // refs the agent received from an earlier read after an intervening
  // browser_quick_read or browser_observe(structure) replaced the
  // active snapshot. Without this, every observation invalidates every
  // outstanding ref and the agent has to re-read before each action.
  private readonly previous = new Map<string, RefSnapshot>();

  set(tab_id: string, snapshot: RefSnapshot): void {
    const outgoing = this.snapshots.get(tab_id);
    if (outgoing !== undefined && outgoing.url === snapshot.url) {
      // Same-page replacement — keep the outgoing snapshot as the fallback
      // so refs from the prior read survive one round of observation.
      this.previous.set(tab_id, outgoing);
    } else {
      // URL change (or first set) — clear the fallback; prior refs are
      // definitionally stale.
      this.previous.delete(tab_id);
    }
    this.snapshots.set(tab_id, snapshot);
    void this.persist(tab_id, snapshot);
  }

  get(tab_id: string): RefSnapshot | undefined {
    return this.snapshots.get(tab_id);
  }

  lookup(tab_id: string, ref: number): RefEntry | undefined {
    const snap = this.snapshots.get(tab_id);
    if (snap === undefined) return undefined;
    return snap.entries.get(ref);
  }

  /**
   * Resolve a ref against the current snapshot first; if absent (or the
   * ref number wasn't issued by the current snapshot) fall back to the
   * one-deep previous snapshot. Returns the entry plus a flag indicating
   * whether the fallback was used so callers can warn or surface it.
   */
  lookupWithFallback(
    tab_id: string,
    ref: number,
  ): { entry: RefEntry; source: "current" | "previous" } | undefined {
    const current = this.snapshots.get(tab_id);
    const fromCurrent = current?.entries.get(ref);
    if (fromCurrent !== undefined) {
      return { entry: fromCurrent, source: "current" };
    }
    const prev = this.previous.get(tab_id);
    if (prev === undefined) return undefined;
    // Only fall back if the previous snapshot's URL still matches the
    // current snapshot's URL (or the current snapshot is missing, e.g.
    // SW eviction). Cross-URL fallback would resolve refs against a
    // page the agent isn't even looking at any more.
    if (current !== undefined && current.url !== prev.url) return undefined;
    const fromPrev = prev.entries.get(ref);
    if (fromPrev === undefined) return undefined;
    return { entry: fromPrev, source: "previous" };
  }

  invalidate(tab_id: string): void {
    this.snapshots.delete(tab_id);
    this.previous.delete(tab_id);
    void chrome.storage.session.remove(storageKey(tab_id)).catch(() => {});
  }

  clear(): void {
    const keys = Array.from(this.snapshots.keys()).map(storageKey);
    this.snapshots.clear();
    this.previous.clear();
    if (keys.length > 0) {
      void chrome.storage.session.remove(keys).catch(() => {});
    }
  }

  /**
   * Rehydrate from chrome.storage.session on SW wake. Snapshots whose
   * stored URL differs from the tab's current URL are dropped.
   */
  async rehydrate(resolveTabUrl: (tab_id: string) => Promise<string | undefined>): Promise<void> {
    const all = await chrome.storage.session.get(null);
    for (const [key, raw] of Object.entries(all)) {
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      if (!isPersistedSnapshot(raw)) {
        void chrome.storage.session.remove(key).catch(() => {});
        continue;
      }
      const currentUrl = await resolveTabUrl(raw.tab_id);
      if (currentUrl === undefined || currentUrl !== raw.url) {
        void chrome.storage.session.remove(key).catch(() => {});
        continue;
      }
      const entries = new Map<number, RefEntry>();
      for (const [ref, entry] of raw.entries) {
        entries.set(ref, entry);
      }
      this.snapshots.set(raw.tab_id, {
        tab_id: raw.tab_id,
        url: raw.url,
        createdAt: raw.createdAt,
        entries,
      });
    }
  }

  private async persist(tab_id: string, snapshot: RefSnapshot): Promise<void> {
    const persisted: PersistedSnapshot = {
      tab_id: snapshot.tab_id,
      url: snapshot.url,
      createdAt: snapshot.createdAt,
      entries: Array.from(snapshot.entries.entries()),
    };
    try {
      await chrome.storage.session.set({ [storageKey(tab_id)]: persisted });
    } catch {
      // Session storage is best-effort; in-memory map is the primary copy.
    }
  }
}
