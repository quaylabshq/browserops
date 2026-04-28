/**
 * Distiller stage: split a flat IRStep[] into one or more IRLeaf groups
 * at observable UI-state transitions.
 *
 * Boundaries (in priority order):
 *   1. host_change   — URL hostname changes between consecutive steps
 *   2. url_change    — URL path/query changes (a route navigation)
 *   3. focus_shift   — focus changed AND a new region's selector shows
 *                       up in the page_effect
 *   4. modal_open    — DOM-added burst (>= MODAL_DOM_THRESHOLD) on a
 *                       step that's *not* a navigation
 *   5. network_burst — >= NETWORK_BURST requests started in a single
 *                       step (likely a route load with no URL change)
 *
 * Each boundary opens a new IRLeaf; the boundary step itself goes into
 * the *new* leaf (it represents the transition into the new state).
 */
import type { IRStep, IRLeaf, LeafSplitReason } from "./distiller-ir.js";

const MODAL_DOM_THRESHOLD = 100;
const NETWORK_BURST = 5;

export function splitLeaves(steps: IRStep[]): IRLeaf[] {
  if (steps.length === 0) return [];
  const out: IRLeaf[] = [{ steps: [steps[0] as IRStep], reason: "first" }];
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1] as IRStep;
    const cur = steps[i] as IRStep;
    const reason = boundaryReason(prev, cur);
    if (reason !== null) {
      out.push({ steps: [cur], reason });
    } else {
      (out[out.length - 1] as IRLeaf).steps.push(cur);
    }
  }
  return out;
}

function boundaryReason(prev: IRStep, cur: IRStep): LeafSplitReason | null {
  // Host change wins (any cross-domain navigation is a hard split).
  const prevHost = hostFromStep(prev);
  const curHost = hostFromStep(cur);
  if (prevHost !== null && curHost !== null && prevHost !== curHost) {
    return "url_change";
  }

  // URL path/query change on a navigate step.
  if (cur.method === "browser_navigate" && cur.page_effect?.url?.changed === true) {
    return "url_change";
  }
  if (cur.page_effect?.url?.changed === true) {
    return "url_change";
  }

  // Focus shift (e.g. modal open repositions focus).
  if (cur.page_effect?.focus?.changed === true && (cur.page_effect.dom?.added ?? 0) > 0) {
    return "focus_shift";
  }

  // Big DOM burst without a navigation — modal/drawer open.
  if (
    cur.method !== "browser_navigate" &&
    (cur.page_effect?.dom?.added ?? 0) >= MODAL_DOM_THRESHOLD
  ) {
    return "modal_open";
  }

  // Network burst — many requests in one observation window.
  if ((cur.page_effect?.network?.requests_started ?? 0) >= NETWORK_BURST) {
    return "network_burst";
  }

  return null;
}

function hostFromStep(step: IRStep): string | null {
  // Look at navigate URL first, fall back to page_effect.url.after.
  const navUrl =
    step.method === "browser_navigate" && typeof step.params["url"] === "string"
      ? (step.params["url"] as string)
      : null;
  const effectAfter = step.page_effect?.url?.after;
  for (const cand of [navUrl, typeof effectAfter === "string" ? effectAfter : null]) {
    if (cand === null) continue;
    try {
      return new URL(cand).hostname.toLowerCase();
    } catch {
      // ignore
    }
  }
  return null;
}
