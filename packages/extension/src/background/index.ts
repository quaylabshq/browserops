import {
  CloseCode,
  DEFAULT_WS_HOST,
  DEFAULT_WS_PORT,
  isFeatureName,
  type FeatureName,
  type Request,
  type Response,
} from "@browserops/shared";
import type { EventName, EventMap } from "@browserops/shared";
import { WsClient } from "./ws-client.js";
import { Router, type Context } from "./router.js";
import { RefCache } from "./ref-cache.js";
import { CdpManager } from "./cdp.js";
import { NetworkTracker } from "./network-tracker.js";
import { setCdpForEffect } from "./effect.js";
import { registerTabHandlers } from "./handlers/tabs.js";
import { registerNavigationHandlers } from "./handlers/navigation.js";
import { registerScreenshotHandler } from "./handlers/screenshot.js";
import { registerReadHandler } from "./handlers/read.js";
import { registerObserveHandler } from "./handlers/observe.js";
import { registerInputHandlers } from "./handlers/input.js";
import { registerLocateHandler } from "./handlers/locate.js";
import { registerProposeLocatorHandler } from "./handlers/propose-locator.js";
import { registerSafetyHandler, resolveSafetyDecision } from "./handlers/safety.js";
import { registerSessionGroupHandlers } from "./handlers/session-groups.js";
import { registerMcpHealthHandlers } from "./handlers/mcp-health.js";
import { syncExistingTabs } from "./tab-sync.js";

// Yellow icon variants — `?url` suffix forces vite to emit them as files
// (the small PNGs would otherwise be inlined as base64, which
// chrome.action.setIcon rejects). Default blue icons come from manifest.icons.
import yoloIcon16 from "../assets/icons/icon-16-yolo.png?url";
import yoloIcon32 from "../assets/icons/icon-32-yolo.png?url";
import yoloIcon48 from "../assets/icons/icon-48-yolo.png?url";
import yoloIcon128 from "../assets/icons/icon-128-yolo.png?url";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// Opaque bridge-issued tab_id ↔ chrome tabId. Rehydrated from
// chrome.storage.session on SW revive.
const tabIdToChromeId = new Map<string, number>();
const chromeIdToTabId = new Map<number, string>();

const router = new Router();
const refCache = new RefCache();
const cdp = new CdpManager();
setCdpForEffect(cdp);
const network = new NetworkTracker();
let wsClient: WsClient | null = null;

// Live feature set sourced from chrome.storage.local.features. Populated on
// SW boot and updated on every HelloAck so the router's gate sees the latest
// state. The procedures feature defaults to OFF — explicit user opt-in.
const enabledFeatures = new Set<FeatureName>();
router.setFeatureSource(() => enabledFeatures);

const FEATURES_STORAGE_KEY = "features";

async function loadFeaturesFromStorage(): Promise<void> {
  const s = await chrome.storage.local.get(FEATURES_STORAGE_KEY);
  enabledFeatures.clear();
  const raw = s[FEATURES_STORAGE_KEY];
  if (!Array.isArray(raw)) return;
  for (const name of raw) if (isFeatureName(name)) enabledFeatures.add(name);
}

async function persistFeatures(features: string[]): Promise<void> {
  const filtered = features.filter(isFeatureName);
  enabledFeatures.clear();
  for (const name of filtered) enabledFeatures.add(name);
  await chrome.storage.local.set({ [FEATURES_STORAGE_KEY]: filtered });
}

const ctx: Context = {
  emitEvent: <N extends EventName>(name: N, payload: EventMap[N]) => {
    wsClient?.sendEvent(name, payload);
  },
  refCache,
};

async function persistTabMap(): Promise<void> {
  await chrome.storage.session.set({ tabMap: Object.fromEntries(tabIdToChromeId) });
}

