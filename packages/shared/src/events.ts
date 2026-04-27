/**
 * Named Event payloads from extension → bridge.
 */

import type { TeachEvent } from "./teach.js";

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

export type EventName =
  | "tab_created"
  | "tab_closed"
  | "tab_updated"
  | "page_navigated"
  | "page_loaded"
  | "extension_paused"
  | "extension_resumed"
  | "teach_event";

export interface EventMap {
  tab_created: TabCreatedPayload;
  tab_closed: TabClosedPayload;
  tab_updated: TabUpdatedPayload;
  page_navigated: PageNavigatedPayload;
  page_loaded: PageLoadedPayload;
  extension_paused: ExtensionPausedPayload;
  extension_resumed: ExtensionResumedPayload;
  teach_event: TeachEvent;
}
