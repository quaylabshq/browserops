import { NAVIGATE_TIMEOUT_MS, WAIT_FOR_TIMEOUT_CAP_MS, type ErrorCode } from "@browserops/shared";
import type { Router } from "../router.js";

interface NavigationOpts {
  tabIdMap: Map<string, number>;
}

const WAIT_FOR_POLL_MS = 250;

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

export function registerNavigationHandlers(router: Router, opts: NavigationOpts): void {
  const { tabIdMap } = opts;

  router.register("navigate", async (params): Promise<{ final_url: string }> => {
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

  router.register("back", async (params): Promise<Record<string, never>> => {
    const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
    await chrome.tabs.goBack(chromeId);
    return {};
  });

  router.register("forward", async (params): Promise<Record<string, never>> => {
    const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
    await chrome.tabs.goForward(chromeId);
    return {};
  });

  router.register("reload", async (params): Promise<Record<string, never>> => {
    const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
    const hardRaw = params["hard"];
    const bypassCache = hardRaw === true;
    await chrome.tabs.reload(chromeId, { bypassCache });
    return {};
  });

  router.register(
    "wait_for",
    async (params): Promise<{ matched: "url_pattern"; elapsed_ms: number }> => {
      const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
      const urlPattern = params["url_pattern"];
      const ref = params["ref"];
      const text = params["text"];

      if (ref !== undefined || text !== undefined) {
        throw makeError("INTERNAL", "wait_for: ref/text modes not implemented in v1");
      }
      if (typeof urlPattern !== "string") {
        throw makeError("INVALID_PARAMS", "wait_for requires url_pattern in v1");
      }

      const rawTimeout = params["timeout_ms"];
      const requested = typeof rawTimeout === "number" && Number.isFinite(rawTimeout)
        ? rawTimeout
        : 10_000;
      const timeoutMs = Math.min(Math.max(requested, 0), WAIT_FOR_TIMEOUT_CAP_MS);

      let regex: RegExp;
      try {
        regex = new RegExp(urlPattern);
      } catch (err) {
        throw makeError(
          "INVALID_PARAMS",
          `url_pattern is not a valid regex: ${(err as Error).message}`,
        );
      }

      const started = Date.now();
      const deadline = started + timeoutMs;
      for (;;) {
        const currentUrl = await readTabUrl(chromeId);
        if (regex.test(currentUrl)) {
          return { matched: "url_pattern", elapsed_ms: Date.now() - started };
        }
        if (Date.now() >= deadline) {
          throw makeError(
            "TIMEOUT",
            `wait_for url_pattern did not match within ${timeoutMs}ms`,
          );
        }
        const remaining = deadline - Date.now();
        const sleep = Math.min(WAIT_FOR_POLL_MS, Math.max(remaining, 0));
        if (sleep === 0) continue;
        await new Promise<void>((r) => setTimeout(r, sleep));
      }
    },
  );
}
