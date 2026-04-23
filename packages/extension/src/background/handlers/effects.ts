import { type PageEffect } from "@browserops/shared";
import { NetworkTracker } from "../network-tracker.js";
import { execInTab } from "./input.js";

export interface EffectObservationConfig {
  chromeTabId: number;
  windowMs?: number; // default 300
  networkTracker: NetworkTracker;
}

// ---------------------------------------------------------------------------
// Injected functions — run in the page's MAIN world. No module-scope closure.
// Note: focus-selector logic is duplicated in both injected functions because
// injected code cannot reference any module-scope helpers.
// ---------------------------------------------------------------------------

/**
 * Injected into the page during the install phase.
 * Creates a MutationObserver and stores it under a per-call token global.
 * Returns the baseline URL and focused element selector.
 */
function injectedInstallObserver(
  token: string,
): { url: string; focus_selector: string | null } {
  const key = `__browserops_effect_${token}__` as keyof Window;
  const state = {
    added: 0,
    removed: 0,
    attr_changes: 0,
    text_changes: 0,
    truncated: false,
    obs: null as MutationObserver | null,
  };

  const CAP = 10_000;

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === "childList") {
        if (state.added < CAP) {
          state.added += rec.addedNodes.length;
          if (state.added >= CAP) { state.added = CAP; state.truncated = true; }
        }
        if (state.removed < CAP) {
          state.removed += rec.removedNodes.length;
          if (state.removed >= CAP) { state.removed = CAP; state.truncated = true; }
        }
      } else if (rec.type === "attributes") {
        if (state.attr_changes < CAP) {
          state.attr_changes++;
          if (state.attr_changes >= CAP) state.truncated = true;
        }
      } else if (rec.type === "characterData") {
        if (state.text_changes < CAP) {
          state.text_changes++;
          if (state.text_changes >= CAP) state.truncated = true;
        }
      }
    }
  });

  observer.observe(document.documentElement ?? document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });

  state.obs = observer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any)[key] = state;

  // Defined inline here so it runs in MAIN world (cannot reference outer module scope)
  const active = document.activeElement;
  let focus_selector: string | null = null;
  if (active !== null && active !== document.body && active !== document.documentElement) {
    const parts: string[] = [];
    let node: Element | null = active;
    while (node !== null && node !== document.documentElement && node !== document.body) {
      const id = node.id;
      if (id) {
        parts.unshift(`#${CSS.escape(id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent !== null) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === (node as Element).tagName,
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          parts.unshift(`${tag}:nth-child(${idx})`);
        } else {
          parts.unshift(tag);
        }
      } else {
        parts.unshift(tag);
      }
      node = node.parentElement;
    }
    focus_selector = parts.length > 0 ? parts.join(" > ") : null;
  }

  return { url: location.href, focus_selector };
}

/**
 * Injected into the page during the read phase.
 * Reads the accumulated mutation counts, disconnects the observer, and cleans up.
 * Returns a snapshot of the DOM changes plus current URL and focus selector.
 */
function injectedReadObserver(token: string): {
  dom: { added: number; removed: number; attr_changes: number; text_changes: number };
  url: string;
  focus_selector: string | null;
  truncated: boolean;
} {
  const key = `__browserops_effect_${token}__` as keyof Window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = (window as any)[key] as {
    added: number;
    removed: number;
    attr_changes: number;
    text_changes: number;
    truncated: boolean;
    obs: MutationObserver | null;
  } | undefined;

  if (!state) {
    // Fail-soft: observer was never installed or was already cleaned up
    return {
      dom: { added: 0, removed: 0, attr_changes: 0, text_changes: 0 },
      url: location.href,
      focus_selector: null,
      truncated: true,
    };
  }

  try {
    state.obs?.disconnect();
  } catch {
    /* best-effort disconnect */
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any)[key];

  const active = document.activeElement;
  let focus_selector: string | null = null;
  if (active !== null && active !== document.body && active !== document.documentElement) {
    const parts: string[] = [];
    let node: Element | null = active;
    while (node !== null && node !== document.documentElement && node !== document.body) {
      const id = node.id;
      if (id) {
        parts.unshift(`#${CSS.escape(id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent !== null) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === (node as Element).tagName,
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          parts.unshift(`${tag}:nth-child(${idx})`);
        } else {
          parts.unshift(tag);
        }
      } else {
        parts.unshift(tag);
      }
      node = node.parentElement;
    }
    focus_selector = parts.length > 0 ? parts.join(" > ") : null;
  }

  return {
    dom: {
      added: state.added,
      removed: state.removed,
      attr_changes: state.attr_changes,
      text_changes: state.text_changes,
    },
    url: location.href,
    focus_selector,
    truncated: state.truncated,
  };
}

