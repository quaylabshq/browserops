/**
 * Minimal chrome.debugger wrapper. Attach/detach is reference-counted with
 * an idle detach so multiple back-to-back ops on the same tab don't flash
 * the "being controlled by automation" banner N times.
 *
 * Tabs can be flagged as "persistent" via setPersistent() — the debugger
 * stays attached until explicitly disabled or the tab is closed. Used for
 * canvas apps (Figma, Google Docs) where all input must go through CDP.
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

/** Domains where all input must go through CDP (canvas-rendered UIs).
 *  Keep this list narrow: only sites whose primary surface is a <canvas>
 *  element, where synthetic DOM events have no reachable target. Chat and
 *  rich-editor sites (Slack, Notion, Linear, Discord, Gmail) work with
 *  synthetic dispatch and use the auto-escalation rescue path on the rare
 *  failure — adding them here would force the "controlled by automation"
 *  banner unnecessarily. */
const AUTO_CDP_DOMAINS: readonly RegExp[] = [
  /^docs\.google\.com$/,
  /^sheets\.google\.com$/,
  /^(www\.)?figma\.com$/,
  /(\.|^)canva\.com$/,
  /^miro\.com$/,
  /(\.|^)whimsical\.com$/,
  /^figjam\.com$/,
  /(\.|^)lucid\.app$/,
  /(\.|^)lucidchart\.com$/,
  /^app\.diagrams\.net$/,
  /(\.|^)tldraw\.com$/,
];

export class CdpManager {
  private readonly attached = new Map<number, AttachState>();
  private readonly external = new Set<number>();
  private readonly persistent = new Set<number>();

  constructor() {
    // External detach (user clicked the "Cancel" banner, DevTools opened,
    // tab crashed). Clear our bookkeeping so we attempt a fresh attach on
    // the next op rather than assuming the last state.
    chrome.debugger.onDetach.addListener((source, reason) => {
      const id = source.tabId;
      if (id === undefined) return;
      if (reason !== "target_closed") this.external.add(id);
      this.attached.delete(id);
      this.persistent.delete(id);
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

  /** Whether this tab has persistent CDP attachment. */
  isPersistent(chromeTabId: number): boolean {
    return this.persistent.has(chromeTabId);
  }

  /** Enable or disable persistent CDP for a tab. When enabled, the debugger
   *  attaches immediately and won't auto-detach on idle. */
  async setPersistent(chromeTabId: number, enabled: boolean): Promise<void> {
    if (enabled) {
      this.persistent.add(chromeTabId);
      const state = await this.ensureAttached(chromeTabId);
      if (state.detachTimer !== null) {
        clearTimeout(state.detachTimer);
        state.detachTimer = null;
      }
    } else {
      this.persistent.delete(chromeTabId);
      this.scheduleDetach(chromeTabId);
    }
  }

  /** Remove persistent flag without detaching (for tab removal). */
  clearPersistent(chromeTabId: number): void {
    this.persistent.delete(chromeTabId);
  }

  /** Auto-enable persistent CDP if the URL is a known canvas domain.
   *  Call after navigation completes. No-op for non-matching URLs. */
  async autoAttachIfCanvas(chromeTabId: number, url: string): Promise<void> {
    let hostname: string;
    try { hostname = new URL(url).hostname; } catch { return; }
    const match = AUTO_CDP_DOMAINS.some((re) => re.test(hostname));
    if (match && !this.persistent.has(chromeTabId)) {
      await this.setPersistent(chromeTabId, true).catch(() => { /* ignore attach failures */ });
    } else if (!match && this.persistent.has(chromeTabId)) {
      // Navigated away from a canvas site — disable persistent CDP.
      await this.setPersistent(chromeTabId, false);
    }
  }

  /** Auto-enable persistent CDP for any http(s) navigation. This is the
   *  trusted-input default — every regular web page the agent drives
   *  gets CDP so click/type/press/hover go through Input.dispatchMouseEvent
   *  rather than synthetic DOM events. The "Chrome is being controlled by
   *  automated test software" banner appears as a result; callers wanting
   *  to opt a specific tab out can issue browser_set_cdp(tab_id, false).
   *
   *  No-op for chrome://, about:, file://, devtools:// — attaching to
   *  those either fails or has no useful effect. Skips when already
   *  persistent (idempotent). Detaches when the tab leaves http(s)
   *  (e.g. navigates to chrome://settings), keeping bookkeeping accurate. */
  async autoAttachAlways(chromeTabId: number, url: string): Promise<void> {
    let protocol: string;
    try { protocol = new URL(url).protocol; } catch { return; }
    const eligible = protocol === "http:" || protocol === "https:";
    if (eligible && !this.persistent.has(chromeTabId)) {
      await this.setPersistent(chromeTabId, true).catch(() => { /* ignore attach failures */ });
    } else if (!eligible && this.persistent.has(chromeTabId)) {
      await this.setPersistent(chromeTabId, false);
    }
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
    if (this.persistent.has(chromeTabId)) return;
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
