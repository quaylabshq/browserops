import type { Effect, MutationCounts } from "@browserops/shared";
import {
  installMutationObserver,
  readMutationObserver,
} from "../content/mutation-window.js";
import { execInTab } from "./handlers/input.js";

// Higher-order helper used by the observation-architecture plan's
// page_effect envelope path. Wraps any action handler with the pre/post
// instrumentation (mutations, network, visual hash, focus, dialogs, a11y,
// console errors) defined in the plan and returns a populated Effect
// alongside the action's result.

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

  const effect = zeroEffect();
  effect.mutations = mutations;
  effect.duration_ms = Date.now() - start;
  return { result, effect };
}
