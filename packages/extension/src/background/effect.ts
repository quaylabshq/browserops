import type { Effect, MutationCounts, NetworkActivity } from "@browserops/shared";
import {
  installMutationObserver,
  readMutationObserver,
  snapshotFocusAndDialogs,
} from "../content/mutation-window.js";
import type { DialogSnapshot, FocusSnapshot } from "../content/mutation-window.js";
import { execInTab } from "./handlers/input.js";
import type { CdpManager } from "./cdp.js";
import { dhash, normalizedDistance, type DHash } from "../lib/phash.js";

// Higher-order helper used by the observation-architecture plan's
// page_effect envelope path. Wraps any action handler with the pre/post
// instrumentation (mutations, network, visual hash, focus, dialogs, a11y,
// console errors) defined in the plan and returns a populated Effect
// alongside the action's result.

// Module-level CDP singleton, wired from the background entrypoint at boot.
// captureEffect runs from many call sites; threading the manager through
// every handler's signature would force a wider refactor than the plan
// scopes here.
let cdpRef: CdpManager | null = null;

export function setCdpForEffect(cdp: CdpManager): void {
  if (cdpRef !== null) return;
  cdpRef = cdp;
  cdp.addEventListener(onCdpEvent);
}

// Active network captures keyed by chrome tab id. Each entry maps a
// per-call windowId to its accumulating NetworkActivity counters.
interface NetworkCapture {
  requests: number;
  failed: number;
  endpoints: Set<string>;
}
const activeNetworkCaptures = new Map<number, Map<string, NetworkCapture>>();
// Tabs we've already enabled the CDP Network domain on. Network.enable is
// idempotent server-side, but the bookkeeping saves redundant round-trips.
const networkEnabledTabs = new Set<number>();

const MAX_ENDPOINTS = 5;

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

function onCdpEvent(
  tabId: number,
  method: string,
  params: Record<string, unknown>,
): void {
  if (
    method !== "Network.requestWillBeSent" &&
    method !== "Network.loadingFailed" &&
    method !== "Network.responseReceived"
  ) {
    return;
  }
  const perWindow = activeNetworkCaptures.get(tabId);
  if (perWindow === undefined || perWindow.size === 0) return;
  if (method === "Network.requestWillBeSent") {
    const req = params["request"] as { url?: string } | undefined;
    const url = typeof req?.url === "string" ? req.url : "";
    if (url === "") return;
    for (const cap of perWindow.values()) {
      cap.requests++;
      if (cap.endpoints.size < MAX_ENDPOINTS) {
        cap.endpoints.add(stripQuery(url));
      }
    }
  } else if (method === "Network.loadingFailed") {
    for (const cap of perWindow.values()) {
      cap.failed++;
    }
  }
}

async function ensureNetworkEnabled(tabId: number): Promise<void> {
  if (cdpRef === null) return;
  if (networkEnabledTabs.has(tabId)) return;
  try {
    await cdpRef.send(tabId, "Network.enable");
    networkEnabledTabs.add(tabId);
  } catch (err) {
    console.warn("[browserops] Network.enable failed:", err);
  }
}

function startNetworkCapture(tabId: number, windowId: string): void {
  let perWindow = activeNetworkCaptures.get(tabId);
  if (perWindow === undefined) {
    perWindow = new Map();
    activeNetworkCaptures.set(tabId, perWindow);
  }
  perWindow.set(windowId, { requests: 0, failed: 0, endpoints: new Set() });
}

function readNetworkCapture(tabId: number, windowId: string): NetworkActivity {
  const perWindow = activeNetworkCaptures.get(tabId);
  if (perWindow === undefined) {
    return { requests: 0, failed: 0, endpoints: [] };
  }
  const cap = perWindow.get(windowId);
  perWindow.delete(windowId);
  if (perWindow.size === 0) activeNetworkCaptures.delete(tabId);
  if (cap === undefined) {
    return { requests: 0, failed: 0, endpoints: [] };
  }
  return {
    requests: cap.requests,
    failed: cap.failed,
    endpoints: [...cap.endpoints],
  };
}

