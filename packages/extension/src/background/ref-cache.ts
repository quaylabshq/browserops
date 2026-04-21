/**
 * Per-tab ref cache.
 *
 * `browser.read(mode: "a11y_tree")` produces a numbered list of elements.
 * Those refs are looked up here by later click/type/hover handlers.
 *
 * Staleness model (plans/05-element-refs.md §4.7): a snapshot is dropped
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
  /** Extra diagnostic info: domType, inputType, href, type. */
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

  set(tab_id: string, snapshot: RefSnapshot): void {
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

  invalidate(tab_id: string): void {
    this.snapshots.delete(tab_id);
    void chrome.storage.session.remove(storageKey(tab_id)).catch(() => {});
  }

  clear(): void {
    const keys = Array.from(this.snapshots.keys()).map(storageKey);
    this.snapshots.clear();
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
