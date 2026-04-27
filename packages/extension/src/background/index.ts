import { CloseCode, DEFAULT_WS_HOST, DEFAULT_WS_PORT, type Request, type Response } from "@browserops/shared";
import type { EventName, EventMap } from "@browserops/shared";
import { WsClient } from "./ws-client.js";
import { Router, type Context } from "./router.js";
import { RefCache } from "./ref-cache.js";
import { CdpManager } from "./cdp.js";
import { NetworkTracker } from "./network-tracker.js";
import { registerTabHandlers } from "./handlers/tabs.js";
import { registerNavigationHandlers } from "./handlers/navigation.js";
import { registerScreenshotHandler } from "./handlers/screenshot.js";
import { registerReadHandler } from "./handlers/read.js";
import { registerInputHandlers } from "./handlers/input.js";
import { registerSafetyHandler, resolveSafetyDecision } from "./handlers/safety.js";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// Opaque bridge-issued tab_id ↔ chrome tabId. Rehydrated from
// chrome.storage.session on SW revive.
const tabIdToChromeId = new Map<string, number>();
const chromeIdToTabId = new Map<number, string>();

const router = new Router();
const refCache = new RefCache();
const cdp = new CdpManager();
const network = new NetworkTracker();
let wsClient: WsClient | null = null;

const ctx: Context = {
  emitEvent: <N extends EventName>(name: N, payload: EventMap[N]) => {
    wsClient?.sendEvent(name, payload);
  },
  refCache,
};

async function persistTabMap(): Promise<void> {
  await chrome.storage.session.set({ tabMap: Object.fromEntries(tabIdToChromeId) });
}

// --- pinned tab (user's "home base") -------------------------------------
// Persisted in chrome.storage.local so it survives browser restart. The
// in-memory cache is the source of truth during SW life; storage is written
// on every change.
// Storage shape: number (Chrome tab id). Old shape was a string (browserops
// tab_id) — migration runs in rehydratePinnedTab() below.
const PINNED_TAB_STORAGE_KEY = "pinnedTabId";
let pinnedChromeTabId: number | null = null;

const getPinnedTabId = (): string | null => {
  if (pinnedChromeTabId === null) return null;
  return chromeIdToTabId.get(pinnedChromeTabId) ?? null;
};

async function setPinnedTab(chromeTabId: number | null): Promise<void> {
  pinnedChromeTabId = chromeTabId;
  if (chromeTabId === null) {
    await chrome.storage.local.remove(PINNED_TAB_STORAGE_KEY);
  } else {
    await chrome.storage.local.set({ [PINNED_TAB_STORAGE_KEY]: chromeTabId });
  }
}