// Inline assign_tab_id handler. Other handlers
// will be registered by their own modules in a later PR.
registerTabHandlers(router, {
  tabIdMap: tabIdToChromeId,
  chromeIdToTabId,
  cdp,
});
registerNavigationHandlers(router, { tabIdMap: tabIdToChromeId, refCache, network, cdp });
registerScreenshotHandler(router, { tabIdMap: tabIdToChromeId, cdp });
registerReadHandler(router, { tabIdMap: tabIdToChromeId, refCache });
registerObserveHandler(router, { tabIdMap: tabIdToChromeId, refCache });
registerInputHandlers(router, { tabIdMap: tabIdToChromeId, refCache, cdp, network });
registerLocateHandler(router, { tabIdMap: tabIdToChromeId, refCache });
registerProposeLocatorHandler(router, { tabIdMap: tabIdToChromeId, refCache });
registerSafetyHandler(router, { restoreBadge: () => setBadge(currentConnected) });

registerSessionGroupHandlers(router);
registerMcpHealthHandlers(router);

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
let currentDisabled = false;
// YOLO = auto-approve risky actions (no permission required). Default true on
// fresh boot so the warning icon shows until the user explicitly opts into the
// gated mode via the popup checkbox. Source of truth is the popup-controlled
// `requireApproval` session key (inverted) — see the storage listener below.
let currentAutoApprove = true;

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
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
}

// Swap the toolbar icon to the yellow variant whenever auto-approve (YOLO) is on,
// so the user has a glanceable warning that risky actions won't be gated.
const YOLO_ICON_PATHS = {
  "16": yoloIcon16,
  "32": yoloIcon32,
  "48": yoloIcon48,
  "128": yoloIcon128,
};
const DEFAULT_ICON_PATHS = {
  "16": "src/assets/icons/icon-16.png",
  "32": "src/assets/icons/icon-32.png",
  "48": "src/assets/icons/icon-48.png",
  "128": "src/assets/icons/icon-128.png",
};
function applyIcon(): void {
  const path = currentAutoApprove ? YOLO_ICON_PATHS : DEFAULT_ICON_PATHS;
  chrome.action.setIcon({ path }).catch(() => {});
}

function setBadge(_connected: boolean): void {
  applyBadge();
  applyIcon();
}

function onConnectionChange(connected: boolean): void {
  currentConnected = connected;
  applyBadge();
  applyIcon();
  // Expose connection state to the options/popup UIs, which poll this key.
  chrome.storage.local.set({ connected }).catch(() => {});
}

async function syncOpenTabsToBridge(): Promise<void> {
  try {
    await syncExistingTabs(
      () => chrome.tabs.query({}),
      (name, payload) => ctx.emitEvent(name, payload),
    );
  } catch {
    // A transient Chrome API failure is recovered on the next websocket
    // reconnect or tab event; it must not break the bridge connection.
  }
}

// Sync auto-approve state on SW boot. The popup writes `requireApproval=true`
// to session storage when the user ticks the "Require approval" checkbox; an
// absent key means default YOLO (auto-approve on).
void chrome.storage.session.get("requireApproval").then((s) => {
  currentAutoApprove = s["requireApproval"] !== true;
  applyIcon();
});
chrome.storage.session.onChanged.addListener((changes) => {
  if ("requireApproval" in changes) {
    currentAutoApprove = changes["requireApproval"]?.newValue !== true;
    applyIcon();
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
    onConnectionChange: (connected) => {
      onConnectionChange(connected);
      if (connected) void syncOpenTabsToBridge();
    },
    onFeatures: (features) => {
      void persistFeatures(features);
    },
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

void chrome.alarms.create("ws-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "ws-keepalive") return;
  if (wsClient !== null && wsClient.isConnected()) return;
  void (async () => {
    if (await isDisabled()) return;
    await startClient();
  })();
});

// --- popup / options messages --------------------------------------------

chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
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
    void setDisabled(false)
      .then(() => startClient())
      .then(() => sendResponse({ ok: true }));
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

void (async () => {
  await rehydrate();
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
  await loadFeaturesFromStorage();
  applyBadge();
  await startClient();
})();
