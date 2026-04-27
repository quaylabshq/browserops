import type { TeachEvent, TeachScope, TeachStep } from "@browserops/shared";
import { captureEventsScript } from "../content/capture-events.js";

const STORAGE_KEY = "teach_session";

interface ActiveSession {
  session_id: string;
  scope: TeachScope;
  started_at: number;
  narration_hint?: string;
  /** Monotonic event sequence — last assigned. */
  seq: number;
}

export interface TeachRecorderDeps {
  resolveTabId: (chromeTabId: number) => string | undefined;
  emit: (ev: TeachEvent) => void;
  /** Notify popup/options pages when start/stop changes. */
  onStatusChanged: () => void;
}

export interface TeachStatus {
  active: boolean;
  session_id?: string;
  scope?: TeachScope;
  event_count?: number;
  started_at?: number;
  narration_hint?: string;
}

/**
 * Owns the lifecycle of a single in-flight teach session in the extension.
 *
 * - start() generates a session_id, persists it to chrome.storage.session
 *   (so the SW can be killed and revived without losing the active session),
 *   and injects the capture content script into every existing tab.
 * - onCapturedStep() is called by the central runtime.onMessage listener for
 *   each captured action, assigns a monotonic seq, and pushes a TeachEvent
 *   over the WebSocket Event channel.
 * - stop() detaches all content scripts and clears persisted state.
 *
 * State across SW restarts: the active session is rehydrated from
 * chrome.storage.session on boot. Content scripts are re-injected by
 * webNavigation.onCommitted (already wired in background/index.ts) and by
 * tabs.onCreated, so we don't need to re-walk all tabs after rehydrate.
 */
export class TeachRecorder {
  private active: ActiveSession | null = null;
  private readonly deps: TeachRecorderDeps;

  constructor(deps: TeachRecorderDeps) {
    this.deps = deps;
  }

  async rehydrate(): Promise<void> {
    const s = await chrome.storage.session.get(STORAGE_KEY);
    const v = s[STORAGE_KEY];
    if (
      typeof v === "object" &&
      v !== null &&
      typeof (v as Record<string, unknown>)["session_id"] === "string"
    ) {
      this.active = v as ActiveSession;
    }
  }

  isActive(): boolean {
    return this.active !== null;
  }

  status(): TeachStatus {
    if (this.active === null) return { active: false };
    const out: TeachStatus = {
      active: true,
      session_id: this.active.session_id,
      scope: this.active.scope,
      event_count: this.active.seq,
      started_at: this.active.started_at,
    };
    if (this.active.narration_hint !== undefined) {
      out.narration_hint = this.active.narration_hint;
    }
    return out;
  }

  /** Start a session — idempotent: returns the in-flight session if any. */
  async start(
    scope: TeachScope,
    narrationHint?: string,
  ): Promise<{ session_id: string; started_at: number; resumed: boolean }> {
    if (this.active !== null) {
      return {
        session_id: this.active.session_id,
        started_at: this.active.started_at,
        resumed: true,
      };
    }
    const session_id = `ts_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const started_at = Date.now();
    this.active = { session_id, scope, started_at, seq: 0 };
    if (narrationHint !== undefined) this.active.narration_hint = narrationHint;
    await this.persist();
    await this.injectAllTabs();
    this.deps.onStatusChanged();
    return { session_id, started_at, resumed: false };
  }

  async stop(): Promise<{
    session_id: string;
    event_count: number;
    duration_ms: number;
  } | null> {
    if (this.active === null) return null;
    const a = this.active;
    this.active = null;
    await chrome.storage.session.remove(STORAGE_KEY);
    await this.detachAll();
    this.deps.onStatusChanged();
    return {
      session_id: a.session_id,
      event_count: a.seq,
      duration_ms: Date.now() - a.started_at,
    };
  }

  /**
   * Routed from background/index.ts when a content script reports an action.
   * Assigns a sequence number and pushes a TeachEvent.
   */
  onCapturedStep(chromeTabId: number, url: string, step: TeachStep, ts: number): void {
    if (this.active === null) return;
    const tab_id = this.deps.resolveTabId(chromeTabId) ?? `chrome:${chromeTabId}`;
    this.active.seq += 1;
    const ev: TeachEvent = {
      session_id: this.active.session_id,
      seq: this.active.seq,
      ts,
      tab_id,
      url,
      step,
    };
    void this.persist();
    this.deps.emit(ev);
  }

  /** Insert a synthetic narration step (popup-driven). */
  recordNarration(text: string): void {
    this.recordSynthetic({ kind: "narration", text });
  }

  /** Insert a synthetic split marker (popup-driven). */
  recordMarker(label?: string): void {
    const step: TeachStep = label !== undefined ? { kind: "marker", label } : { kind: "marker" };
    this.recordSynthetic(step);
  }

  /**
   * Re-inject the capture script into a tab that just navigated or was just
   * created. Called from chrome.webNavigation / chrome.tabs listeners in
   * background/index.ts.
   */
  async maybeInject(chromeTabId: number): Promise<void> {
    if (this.active === null) return;
    await this.injectInto(chromeTabId);
  }

  private recordSynthetic(step: TeachStep): void {
    if (this.active === null) return;
    this.active.seq += 1;
    const ev: TeachEvent = {
      session_id: this.active.session_id,
      seq: this.active.seq,
      ts: Date.now(),
      tab_id: "popup",
      url: "",
      step,
    };
    void this.persist();
    this.deps.emit(ev);
  }

  private async persist(): Promise<void> {
    if (this.active === null) return;
    await chrome.storage.session.set({ [STORAGE_KEY]: this.active });
  }

  private async injectAllTabs(): Promise<void> {
    if (this.active === null) return;
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(
      tabs.map((t) =>
        t.id !== undefined ? this.injectInto(t.id) : Promise.resolve(),
      ),
    );
  }

  private async injectInto(chromeTabId: number): Promise<void> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: chromeTabId, allFrames: false },
        func: captureEventsScript,
        world: "ISOLATED",
        injectImmediately: true,
      });
    } catch {
      // chrome:// tabs, the web store, and discarded tabs reject injection.
      // Silent — those tabs simply won't capture.
    }
  }

  private async detachAll(): Promise<void> {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(
      tabs.map((t) => {
        if (t.id === undefined) return Promise.resolve();
        return chrome.tabs
          .sendMessage(t.id, { type: "teach_stop_capture" })
          .catch(() => {});
      }),
    );
  }
}