function generateTabId(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(5)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t_${hex}`;
}

async function pinCurrentTab(): Promise<
  { ok: true; tab_id: string; url: string; title: string } | { ok: false; error: string }
> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (tab === undefined || tab.id === undefined) {
    return { ok: false, error: "no active tab in focused window" };
  }
  let tabId = chromeIdToTabId.get(tab.id);
  if (tabId === undefined) {
    // Bridge hasn't assigned a tab_id yet — generate one locally so pinning
    // works standalone. When assign_tab_id arrives later it will overwrite this
    // entry, and getPinnedTabId() will then resolve to the bridge-assigned id.
    tabId = generateTabId();
    tabIdToChromeId.set(tabId, tab.id);
    chromeIdToTabId.set(tab.id, tabId);
    await persistTabMap();
  }
  await setPinnedTab(tab.id);
  const url = tab.url ?? tab.pendingUrl ?? "";
  const title = tab.title ?? "";
  ctx.emitEvent("tab_pinned", { tab_id: tabId, url, title });
  return { ok: true, tab_id: tabId, url, title };
}

async function unpinTab(): Promise<void> {
  if (pinnedChromeTabId === null) return;
  const tabId = getPinnedTabId();
  await setPinnedTab(null);
  if (tabId !== null) ctx.emitEvent("tab_unpinned", { tab_id: tabId });
}

// Inline assign_tab_id handler. Other handlers
// will be registered by their own modules in a later PR.
registerTabHandlers(router, {
  tabIdMap: tabIdToChromeId,
  chromeIdToTabId,
  getPinnedTabId,
});
registerNavigationHandlers(router, { tabIdMap: tabIdToChromeId, refCache, network, cdp });
registerScreenshotHandler(router, { tabIdMap: tabIdToChromeId });
registerReadHandler(router, { tabIdMap: tabIdToChromeId, refCache });
registerInputHandlers(router, { tabIdMap: tabIdToChromeId, refCache, cdp, network });
registerSafetyHandler(router, { restoreBadge: () => setBadge(currentConnected) });

router.register("assign_tab_id", async (params) => {
  const chromeTabId = params["chrome_tab_id"];
  const tabId = params["tab_id"];
  if (typeof chromeTabId !== "number" || typeof tabId !== "string") {
    const err = new Error("assign_tab_id requires chrome_tab_id:number and tab_id:string");
    (err as { code?: string }).code = "INVALID_PARAMS";
    throw err;
  }
  // Remove stale tabIdToChromeId entry if this Chrome tab already had a
  // locally-generated (or prior) tab_id. This prevents orphaned string keys
  // from accumulating when auto-generated ids are later overwritten by the bridge.
  const existingTabId = chromeIdToTabId.get(chromeTabId);
  if (existingTabId !== undefined && existingTabId !== tabId) {
    tabIdToChromeId.delete(existingTabId);
  }
  tabIdToChromeId.set(tabId, chromeTabId);
  chromeIdToTabId.set(chromeTabId, tabId);
  await persistTabMap();
  return { ok: true };
});

const resolveTabId = (chromeTabId: number): string | undefined => chromeIdToTabId.get(chromeTabId);

let currentConnected = false;
let currentAutoApprove = false;
let currentDisabled = false;

// The user's "Disable" intent is stored in chrome.storage.local so it persists
// across both SW restarts and browser restarts. The extension stays off until
// the user explicitly re-enables it from the popup.
const DISABLED_KEY = "disabled";

function applyBadge(): void {
  if (currentDisabled) {
    chrome.action.setBadgeText({ text: "—" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#888888" }).catch(() => {});
    return;
  }
  if (!currentConnected) {
    chrome.action.setBadgeText({ text: "!" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#c1121f" }).catch(() => {});
    return;
  }
  if (currentAutoApprove) {
    chrome.action.setBadgeText({ text: "YOLO" }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: "#c1121f" }).catch(() => {});
    return;
  }
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
}

function setBadge(_connected: boolean): void {
  applyBadge();
}

function onConnectionChange(connected: boolean): void {
  currentConnected = connected;
  applyBadge();
  // Expose connection state to the options/popup UIs, which poll this key.
  chrome.storage.local.set({ connected }).catch(() => {});
}

// Keep YOLO badge state synced across SW restart and popup toggles.
//
// The popup's storage key was renamed from "autoApprove" (true = auto) to
// "requireApproval" (true = gate) when auto-approve became the default. Read
// both keys: if requireApproval is present, use it (inverted); else fall back
// to the legacy autoApprove key for any in-flight old sessions; otherwise
// default to auto-approve = true (the new default), so the YOLO badge is
// visible the moment the SW boots on a fresh install.
void chrome.storage.session.get(["requireApproval", "autoApprove"]).then((s) => {
  if ("requireApproval" in s) {
    currentAutoApprove = s["requireApproval"] !== true;
  } else if ("autoApprove" in s) {
    currentAutoApprove = s["autoApprove"] === true;
  } else {
    currentAutoApprove = true;
  }
  applyBadge();
});
chrome.storage.session.onChanged.addListener((changes) => {
  if ("requireApproval" in changes) {
    currentAutoApprove = changes["requireApproval"]?.newValue !== true;
    applyBadge();
  } else if ("autoApprove" in changes) {
    currentAutoApprove = changes["autoApprove"]?.newValue === true;
    applyBadge();
  }
});

// Sync disabled state on SW revive (local storage persists across SW restarts).
void chrome.storage.local.get(DISABLED_KEY).then((s) => {
  currentDisabled = s[DISABLED_KEY] === true;
  applyBadge();
});

// Initial state on SW boot — UIs can read this before the first WS attempt.
chrome.storage.local.set({ connected: false }).catch(() => {});

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

async function isDisabled(): Promise<boolean> {
  const s = await chrome.storage.local.get(DISABLED_KEY);
  return s[DISABLED_KEY] === true;
}

async function setDisabled(v: boolean): Promise<void> {
  currentDisabled = v;
  applyBadge();
  if (v) await chrome.storage.local.set({ [DISABLED_KEY]: true });
  else await chrome.storage.local.remove(DISABLED_KEY);
}

async function startClient(): Promise<void> {
  if (await isDisabled()) {
    onConnectionChange(false);
    return;
  }
  const stored = await chrome.storage.local.get({
    token: "",
    host: DEFAULT_WS_HOST,
    port: DEFAULT_WS_PORT,
  });
  const token = typeof stored["token"] === "string" ? stored["token"] : "";
  const host = typeof stored["host"] === "string" ? stored["host"] : DEFAULT_WS_HOST;
  const port = typeof stored["port"] === "number" ? stored["port"] : DEFAULT_WS_PORT;
  if (token === "") {
    onConnectionChange(false);
    console.warn("[bg] no token; awaiting options page");
    return;
  }
  wsClient?.stop(false);
  wsClient = new WsClient({
    url: `ws://${host}:${port}/`,
    token,
    extensionVersion: EXTENSION_VERSION,
    onRequest: (req: Request): Promise<Response> => router.dispatch(req, ctx),
    onConnectionChange,
    onFatalClose: (code) => {
      if (code === CloseCode.SUPERSEDED) {
        // Another extension instance took the bridge connection. Treat this as
        // a manual disable so the keep-alive alarm doesn't immediately kick the
        // winner back off. The user can re-enable explicitly via the popup.
        void setDisabled(true);
        onConnectionChange(false);
      }
    },
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
  refCache.invalidate(tabId);
  tabIdToChromeId.delete(tabId);
  chromeIdToTabId.delete(chromeTabId);
  if (pinnedChromeTabId === chromeTabId) {
    void unpinTab();
  }
  network.forgetTab(chromeTabId);
  cdp.clearPersistent(chromeTabId);
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
  refCache.invalidate(tabId);
  ctx.emitEvent("page_navigated", { tab_id: tabId, url: d.url, transition_type: d.transitionType });
});

chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  const tabId = resolveTabId(d.tabId);
  if (tabId === undefined) return;
  refCache.invalidate(tabId);
  ctx.emitEvent("page_navigated", { tab_id: tabId, url: d.url, transition_type: d.transitionType });
});

// --- first-run onboarding -------------------------------------------------
// Open the pair-code onboarding page when the extension is first installed.
// Skips if a token is already configured (re-install onto an existing
// profile) so we don't disturb already-paired users.

const ONBOARD_PATH = "src/onboard/index.html";

function openOnboardPage(): void {
  const url = chrome.runtime.getURL(ONBOARD_PATH);
  chrome.tabs.create({ url }).catch((err: unknown) => {
    console.warn("[bg] failed to open onboarding tab:", err);
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") return;
  void chrome.storage.local.get("token").then((s) => {
    const token = typeof s["token"] === "string" ? s["token"] : "";
    if (token === "") openOnboardPage();
  });
});

// --- keep-alive alarm -----------------

chrome.alarms.create("ws-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "ws-keepalive") return;
  if (wsClient !== null && wsClient.isConnected()) return;
  void (async () => {
    if (await isDisabled()) return;
    await startClient();
  })();
});

// --- popup / options messages --------------------------------------------

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as { kind?: unknown; type?: unknown };
  const tag = typeof m.type === "string" ? m.type : typeof m.kind === "string" ? m.kind : "";
  if (tag === "kill_switch") {
    void (async () => {
      await setDisabled(true);
      await chrome.storage.session.remove("autoApprove");
      wsClient?.stop(true);
      onConnectionChange(false);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (tag === "reconnect") {
    void setDisabled(false).then(() => startClient()).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (tag === "pin_tab") {
    void pinCurrentTab().then((res) => sendResponse(res));
    return true;
  }
  if (tag === "unpin_tab") {
    void unpinTab().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (tag === "describe_pinned") {
    void (async () => {
      if (pinnedChromeTabId === null) {
        sendResponse({ ok: false, error: "no pinned tab" });
        return;
      }
      const tabId = getPinnedTabId();
      try {
        const tab = await chrome.tabs.get(pinnedChromeTabId);
        sendResponse({
          ok: true,
          tab_id: tabId ?? "",
          url: tab.url ?? tab.pendingUrl ?? "",
          title: tab.title ?? "",
        });
      } catch {
        sendResponse({ ok: false, error: "chrome tab gone" });
      }
    })();
    return true;
  }
  if (tag === "safety_decision") {
    const mm = m as { decision_id?: unknown; allow?: unknown };
    const ok =
      typeof mm.decision_id === "string" &&
      typeof mm.allow === "boolean" &&
      resolveSafetyDecision(mm.decision_id, mm.allow);
    sendResponse({ ok });
    return false;
  }
  return false;
});

// --- boot ----------------------------------------------------------------

async function rehydratePinnedTab(): Promise<void> {
  const s = await chrome.storage.local.get(PINNED_TAB_STORAGE_KEY);
  const raw = s[PINNED_TAB_STORAGE_KEY];
  if (typeof raw === "number") {
    pinnedChromeTabId = raw;
  } else if (typeof raw === "string") {
    // Old storage shape: value was a browserops tab_id string. Migrate to Chrome tab id.
    const chromeId = tabIdToChromeId.get(raw);
    if (chromeId !== undefined) {
      pinnedChromeTabId = chromeId;
      await chrome.storage.local.set({ [PINNED_TAB_STORAGE_KEY]: chromeId });
    } else {
      console.log("[bg] pinned tab migration: old tab_id not in map, clearing pin");
      await chrome.storage.local.remove(PINNED_TAB_STORAGE_KEY);
      pinnedChromeTabId = null;
    }
  } else {
    pinnedChromeTabId = null;
  }
}

void (async () => {
  await rehydrate();
  await rehydratePinnedTab();
  // RefCache rehydration depends on the tabIdMap being restored so we can
  // compare stored snapshot URLs against the tab's live URL.
  await refCache.rehydrate(async (tabId: string): Promise<string | undefined> => {
    const chromeId = tabIdToChromeId.get(tabId);
    if (chromeId === undefined) return undefined;
    try {
      const tab = await chrome.tabs.get(chromeId);
      return typeof tab.url === "string" ? tab.url : undefined;
    } catch {
      return undefined;
    }
  });
  await startClient();
})();
