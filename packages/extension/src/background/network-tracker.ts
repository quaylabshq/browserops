/**
 * Tracks in-flight HTTP requests per chrome tab via chrome.webRequest.
 * Consumed by browser_wait_for_idle to know when the network has quiesced.
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

interface PerTabState {
  inFlight: Set<string>;
  totalStarted: number;
  totalCompleted: number;
}

export interface NetworkSnapshot {
  totalStarted: number;
  totalCompleted: number;
  inFlight: number;
}

export class NetworkTracker {
  private readonly perTab = new Map<number, PerTabState>();

  constructor() {
    const filter: chrome.webRequest.RequestFilter = { urls: ["<all_urls>"] };

    chrome.webRequest.onBeforeRequest.addListener((d) => {
      this._onBeforeRequest(d);
    }, filter);

    const drop = (d: { tabId: number; requestId: string }): void => {
      this._onCompleted(d);
    };
    chrome.webRequest.onCompleted.addListener(drop, filter);
    chrome.webRequest.onErrorOccurred.addListener(drop, filter);

    chrome.tabs.onRemoved.addListener((tabId) => {
      this.perTab.delete(tabId);
    });
  }

  /** @internal exposed for testing */
  _onBeforeRequest(d: { tabId: number; requestId: string }): void {
    if (d.tabId < 0) return;
    let state = this.perTab.get(d.tabId);
    if (state === undefined) {
      state = { inFlight: new Set(), totalStarted: 0, totalCompleted: 0 };
      this.perTab.set(d.tabId, state);
    }
    state.inFlight.add(d.requestId);
    state.totalStarted++;
  }

  /** @internal exposed for testing */
  _onCompleted(d: { tabId: number; requestId: string }): void {
    if (d.tabId < 0) return;
    const state = this.perTab.get(d.tabId);
    if (state === undefined) return;
    state.inFlight.delete(d.requestId);
    state.totalCompleted++;
    if (state.inFlight.size === 0 && state.totalStarted === state.totalCompleted) {
      // Keep the state so counters survive even when idle — only forgetTab / tab close clears it.
    }
  }

  inFlight(chromeTabId: number): number {
    return this.perTab.get(chromeTabId)?.inFlight.size ?? 0;
  }

  snapshot(chromeTabId: number): NetworkSnapshot {
    const state = this.perTab.get(chromeTabId);
    if (state === undefined) {
      return { totalStarted: 0, totalCompleted: 0, inFlight: 0 };
    }
    return {
      totalStarted: state.totalStarted,
      totalCompleted: state.totalCompleted,
      inFlight: state.inFlight.size,
    };
  }

  forgetTab(chromeTabId: number): void {
    this.perTab.delete(chromeTabId);
  }
}
