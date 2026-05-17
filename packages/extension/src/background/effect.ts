import type { Effect } from "@browserops/shared";

// Higher-order helper used by the observation-architecture plan's
// page_effect envelope path. Wraps any action handler with the pre/post
// instrumentation (mutations, network, visual hash, focus, dialogs, a11y,
// console errors) defined in the plan and returns a populated Effect
// alongside the action's result.
//
// Skeleton only — real instrumentation lands in subsequent substeps
// (1.3.3–1.3.7). For now we return a zeroed Effect so callers can be
// wired up to the new shape without depending on the full pipeline yet.

export function zeroEffect(): Effect {
  return {
    url_changed: false,
    title_changed: false,
    mutations: { added: 0, removed: 0, attr: 0, char: 0 },
    network: { requests: 0, failed: 0, endpoints: [] },
    visual_hash_delta: 0,
    a11y_delta: { added: 0, removed: 0, changed: 0 },
    focus_moved_to: null,
    new_dialogs: [],
    console_errors: 0,
    duration_ms: 0,
  };
}

export async function captureEffect<T>(
  _tabId: number,
  fn: () => Promise<T>,
): Promise<{ result: T; effect: Effect }> {
  const start = Date.now();
  const result = await fn();
  const effect = zeroEffect();
  effect.duration_ms = Date.now() - start;
  return { result, effect };
}
