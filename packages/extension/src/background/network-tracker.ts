/**
 * Tracks in-flight HTTP requests per chrome tab via chrome.webRequest.
 * Consumed by browser.wait_for_idle to know when the network has quiesced.
 *
 * Limitations:
 *   - Redirects bump the count briefly (onBeforeRequest fires for the
 *     redirect target with the same requestId we already have; we treat
 *     each requestId as a unit). onBeforeRedirect does not close the old
 *     one, so counts are stable.
 *   - WebSocket frames don't show up here. Server-sent events terminate
 *     onCompleted on the initial request and look idle even when the
 *     stream is still flowing. The "quiet_ms" heuristic is deliberately
 *     permissive about those.
 */

export class NetworkTracker {
  private readonly perTab = new Map<number, Set<string>>();

  constructor() {
    const filter: chrome.webRequest.RequestFilter = { urls: ["<all_urls>"] };

    chrome.webRequest.onBeforeRequest.addListener((d) => {
      if (d.tabId < 0) return;
      let set = this.perTab.get(d.tabId);
      if (set === undefined) {
        set = new Set();
        this.perTab.set(d.tabId, set);
      }
      set.add(d.requestId);
    }, filter);

    const drop = (d: { tabId: number; requestId: string }): void => {
      if (d.tabId < 0) return;
      const set = this.perTab.get(d.tabId);
      if (set === undefined) return;
      set.delete(d.requestId);
      if (set.size === 0) this.perTab.delete(d.tabId);
    };
    chrome.webRequest.onCompleted.addListener(drop, filter);
    chrome.webRequest.onErrorOccurred.addListener(drop, filter);
  }

  inFlight(chromeTabId: number): number {
    return this.perTab.get(chromeTabId)?.size ?? 0;
  }

  forgetTab(chromeTabId: number): void {
    this.perTab.delete(chromeTabId);
  }
}