// ---------------------------------------------------------------------------
// Zero-shaped effect returned when observation fails before the action runs.
// ---------------------------------------------------------------------------
function zeroEffect(): PageEffect {
  return {
    dom: { added: 0, removed: 0, attr_changes: 0, text_changes: 0 },
    url: { changed: false },
    focus: { changed: false },
    network: { requests_started: 0, requests_completed: 0, in_flight_at_end: 0 },
    window_ms: 0,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wraps a mutating action with a MutationObserver installed in the page,
 * a network-counter snapshot, and a short observation window (default 300ms).
 *
 * Fails soft on install/read errors — observation failures never propagate
 * to the caller. If the *action* throws, the error is re-thrown after a
 * best-effort observer disconnect.
 */
export async function withEffectObservation<T>(
  cfg: EffectObservationConfig,
  action: () => Promise<T>,
): Promise<{ result: T; effect: PageEffect }> {
  const { chromeTabId, networkTracker } = cfg;
  const windowMs = cfg.windowMs ?? 300;

  // Generate a unique token per observation to avoid collisions on concurrent calls.
  const token =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

  // ----- Install phase -----
  let baseline: { url: string; focus_selector: string | null };
  try {
    baseline = await execInTab(chromeTabId, injectedInstallObserver, [token] as const);
  } catch (err) {
    console.warn("[browserops] effect observation install failed:", err);
    // Skip observation entirely — run the action and return a zero-shaped effect.
    const result = await action();
    return { result, effect: zeroEffect() };
  }

  // ----- Snapshot starting network state -----
  const netBefore = networkTracker.snapshot(chromeTabId);

  // ----- Run the action -----
  let result: T;
  try {
    result = await action();
  } catch (actionErr) {
    // Best-effort disconnect before re-throwing.
    try {
      await execInTab(chromeTabId, injectedReadObserver, [token] as const);
    } catch {
      /* ignore read errors during error path */
    }
    throw actionErr;
  }

  // ----- Observation window -----
  const windowStart = Date.now();
  await new Promise<void>((r) => setTimeout(r, windowMs));
  const windowEnd = Date.now();

  // ----- Read phase -----
  let readResult: {
    dom: { added: number; removed: number; attr_changes: number; text_changes: number };
    url: string;
    focus_selector: string | null;
    truncated: boolean;
  };
  try {
    readResult = await execInTab(chromeTabId, injectedReadObserver, [token] as const);
  } catch (readErr) {
    console.warn("[browserops] effect observation read failed:", readErr);
    // Return partial effect with truncated=true.
    const netAfterPartial = networkTracker.snapshot(chromeTabId);
    const partialEffect: PageEffect = {
      dom: { added: 0, removed: 0, attr_changes: 0, text_changes: 0 },
      url: { changed: false },
      focus: { changed: false },
      network: {
        requests_started: Math.max(0, netAfterPartial.totalStarted - netBefore.totalStarted),
        requests_completed: Math.max(
          0,
          netAfterPartial.totalCompleted - netBefore.totalCompleted,
        ),
        in_flight_at_end: netAfterPartial.inFlight,
      },
      window_ms: windowEnd - windowStart,
      truncated: true,
    };
    return { result, effect: partialEffect };
  }

  // ----- Snapshot final network state -----
  const netAfter = networkTracker.snapshot(chromeTabId);

  // ----- Compute effect -----
  const effect: PageEffect = {
    dom: readResult.dom,
    url: {
      changed: baseline.url !== readResult.url,
      ...(baseline.url !== readResult.url
        ? { before: baseline.url, after: readResult.url }
        : {}),
    },
    focus: {
      changed: baseline.focus_selector !== readResult.focus_selector,
      ...(baseline.focus_selector !== readResult.focus_selector
        ? {
            before_selector: baseline.focus_selector,
            after_selector: readResult.focus_selector,
          }
        : {}),
    },
    network: {
      requests_started: Math.max(0, netAfter.totalStarted - netBefore.totalStarted),
      requests_completed: Math.max(0, netAfter.totalCompleted - netBefore.totalCompleted),
      in_flight_at_end: netAfter.inFlight,
    },
    window_ms: windowEnd - windowStart,
    ...(readResult.truncated ? { truncated: true } : {}),
  };

  return { result, effect };
}
