/**
 * Capability F — capture-signal detection: detectRoadblock fires/doesn't fire on various inputs.
 */
import type { TraceEntry } from "../../../packages/bridge/src/memory/trace.js";
import { detectRoadblock } from "../../../packages/bridge/src/memory/capture-signals.js";
import { check, defineEval } from "../harness.js";

/** Build a TraceEntry with defaults for optional fields. */
function traceEntry(overrides: Partial<TraceEntry> & Pick<TraceEntry, "method" | "effect_summary">): TraceEntry {
  return {
    origin: "https://www.example.com",
    ts: new Date().toISOString(),
    ...overrides,
  };
}

defineEval({
  id: "F1",
  capability: "signals",
  title: "detectRoadblock fires on WRITE_NOT_REFLECTED error code",
  run() {
    const current = {
      method: "browser_type",
      origin: "https://www.example.com",
      error_code: "WRITE_NOT_REFLECTED",
      effect_summary: "no-op",
    };
    const hint = detectRoadblock([], current);
    check(hint !== null, "should detect roadblock on WRITE_NOT_REFLECTED");
    check(
      hint!.signals.some((s) => s.includes("WRITE_NOT_REFLECTED")),
      `signals should mention WRITE_NOT_REFLECTED, got: ${JSON.stringify(hint!.signals)}`,
    );
  },
});

defineEval({
  id: "F2",
  capability: "signals",
  title: "detectRoadblock fires on USER_DECLINED error code",
  run() {
    const current = {
      method: "browser_click",
      origin: "https://www.example.com",
      error_code: "USER_DECLINED",
      effect_summary: "no-op",
    };
    const hint = detectRoadblock([], current);
    check(hint !== null, "should detect roadblock on USER_DECLINED");
    check(
      hint!.signals.some((s) => s.includes("USER_DECLINED")),
      `signals should mention USER_DECLINED, got: ${JSON.stringify(hint!.signals)}`,
    );
  },
});

defineEval({
  id: "F3",
  capability: "signals",
  title: "detectRoadblock fires on no-op effect after an action method",
  run() {
    const current = {
      method: "browser_click",
      origin: "https://www.example.com",
      // no error_code — but effect_summary is no-op
      effect_summary: "no-op",
    };
    const hint = detectRoadblock([], current);
    check(hint !== null, "should detect roadblock on no-op action");
    check(
      hint!.signals.some((s) => s.includes("no-op-after-action")),
      `signals should mention no-op-after-action, got: ${JSON.stringify(hint!.signals)}`,
    );
  },
});

defineEval({
  id: "F4",
  capability: "signals",
  title: "detectRoadblock fires on timeout/wait failure cluster (≥2 TIMEOUT errors in window)",
  run() {
    const origin = "https://www.example.com";
    // Two TIMEOUT errors in the trace window
    const recentTrace = [
      traceEntry({ method: "browser_wait_for", origin, error_code: "TIMEOUT", effect_summary: "no-op" }),
      traceEntry({ method: "browser_wait_for", origin, error_code: "TIMEOUT", effect_summary: "no-op" }),
    ];
    const current = {
      method: "browser_observe",
      origin,
      effect_summary: "none",
    };
    const hint = detectRoadblock(recentTrace, current);
    check(hint !== null, "should detect roadblock on timeout cluster");
    check(
      hint!.signals.some((s) => s.includes("timeout-cluster")),
      `signals should mention timeout-cluster, got: ${JSON.stringify(hint!.signals)}`,
    );
  },
});

defineEval({
  id: "F5",
  capability: "signals",
  title: "detectRoadblock fires on repeated retry: same (origin, method) ≥3 times in window",
  run() {
    const origin = "https://www.example.com";
    const method = "browser_click";
    // Two prior entries with same origin+method
    const recentTrace = [
      traceEntry({ method, origin, effect_summary: "no-op" }),
      traceEntry({ method, origin, effect_summary: "no-op" }),
    ];
    // Current call = third attempt
    const current = {
      method,
      origin,
      effect_summary: "no-op",
    };
    const hint = detectRoadblock(recentTrace, current);
    check(hint !== null, "should detect roadblock on repeated retry");
    check(
      hint!.signals.some((s) => s.includes("repeated")),
      `signals should mention repeated, got: ${JSON.stringify(hint!.signals)}`,
    );
  },
});

defineEval({
  id: "F6",
  capability: "signals",
  title: "detectRoadblock does NOT fire on benign read (browser_read, no-op effect, no error)",
  run() {
    // A browser_read with no-op effect_summary should NOT fire — reads are not actions
    const current = {
      method: "browser_read",
      origin: "https://www.example.com",
      // no error_code
      effect_summary: "no-op",
    };
    const hint = detectRoadblock([], current);
    check(hint === null, "should NOT fire on benign browser_read with no-op effect");
  },
});

defineEval({
  id: "F7",
  capability: "signals",
  title: "detectRoadblock fires on ELEMENT_NOT_ACTIONABLE and LOCATOR_NOT_FOUND error codes",
  run() {
    const origin = "https://www.example.com";

    // ELEMENT_NOT_ACTIONABLE
    const hintActionable = detectRoadblock([], {
      method: "browser_click",
      origin,
      error_code: "ELEMENT_NOT_ACTIONABLE",
      effect_summary: "no-op",
    });
    check(hintActionable !== null, "should detect ELEMENT_NOT_ACTIONABLE");

    // LOCATOR_NOT_FOUND
    const hintLocator = detectRoadblock([], {
      method: "browser_click",
      origin,
      error_code: "LOCATOR_NOT_FOUND",
      effect_summary: "no-op",
    });
    check(hintLocator !== null, "should detect LOCATOR_NOT_FOUND");
  },
});
