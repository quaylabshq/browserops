import { DEFAULT_WS_HOST, DEFAULT_WS_PORT, type Request, type Response } from "@browserops/shared";
import type { EventName, EventMap } from "@browserops/shared";
import { WsClient } from "./ws-client.js";
import { Router, type Context } from "./router.js";

// TODO: register tool handlers here when they land. Expected modules:
//   ./handlers/tabs.js, ./handlers/navigation.js, ./handlers/read.js,
//   ./handlers/input.js, ./handlers/screenshot.js, ./handlers/safety.js.
// Each exports `registerHandlers(router, ctx)`; call them right below
// the inline assign_tab_id registration.

const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// Opaque bridge-issued tab_id ↔ chrome tabId. Rehydrated from
// chrome.storage.session on SW revive (plans/03-extension.md §D3/D5).
const tabIdToChromeId = new Map<string, number>();
const chromeIdToTabId = new Map<number, string>();

const router = new Router();
let wsClient: WsClient | null = null;

const ctx: Context = {
  emitEvent: <N extends EventName>(name: N, payload: EventMap[N]) => {
    wsClient?.sendEvent(name, payload);
  },
};

async function persistTabMap(): Promise<void> {
  await chrome.storage.session.set({ tabMap: Object.fromEntries(tabIdToChromeId) });
}

// Inline assign_tab_id handler (plans/03-extension.md §D5). Other handlers
// will be registered by their own modules in a later PR.
router.register("assign_tab_id", async (params) => {
  const chromeTabId = params["chrome_tab_id"];
  const tabId = params["tab_id"];
  if (typeof chromeTabId !== "number" || typeof tabId !== "string") {
    const err = new Error("assign_tab_id requires chrome_tab_id:number and tab_id:string");
    (err as { code?: string }).code = "INVALID_PARAMS";
    throw err;
  }
  tabIdToChromeId.set(tabId, chromeTabId);
  chromeIdToTabId.set(chromeTabId, tabId);
  await persistTabMap();
  return { ok: true };
});

const resolveTabId = (chromeTabId: number): string | undefined => chromeIdToTabId.get(chromeTabId);

function setBadge(connected: boolean): void {
  chrome.action.setBadgeText({ text: connected ? "" : "!" }).catch(() => {});
  if (!connected) chrome.action.setBadgeBackgroundColor({ color: "#c1121f" }).catch(() => {});
}

async function rehydrate(): Promise<void> {
  const { tabMap } = await chrome.storage.session.get("tabMap");
  if (typeof tabMap !== "object" || tabMap === null) return;
  for (const [tabId, chromeId] of Object.entries(tabMap as Record<string, unknown>)) {
    if (typeof chromeId === "number") {
      tabIdToChromeId.set(tabId, chromeId);
      chromeIdToTabId.set(chromeId, tabId);
    }
  }
}

async function startClient(): Promise<void> {
  const stored = await chrome.storage.local.get({
    token: "",
    host: DEFAULT_WS_HOST,
    port: DEFAULT_WS_PORT,
  });
  const token = typeof stored["token"] === "string" ? stored["token"] : "";
  const host = typeof stored["host"] === "string" ? stored["host"] : DEFAULT_WS_HOST;
  const port = typeof stored["port"] === "number" ? stored["port"] : DEFAULT_WS_PORT;
  if (token === "") {
    setBadge(false);
    console.warn("[bg] no token; awaiting options page");
    return;
  }
  wsClient?.stop(false);
  wsClient = new WsClient({
    url: `ws://${host}:${port}/`,
    token,
    extensionVersion: EXTENSION_VERSION,
    onRequest: (req: Request): Promise<Response> => router.dispatch(req, ctx),
    onConnectionChange: setBadge,
  });
  wsClient.start();
}

// --- chrome event listeners → bridge events ------------------------------

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined) return;
  // This is the canonical tab_created emit point. Bridge will reply with an
  // assign_tab_id Request which is handled by the router above.
  ctx.emitEvent("tab_created", {
    chrome_tab_id: tab.id,
    url: tab.url ?? tab.pendingUrl ?? "",
    window_id: tab.windowId,
    index: tab.index,
    active: tab.active,
  });
});

chrome.tabs.onRemoved.addListener((chromeTabId) => {
  const tabId = chromeIdToTabId.get(chromeTabId);
  if (tabId === undefined) return;
  ctx.emitEvent("tab_closed", { tab_id: tabId });
  tabIdToChromeId.delete(tabId);
  chromeIdToTabId.delete(chromeTabId);
  void persistTabMap();
});

chrome.tabs.onUpdated.addListener((chromeTabId, changeInfo) => {
  const tabId = resolveTabId(chromeTabId);
  if (tabId === undefined) return;
  const payload: EventMap["tab_updated"] = { tab_id: tabId };
  if (changeInfo.url !== undefined) payload.url = changeInfo.url;
  if (changeInfo.title !== undefined) payload.title = changeInfo.title;
  if (changeInfo.status === "loading" || changeInfo.status === "complete") {
    payload.status = changeInfo.status;
  }
  ctx.emitEvent("tab_updated", payload);
});

chrome.tabs.onActivated.addListener((info) => {
  const tabId = resolveTabId(info.tabId);
  if (tabId !== undefined) ctx.emitEvent("tab_updated", { tab_id: tabId, active: true });
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  const tabId = resolveTabId(d.tabId);
  if (tabId === undefined) return;
  ctx.emitEvent("page_navigated", { tab_id: tabId, url: d.url, transition_type: d.transitionType });
});

chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  const tabId = resolveTabId(d.tabId);
  if (tabId === undefined) return;
  ctx.emitEvent("page_navigated", { tab_id: tabId, url: d.url, transition_type: d.transitionType });
});

// --- keep-alive alarm (plans/03-extension.md §D2 step 5) -----------------

chrome.alarms.create("ws-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "ws-keepalive") return;
  if (wsClient === null || !wsClient.isConnected()) void startClient();
});

// --- popup / options messages --------------------------------------------

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (typeof msg !== "object" || msg === null) return false;
  const kind = (msg as { kind?: unknown }).kind;
  if (kind === "kill_switch") {
    wsClient?.stop(true);
    setBadge(false);
    sendResponse({ ok: true });
    return false;
  }
  if (kind === "reconnect") {
    void startClient().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// --- boot ----------------------------------------------------------------

void (async () => {
  await rehydrate();
  await startClient();
})();
