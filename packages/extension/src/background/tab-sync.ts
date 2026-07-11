import type { EventMap, EventName } from "@browserops/shared";

export interface ExistingTab {
  id?: number;
  url?: string;
  pendingUrl?: string;
  windowId: number;
  index: number;
  active: boolean;
}

/**
 * Chrome does not replay tabs.onCreated after an extension service-worker or
 * bridge restart. Re-announce the live profile on every ready WebSocket so a
 * fresh bridge can mint tab ids for already-open user tabs.
 */
export async function syncExistingTabs(
  listTabs: () => Promise<ExistingTab[]>,
  emit: <N extends EventName>(name: N, payload: EventMap[N]) => void,
): Promise<void> {
  const tabs = await listTabs();
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    emit("tab_created", {
      chrome_tab_id: tab.id,
      url: tab.url ?? tab.pendingUrl ?? "",
      window_id: tab.windowId,
      index: tab.index,
      active: tab.active,
    });
  }
}
