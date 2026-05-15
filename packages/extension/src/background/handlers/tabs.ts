import { matchGatedDomain, GATED_DOMAIN_DIRECTIVE, type ErrorCode } from "@browserops/shared";
import { getGatedDomainPatterns } from "../gated-state.js";
import type { Router } from "../router.js";
import type { CdpManager } from "../cdp.js";

interface TabsOpts {
  tabIdMap: Map<string, number>;
  chromeIdToTabId: Map<number, string>;
  cdp: CdpManager;
}

interface TabSummary {
  tab_id: string;
  url: string;
  title: string;
  active: boolean;
  window_id: number;
  index: number;
  gated_domain?: true;
  gated_domain_directive?: string;
}

const NEW_TAB_ASSIGN_POLL_MS = 25;
const NEW_TAB_ASSIGN_TIMEOUT_MS = 2_000;

function makeError(code: ErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function toSummary(tab: chrome.tabs.Tab, tabId: string): TabSummary {
  return {
    tab_id: tabId,
    url: tab.url ?? tab.pendingUrl ?? "",
    title: tab.title ?? "",
    active: tab.active,
    window_id: tab.windowId,
    index: tab.index,
  };
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

async function waitForTabIdAssignment(
  chromeIdToTabId: Map<number, string>,
  chromeTabId: number,
): Promise<string> {
  const deadline = Date.now() + NEW_TAB_ASSIGN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const tabId = chromeIdToTabId.get(chromeTabId);
    if (tabId !== undefined) return tabId;
    await new Promise<void>((r) => setTimeout(r, NEW_TAB_ASSIGN_POLL_MS));
  }
  throw makeError("TIMEOUT", `timed out awaiting tab_id assignment for chrome tab ${chromeTabId}`);
}

export function registerTabHandlers(router: Router, opts: TabsOpts): void {
  const { tabIdMap, chromeIdToTabId, cdp } = opts;

  router.register("browser_list_tabs", async (): Promise<{ tabs: TabSummary[] }> => {
    const tabs = await chrome.tabs.query({});
    const summaries: TabSummary[] = [];
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      const tabId = chromeIdToTabId.get(tab.id);
      if (tabId === undefined) continue;
      summaries.push(toSummary(tab, tabId));
    }
    return { tabs: summaries };
  });

  router.register("browser_current_tab", async (): Promise<TabSummary> => {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (tab === undefined || tab.id === undefined) {
      throw makeError("TAB_NOT_FOUND", "no active tab in focused window");
    }
    const tabId = chromeIdToTabId.get(tab.id);
    if (tabId === undefined) {
      throw makeError("TAB_NOT_FOUND", `active tab ${tab.id} has no bridge tab_id yet`);
    }
    const summary = toSummary(tab, tabId);
    const url = tab.url ?? tab.pendingUrl ?? "";
    if (matchGatedDomain(url, getGatedDomainPatterns())) {
      return { ...summary, gated_domain: true, gated_domain_directive: GATED_DOMAIN_DIRECTIVE };
    }
    return summary;
  });

  router.register("browser_new_tab", async (params): Promise<{ tab_id: string; url?: string }> => {
    const rawUrl = params["url"];
    const rawActive = params["active"];
    const createProps: chrome.tabs.CreateProperties = {};
    if (typeof rawUrl === "string") createProps.url = rawUrl;
    if (typeof rawActive === "boolean") createProps.active = rawActive;
    const created = await chrome.tabs.create(createProps);
    if (created.id === undefined) {
      throw makeError("INTERNAL", "chrome.tabs.create returned a tab without an id");
    }
    const tabId = await waitForTabIdAssignment(chromeIdToTabId, created.id);
    const url = created.url ?? created.pendingUrl;
    // Match browser_navigate: attach CDP for any http(s) tab so subsequent
    // input dispatch is trusted. Skipped automatically for chrome:// / about:.
    if (created.id !== undefined && typeof url === "string" && url.length > 0) {
      void cdp.autoAttachAlways(created.id, url);
    }
    return url !== undefined && url !== "" ? { tab_id: tabId, url } : { tab_id: tabId };
  });

  router.register("browser_close_tab", async (params): Promise<{ closed: true }> => {
    const chromeId = resolveChromeId(tabIdMap, params["tab_id"]);
    await chrome.tabs.remove(chromeId);
    return { closed: true };
  });

  router.register(
    "browser_switch_tab",
    async (params): Promise<{ tab_id: string; active: true }> => {
      const tabIdParam = params["tab_id"];
      if (typeof tabIdParam !== "string") {
        throw makeError("INVALID_PARAMS", "tab_id must be a string");
      }
      const chromeId = resolveChromeId(tabIdMap, tabIdParam);
      const updated = await chrome.tabs.update(chromeId, { active: true });
      if (updated === undefined) {
        throw makeError("TAB_NOT_FOUND", `chrome.tabs.update returned no tab for ${chromeId}`);
      }
      try {
        await chrome.windows.update(updated.windowId, { focused: true });
      } catch (err) {
        // Window may have been closed between update calls; surface as TAB_NOT_FOUND
        // rather than INTERNAL so callers can treat it as a routine recovery case.
        throw makeError(
          "TAB_NOT_FOUND",
          `failed to focus window ${updated.windowId}: ${(err as Error).message}`,
        );
      }
      return { tab_id: tabIdParam, active: true };
    },
  );
}
