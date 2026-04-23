import { NAVIGATE_TIMEOUT_MS, WAIT_FOR_TIMEOUT_CAP_MS, type ErrorCode } from "@browserops/shared";
import type { Router } from "../router.js";
import type { RefCache } from "../ref-cache.js";
import type { NetworkTracker } from "../network-tracker.js";

interface NavigationOpts {
  tabIdMap: Map<string, number>;
  refCache: RefCache;
  network: NetworkTracker;
}

const WAIT_FOR_POLL_DEFAULT_MS = 250;
const WAIT_FOR_POLL_MIN_MS = 50;
const WAIT_FOR_POLL_MAX_MS = 5000;

function makeError(code: ErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function resolveChromeId(tabIdMap: Map<string, number>, tabId: unknown): number {
  if (typeof tabId !== "string") {
    throw makeError("INVALID_PARAMS", "tab_id must be a string");
  }
  const chromeId = tabIdMap.get(tabId);
  if (chromeId === undefined) {
    throw makeError("TAB_NOT_FOUND", `no chrome tab for tab_id: ${tabId}`);
  }
  return chromeId;
}

function waitForLoadComplete(chromeTabId: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const listener = (id: number, changeInfo: chrome.tabs.TabChangeInfo): void => {
      if (id !== chromeTabId) return;
      if (changeInfo.status !== "complete") return;
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      reject(makeError("TIMEOUT", `navigation did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function readTabUrl(chromeTabId: number): Promise<string> {
  const tab = await chrome.tabs.get(chromeTabId);
  return tab.url ?? tab.pendingUrl ?? "";
}

/**
 * Injected into the target tab's MAIN world to check wait_for conditions
 * for text/ref modes in a single round trip. Returns which (if any) matched.
 *
 * "text" matches if the substring appears anywhere in document.body.innerText.
 * "ref" matches if the selector resolves to an element that is present,
 * connected, and has a non-zero bounding box (a minimal visibility proxy
 * consistent with the DOM-only v1 path — a fuller CDP-based visibility
 * check is deferred; see plan 04 for v2).
 */
function injectedCheckWaitFor(
  selector: string | null,
  text: string | null,
): { matched: "ref" | "text" | null } {
  if (text !== null) {
    const body = document.body;
    const hay = body === null ? "" : body.innerText;
    if (hay.includes(text)) return { matched: "text" };
  }
  if (selector !== null) {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (el !== null && el.isConnected) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return { matched: "ref" };
    }
  }
  return { matched: null };
}

export function registerNavigationHandlers(router: Router, opts: NavigationOpts): void {
  const { tabIdMap, refCache, network } = opts;

  router.register("browser_navigate", async (params): Promise<{ final_url: string }> => {
    const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
    const url = params["url"];
    if (typeof url !== "string") {
      throw makeError("INVALID_PARAMS", "url must be a string");
    }
    const waitForLoadRaw = params["wait_for_load"];
    const shouldWait = waitForLoadRaw !== false;
    await chrome.tabs.update(chromeId, { url });
    if (shouldWait) {
      await waitForLoadComplete(chromeId, NAVIGATE_TIMEOUT_MS);
    }
    const finalUrl = await readTabUrl(chromeId);
    return { final_url: finalUrl };
  });

  router.register("browser_back", async (params): Promise<{ final_url: string }> => {
    const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
    await chrome.tabs.goBack(chromeId);
    return { final_url: await readTabUrl(chromeId) };
  });

  router.register("browser_forward", async (params): Promise<{ final_url: string }> => {
    const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
    await chrome.tabs.goForward(chromeId);
    return { final_url: await readTabUrl(chromeId) };
  });

  router.register("browser_reload", async (params): Promise<{ final_url: string }> => {
    const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
    const hardRaw = params["hard"];
    const bypassCache = hardRaw === true;
    await chrome.tabs.reload(chromeId, { bypassCache });
    return { final_url: await readTabUrl(chromeId) };
  });

  router.register(
    "browser_wait_for",
    async (
      params,
    ): Promise<{ matched: "ref" | "text" | "url_pattern"; elapsed_ms: number }> => {
      const tabIdRaw = params["tab_id"];
      if (typeof tabIdRaw !== "string") {
        throw makeError("INVALID_PARAMS", "tab_id must be a string");
      }
      const chromeId = resolveChromeId(tabIdMap, tabIdRaw);
      const urlPattern = params["url_pattern"];
      const refRaw = params["ref"];
      const textRaw = params["text"];

      if (urlPattern === undefined && refRaw === undefined && textRaw === undefined) {
        throw makeError(
          "INVALID_PARAMS",
          "wait_for requires at least one of url_pattern, ref, text",
        );
      }
      if (urlPattern !== undefined && typeof urlPattern !== "string") {
        throw makeError("INVALID_PARAMS", "url_pattern must be a string");
      }
      if (textRaw !== undefined && typeof textRaw !== "string") {
        throw makeError("INVALID_PARAMS", "text must be a string");
      }
      if (refRaw !== undefined) {
        if (typeof refRaw !== "number" || !Number.isInteger(refRaw) || refRaw < 1) {
          throw makeError("INVALID_PARAMS", "ref must be a positive integer");
        }
      }

      const rawTimeout = params["timeout_ms"];
      const requestedTimeout = typeof rawTimeout === "number" && Number.isFinite(rawTimeout)
        ? rawTimeout
        : 10_000;
      const timeoutMs = Math.min(Math.max(requestedTimeout, 0), WAIT_FOR_TIMEOUT_CAP_MS);

      const rawPoll = params["poll_ms"];
      const requestedPoll = typeof rawPoll === "number" && Number.isFinite(rawPoll)
        ? rawPoll
        : WAIT_FOR_POLL_DEFAULT_MS;
      const pollMs = Math.min(
        Math.max(requestedPoll, WAIT_FOR_POLL_MIN_MS),
        WAIT_FOR_POLL_MAX_MS,
      );

      let regex: RegExp | undefined;
      if (typeof urlPattern === "string") {
        try {
          regex = new RegExp(urlPattern);
        } catch (err) {
          throw makeError(
            "INVALID_PARAMS",
            `url_pattern is not a valid regex: ${(err as Error).message}`,
          );
        }
      }

      let refSelector: string | null = null;
      if (typeof refRaw === "number") {
        const snap = refCache.get(tabIdRaw);
        if (snap === undefined) {
          throw makeError(
            "REF_STALE",
            `no a11y snapshot for tab ${tabIdRaw}; call browser_read first`,
          );
        }
        const entry = snap.entries.get(refRaw);
        if (entry === undefined) {
          throw makeError(
            "REF_NOT_FOUND",
            `ref ${refRaw} not present in current snapshot for ${tabIdRaw}`,
          );
        }
        refSelector = entry.selector;
      }
      const text = typeof textRaw === "string" ? textRaw : null;

      const started = Date.now();
      const deadline = started + timeoutMs;
      for (;;) {
        if (regex !== undefined) {
          const currentUrl = await readTabUrl(chromeId);
          if (regex.test(currentUrl)) {
            return { matched: "url_pattern", elapsed_ms: Date.now() - started };
          }
        }
        if (refSelector !== null || text !== null) {
          const results = (await chrome.scripting.executeScript({
            target: { tabId: chromeId },
            world: "MAIN",
            func: injectedCheckWaitFor,
            args: [refSelector, text],
          })) as chrome.scripting.InjectionResult[];
          const first = results[0];
          const matched = first?.result?.matched;
          if (matched === "ref" || matched === "text") {
            return { matched, elapsed_ms: Date.now() - started };
          }
        }
        if (Date.now() >= deadline) {
          throw makeError(
            "TIMEOUT",
            `wait_for did not match within ${timeoutMs}ms`,
          );
        }
        const remaining = deadline - Date.now();
        const sleep = Math.min(pollMs, Math.max(remaining, 0));
        if (sleep === 0) continue;
        await new Promise<void>((r) => setTimeout(r, sleep));
      }
    },
  );

  router.register(
    "browser_wait_for_idle",
    async (
      params,
    ): Promise<{ idle: true; elapsed_ms: number; peak_in_flight: number }> => {
      const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
      const quietRaw = params["quiet_ms"];
      const quietMs =
        typeof quietRaw === "number" && Number.isFinite(quietRaw) ? quietRaw : 500;
      const timeoutRaw = params["timeout_ms"];
      const requestedTimeout =
        typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) ? timeoutRaw : 10_000;
      const timeoutMs = Math.min(Math.max(requestedTimeout, 100), WAIT_FOR_TIMEOUT_CAP_MS);
      const started = Date.now();
      const deadline = started + timeoutMs;

      let peak = network.inFlight(chromeId);
      let quietSince: number | null = null;
      for (;;) {
        const current = network.inFlight(chromeId);
        if (current > peak) peak = current;
        const now = Date.now();
        if (current === 0) {
          if (quietSince === null) quietSince = now;
          if (now - quietSince >= quietMs) {
            return { idle: true, elapsed_ms: now - started, peak_in_flight: peak };
          }
        } else {
          quietSince = null;
        }
        if (now >= deadline) {
          throw makeError(
            "TIMEOUT",
            `wait_for_idle did not see ${quietMs}ms of quiet within ${timeoutMs}ms (current=${current}, peak=${peak})`,
          );
        }
        const remaining = deadline - now;
        const sleep = Math.min(100, Math.max(remaining, 0));
        if (sleep === 0) continue;
        await new Promise<void>((r) => setTimeout(r, sleep));
      }
    },
  );
}