export function zeroEffect(): Effect {
  return {
    url_changed: false,
    title_changed: false,
    mutations: { added: 0, removed: 0, attr: 0, char: 0 },
    network: { requests: 0, failed: 0, endpoints: [] },
    visual_hash_delta: 0,
    a11y_delta: { added: 0, removed: 0, changed: 0 },
    focus_moved_to: null,
    new_dialogs: [],
    console_errors: 0,
    duration_ms: 0,
  };
}

function newWindowId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

const PHASH_W = 256;
const PHASH_H = 160;

async function captureViewportHash(tabId: number): Promise<DHash | null> {
  if (cdpRef === null) return null;
  try {
    const res = await cdpRef.send<{ data?: string }>(
      tabId,
      "Page.captureScreenshot",
      {
        format: "png",
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: PHASH_W, height: PHASH_H, scale: 1 },
      },
    );
    const data = res?.data;
    if (typeof data !== "string" || data === "") return null;
    const bytes = base64ToBytes(data);
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    return await dhash(img);
  } catch (err) {
    console.warn("[browserops] viewport hash failed:", err);
    return null;
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function captureEffect<T>(
  tabId: number,
  fn: () => Promise<T>,
): Promise<{ result: T; effect: Effect }> {
  const start = Date.now();
  const windowId = newWindowId();

  let mutationInstalled = false;
  try {
    await execInTab(tabId, installMutationObserver, [windowId] as const);
    mutationInstalled = true;
  } catch (err) {
    console.warn("[browserops] mutation observer install failed:", err);
  }

  await ensureNetworkEnabled(tabId);
  startNetworkCapture(tabId, windowId);

  const preHash = await captureViewportHash(tabId);

  let preSnapshot: { focus: FocusSnapshot; dialogs: DialogSnapshot[] } = {
    focus: { selector: null },
    dialogs: [],
  };
  try {
    preSnapshot = await execInTab(tabId, snapshotFocusAndDialogs, [] as const);
  } catch (err) {
    console.warn("[browserops] pre snapshot failed:", err);
  }

  let result: T;
  try {
    result = await fn();
  } catch (actionErr) {
    if (mutationInstalled) {
      try {
        await execInTab(tabId, readMutationObserver, [windowId] as const);
      } catch {
        /* ignore */
      }
    }
    readNetworkCapture(tabId, windowId);
    throw actionErr;
  }

  let mutations: MutationCounts = { added: 0, removed: 0, attr: 0, char: 0 };
  if (mutationInstalled) {
    try {
      mutations = await execInTab(tabId, readMutationObserver, [windowId] as const);
    } catch (err) {
      console.warn("[browserops] mutation observer read failed:", err);
    }
  }
  const network = readNetworkCapture(tabId, windowId);
  const postHash = await captureViewportHash(tabId);

  let postSnapshot: { focus: FocusSnapshot; dialogs: DialogSnapshot[] } = {
    focus: { selector: null },
    dialogs: [],
  };
  try {
    postSnapshot = await execInTab(tabId, snapshotFocusAndDialogs, [] as const);
  } catch (err) {
    console.warn("[browserops] post snapshot failed:", err);
  }

  const effect = zeroEffect();
  effect.mutations = mutations;
  effect.network = network;
  if (preHash !== null && postHash !== null) {
    effect.visual_hash_delta = normalizedDistance(preHash, postHash);
  }
  if (preSnapshot.focus.selector !== postSnapshot.focus.selector) {
    effect.focus_moved_to = postSnapshot.focus.selector;
  }
  const preDialogKey = new Set(preSnapshot.dialogs.map((d) => d.name));
  effect.new_dialogs = postSnapshot.dialogs
    .filter((d) => !preDialogKey.has(d.name))
    .map((d) => ({ role: d.role, name: d.name, ref: d.selector }));
  effect.duration_ms = Date.now() - start;
  return { result, effect };
}
