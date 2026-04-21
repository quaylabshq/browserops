export interface TabRecord {
  tab_id: string;
  chrome_tab_id: number;
  url: string;
  title?: string;
  active: boolean;
  window_id: number;
}

/**
 * Mints opaque tab ids (t_<base36-monotonic>) and tracks tab metadata
 * from extension events. See plans/00-overview.md §4.1.
 */
export class TabRegistry {
  private seq = 0;
  private readonly byTabId = new Map<string, TabRecord>();
  private readonly byChromeId = new Map<number, string>();

  mint(chromeTabId: number, partial: Omit<TabRecord, "tab_id" | "chrome_tab_id">): TabRecord {
    const existing = this.byChromeId.get(chromeTabId);
    if (existing) {
      const rec = this.byTabId.get(existing);
      if (rec) return rec;
    }
    this.seq += 1;
    const tab_id = `t_${this.seq.toString(36)}`;
    const rec: TabRecord = { tab_id, chrome_tab_id: chromeTabId, ...partial };
    this.byTabId.set(tab_id, rec);
    this.byChromeId.set(chromeTabId, tab_id);
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

  get(tab_id: string): TabRecord | undefined {
    return this.byTabId.get(tab_id);
  }

  getByChromeId(chromeTabId: number): TabRecord | undefined {
    const tab_id = this.byChromeId.get(chromeTabId);
    return tab_id ? this.byTabId.get(tab_id) : undefined;
  }

  list(): TabRecord[] {
    return [...this.byTabId.values()];
  }

  clear(): void {
    this.byTabId.clear();
    this.byChromeId.clear();
  }
}
