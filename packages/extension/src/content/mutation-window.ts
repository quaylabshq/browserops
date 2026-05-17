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

export interface DialogSnapshot {
  role: string;
  name: string;
  selector: string;
}

export interface FocusSnapshot {
  selector: string | null;
}

/** Read current document.activeElement and visible dialog/alertdialog nodes.
 *  Returns a structurally-stable snapshot consumed by captureEffect to diff
 *  focus changes and detect newly-appeared dialogs. */
export function snapshotFocusAndDialogs(): {
  focus: FocusSnapshot;
  dialogs: DialogSnapshot[];
} {
  function selectorFor(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node !== null && node !== document.documentElement && node !== document.body) {
      const id = node.id;
      if (id) {
        parts.unshift(`#${CSS.escape(id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
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
    return parts.length > 0 ? parts.join(" > ") : "";
  }

  function accessibleName(el: Element): string {
    const aria = el.getAttribute("aria-label");
    if (aria !== null && aria.trim() !== "") return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby !== null) {
      const ids = labelledby.split(/\s+/).filter(Boolean);
      const text = ids
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
        .trim();
      if (text !== "") return text;
    }
    const title = el.getAttribute("title");
    if (title !== null && title.trim() !== "") return title.trim();
    const text = (el.textContent ?? "").trim();
    return text.slice(0, 80);
  }

  const active = document.activeElement;
  const focus: FocusSnapshot = {
    selector:
      active !== null && active !== document.body && active !== document.documentElement
        ? selectorFor(active)
        : null,
  };

  const dialogs: DialogSnapshot[] = [];
  const nodes = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"]',
  );
  let scanned = 0;
  for (const el of nodes) {
    if (scanned++ >= 200) break;
    // Skip clearly-hidden dialogs.
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    dialogs.push({
      role: el.getAttribute("role") ?? "dialog",
      name: accessibleName(el),
      selector: selectorFor(el),
    });
  }
  return { focus, dialogs };
}
