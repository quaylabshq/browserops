/**
 * Named Event payloads from extension → bridge.
 */

export interface TabCreatedPayload {
  chrome_tab_id: number;
  url: string;
  window_id: number;
  index: number;
  active: boolean;
}

export interface TabClosedPayload {
  tab_id: string;
}

export interface TabUpdatedPayload {
  tab_id: string;
  url?: string;
  title?: string;
  active?: boolean;
  status?: "loading" | "complete";
}

export interface PageNavigatedPayload {
  tab_id: string;
  url: string;
  transition_type?: string;
}

export interface PageLoadedPayload {
  tab_id: string;
  url: string;
}

export interface ExtensionPausedPayload {
  reason: "user_disconnect" | "debugger_external_detach";
}

export interface ExtensionResumedPayload {
  extension_version: string;
}

export interface TabPinnedPayload {
  tab_id: string;
  url: string;
  title: string;
}

export interface TabUnpinnedPayload {
  /** Present when the unpin was driven by a tab closing or explicit action
   *  on a specific tab; absent for "no tab is pinned now" bootstraps. */
  tab_id?: string;
}

export type EventName =
  | "tab_created"
  | "tab_closed"
  | "tab_updated"
  | "page_navigated"
  | "page_loaded"
  | "extension_paused"
  | "extension_resumed"
  | "tab_pinned"
  | "tab_unpinned";

export interface EventMap {
  tab_created: TabCreatedPayload;
  tab_closed: TabClosedPayload;
  tab_updated: TabUpdatedPayload;
  page_navigated: PageNavigatedPayload;
  page_loaded: PageLoadedPayload;
  extension_paused: ExtensionPausedPayload;
  extension_resumed: ExtensionResumedPayload;
  tab_pinned: TabPinnedPayload;
  tab_unpinned: TabUnpinnedPayload;
}
