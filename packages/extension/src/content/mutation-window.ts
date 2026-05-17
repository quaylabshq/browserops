import type { MutationCounts } from "@browserops/shared";

// Injected into the target tab's MAIN world to track DOM mutations during
// an action window. Keyed by a per-call window id so concurrent captures
// on the same tab don't collide.
//
// These functions must be self-contained (no closures, no imports) —
// chrome.scripting.executeScript serialises them across worlds, and any
// reference to module scope would be undefined inside the page.

const CAP = 10_000;

interface MutationState {
  added: number;
  removed: number;
  attr: number;
  char: number;
  observer: MutationObserver | null;
}

/** Install a MutationObserver, store it under a window-id keyed global. */
export function installMutationObserver(windowId: string): void {
  const key = `__browserops_mutation_${windowId}__` as keyof Window;
  const state: MutationState = {
    added: 0,
    removed: 0,
    attr: 0,
    char: 0,
    observer: null,
  };
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === "childList") {
        state.added = Math.min(CAP, state.added + rec.addedNodes.length);
        state.removed = Math.min(CAP, state.removed + rec.removedNodes.length);
      } else if (rec.type === "attributes") {
        state.attr = Math.min(CAP, state.attr + 1);
      } else if (rec.type === "characterData") {
        state.char = Math.min(CAP, state.char + 1);
      }
    }
  });
  observer.observe(document.documentElement ?? document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  state.observer = observer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any)[key] = state;
}

/** Disconnect the observer and return accumulated counts. */
export function readMutationObserver(windowId: string): MutationCounts {
  const key = `__browserops_mutation_${windowId}__` as keyof Window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = (window as any)[key] as MutationState | undefined;
  if (!state) {
    return { added: 0, removed: 0, attr: 0, char: 0 };
  }
  try {
    state.observer?.disconnect();
  } catch {
    /* best-effort */
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any)[key];
  return {
    added: state.added,
    removed: state.removed,
    attr: state.attr,
    char: state.char,
  };
}
