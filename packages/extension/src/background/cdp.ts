/**
 * Minimal chrome.debugger wrapper for "trusted input" modes on browser.click
 * and browser.type. Attach/detach is reference-counted with an idle detach so
 * multiple back-to-back ops on the same tab don't flash the "being controlled
 * by automation" banner N times.
 *
 * The chrome.debugger permission is declared in manifest.ts. When Chrome's
 * DevTools (or another extension) attaches to the same tab, our attach fails
 * with "Another debugger is already attached"; callers should treat that as
 * CDP_ATTACH_FAILED and surface to the user.
 */

const PROTOCOL_VERSION = "1.3";
const IDLE_DETACH_MS = 5_000;

interface AttachState {
  inflight: number;
  detachTimer: ReturnType<typeof setTimeout> | null;
}

export class CdpManager {
  private readonly attached = new Map<number, AttachState>();
  private readonly external = new Set<number>();

  constructor() {
    // External detach (user clicked the "Cancel" banner, DevTools opened,
    // tab crashed). Clear our bookkeeping so we attempt a fresh attach on
    // the next op rather than assuming the last state.
    chrome.debugger.onDetach.addListener((source, reason) => {
      const id = source.tabId;
      if (id === undefined) return;
      if (reason !== "target_closed") this.external.add(id);
      this.attached.delete(id);
    });
  }

  /** Run `fn` while the debugger is attached to `chromeTabId`. The attach
   *  is shared across concurrent callers; detach schedules after idle. */
  async withAttach<T>(chromeTabId: number, fn: () => Promise<T>): Promise<T> {
    const state = await this.ensureAttached(chromeTabId);
    state.inflight += 1;
    if (state.detachTimer !== null) {
      clearTimeout(state.detachTimer);
      state.detachTimer = null;
    }
    try {
      return await fn();
    } finally {
      state.inflight -= 1;
      this.scheduleDetach(chromeTabId);
    }
  }

  /** Send a CDP command to a tab we're already attached to (caller is
   *  responsible for holding an attach via withAttach). */
  async send<T = unknown>(
    chromeTabId: number,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return (await chrome.debugger.sendCommand(
      { tabId: chromeTabId },
      method,
      params,
    )) as T;
  }

  private async ensureAttached(chromeTabId: number): Promise<AttachState> {
    const existing = this.attached.get(chromeTabId);
    if (existing !== undefined) return existing;
    try {
      await chrome.debugger.attach({ tabId: chromeTabId }, PROTOCOL_VERSION);
    } catch (err) {
      const msg = (err as Error | undefined)?.message ?? "attach failed";
      const coded = new Error(`CDP attach failed for tab ${chromeTabId}: ${msg}`) as Error & {
        code?: string;
      };
      coded.code = "CDP_ATTACH_FAILED";
      throw coded;
    }
    const state: AttachState = { inflight: 0, detachTimer: null };
    this.attached.set(chromeTabId, state);
    return state;
  }

  private scheduleDetach(chromeTabId: number): void {
    const state = this.attached.get(chromeTabId);
    if (state === undefined) return;
    if (state.inflight > 0) return;
    if (state.detachTimer !== null) return;
    state.detachTimer = setTimeout(() => {
      this.detach(chromeTabId).catch(() => {
        /* ignore — state already cleaned in onDetach */
      });
    }, IDLE_DETACH_MS);
  }

  private async detach(chromeTabId: number): Promise<void> {
    const state = this.attached.get(chromeTabId);
    if (state === undefined) return;
    this.attached.delete(chromeTabId);
    try {
      await chrome.debugger.detach({ tabId: chromeTabId });
    } catch {
      /* already gone; chrome.debugger.onDetach will have fired */
    }
  }
}
