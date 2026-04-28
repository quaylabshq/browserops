/**
 * In-memory map of tab_id → active auto-teach binding.
 *
 * Lives in the daemon runtime alongside AutoTeachStore. The MCP
 * dispatch pipeline consults this map after every browser_* call: if
 * the call's tab_id is bound, the call is appended to the session's
 * trace.jsonl with the binding's current run_index.
 *
 * Bindings are explicit — set by procedures_autoteach_attach,
 * cleared by procedures_autoteach_record_trace (or replaced when the
 * agent re-attaches the same session to a different tab). The bridge
 * never auto-binds: explore mode requires the agent to call attach
 * before driving the browser.
 */

export interface AutoTeachBinding {
  session_id: string;
  run_index: number;
}

export class AutoTeachBindings {
  private byTab = new Map<string, AutoTeachBinding>();

  attach(tabId: string, sessionId: string, runIndex: number): void {
    this.byTab.set(tabId, { session_id: sessionId, run_index: runIndex });
  }

  /** Detach a single tab. Idempotent. */
  detachTab(tabId: string): void {
    this.byTab.delete(tabId);
  }

  /** Detach every tab bound to a session. Used by record_trace. */
  detachSession(sessionId: string): void {
    for (const [tabId, b] of this.byTab) {
      if (b.session_id === sessionId) this.byTab.delete(tabId);
    }
  }

  get(tabId: string): AutoTeachBinding | undefined {
    return this.byTab.get(tabId);
  }

  /** Test helper — current binding count. */
  size(): number {
    return this.byTab.size;
  }
}
