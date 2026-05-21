import type { ActionExpectation, Effect } from "@browserops/shared";
import { execInTab } from "./handlers/input.js";

// Pure predicate evaluator for ActionExpectation. Given the latest Effect
// envelope and a per-call page snapshot, returns whether the agent's
// expectation has been met and (when not) a human-readable mismatch
// reason. Polling lives in expectation-poller.ts → pollUntilMet; this
// file is just the predicate logic so it can be unit-tested.

export interface PageSnapshot {
  url: string;
  title: string;
  focus_selector: string | null;
  field_values: Record<string, string>;
}

export interface MatchResult {
  ok: boolean;
  mismatch_reason?: string;
}

export function matches(
  effect: Effect,
  page: PageSnapshot,
  expected: ActionExpectation,
): MatchResult {
  if (expected.url_matches !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(expected.url_matches);
    } catch {
      return { ok: false, mismatch_reason: `url_matches is not a valid regex: ${expected.url_matches}` };
    }
    if (!re.test(page.url)) {
      return { ok: false, mismatch_reason: `url_matches /${expected.url_matches}/ did not match ${page.url}` };
    }
  }
  if (expected.title_matches !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(expected.title_matches);
    } catch {
      return { ok: false, mismatch_reason: `title_matches is not a valid regex: ${expected.title_matches}` };
    }
    if (!re.test(page.title)) {
      return { ok: false, mismatch_reason: `title_matches /${expected.title_matches}/ did not match "${page.title}"` };
    }
  }
  if (expected.new_dialog !== undefined) {
    if (typeof expected.new_dialog === "boolean") {
      if (expected.new_dialog === true && effect.new_dialogs.length === 0) {
        return { ok: false, mismatch_reason: "new_dialog=true but no dialog appeared" };
      }
      if (expected.new_dialog === false && effect.new_dialogs.length > 0) {
        return { ok: false, mismatch_reason: `new_dialog=false but a dialog appeared (${effect.new_dialogs.map((d) => d.name).join(", ")})` };
      }
    } else {
      // String: regex against any new dialog name.
      let re: RegExp;
      try {
        re = new RegExp(expected.new_dialog);
      } catch {
        return { ok: false, mismatch_reason: `new_dialog is not a valid regex: ${expected.new_dialog}` };
      }
      const hit = effect.new_dialogs.some((d) => re.test(d.name));
      if (!hit) {
        return { ok: false, mismatch_reason: `no new dialog matched /${expected.new_dialog}/` };
      }
    }
  }
  if (expected.value_contains !== undefined) {
    const got = page.field_values[expected.value_contains.ref] ?? "";
    if (!got.includes(expected.value_contains.substring)) {
      return {
        ok: false,
        mismatch_reason: `ref ${expected.value_contains.ref} value "${got}" did not contain "${expected.value_contains.substring}"`,
      };
    }
  }
  if (expected.mutations_at_least !== undefined) {
    const total =
      effect.mutations.added +
      effect.mutations.removed +
      effect.mutations.attr +
      effect.mutations.char;
    if (total < expected.mutations_at_least) {
      return {
        ok: false,
        mismatch_reason: `mutations_at_least=${expected.mutations_at_least} but observed ${total}`,
      };
    }
  }
  if (expected.network_endpoint !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(expected.network_endpoint);
    } catch {
      return { ok: false, mismatch_reason: `network_endpoint is not a valid regex: ${expected.network_endpoint}` };
    }
    const hit = effect.network.endpoints.some((e) => re.test(e));
    if (!hit) {
      return {
        ok: false,
        mismatch_reason: `no network endpoint matched /${expected.network_endpoint}/ (saw: ${effect.network.endpoints.join(", ")})`,
      };
    }
  }
  if (expected.focus_to !== undefined) {
    if (page.focus_selector !== expected.focus_to && effect.focus_moved_to !== expected.focus_to) {
      return {
        ok: false,
        mismatch_reason: `focus_to="${expected.focus_to}" but focus is on "${page.focus_selector ?? effect.focus_moved_to ?? "<none>"}"`,
      };
    }
  }
  if (expected.visual_delta_at_least !== undefined) {
    if (effect.visual_hash_delta < expected.visual_delta_at_least) {
      return {
        ok: false,
        mismatch_reason: `visual_delta_at_least=${expected.visual_delta_at_least} but observed ${effect.visual_hash_delta.toFixed(3)}`,
      };
    }
  }
  return { ok: true };
}

// Injected: reads url/title/focus + the value of every ref the agent
// asked about, in one round-trip. Self-contained — no closures.
function injectedPageSnapshot(
  selectors: readonly string[],
): {
  url: string;
  title: string;
  focus_selector: string | null;
  field_values: Record<string, string>;
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

  const focus = document.activeElement;
  const focus_selector =
    focus !== null && focus !== document.body && focus !== document.documentElement
      ? selectorFor(focus)
      : null;

  const field_values: Record<string, string> = {};
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el === null) continue;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      field_values[sel] = el.value;
    } else if ((el as HTMLElement).isContentEditable) {
      field_values[sel] = (el as HTMLElement).innerText;
    }
  }
  return {
    url: location.href,
    title: document.title,
    focus_selector,
    field_values,
  };
}

export interface PollResult {
  expectation_met: boolean;
  mismatch_reason?: string;
}

/**
 * Polls the page until `expected` matches or the timeout elapses. Never
 * throws — soft signal so the agent can pivot. The caller supplies the
 * Effect snapshot collected by captureEffect; this loop re-reads the live
 * page state on each tick and re-evaluates the predicate.
 */
export async function pollUntilMet(
  tabId: number,
  effect: Effect,
  expected: ActionExpectation,
): Promise<PollResult> {
  const timeout = expected.timeout_ms ?? 3000;
  const interval = expected.poll_interval_ms ?? 100;
  const fieldRefs =
    expected.value_contains !== undefined ? [expected.value_contains.ref] : [];
  const deadline = Date.now() + timeout;
  let lastReason: string | undefined;
  while (Date.now() <= deadline) {
    let snap: ReturnType<typeof injectedPageSnapshot>;
    try {
      snap = await execInTab(tabId, injectedPageSnapshot, [fieldRefs] as const);
    } catch (err) {
      lastReason = `page snapshot failed: ${(err as Error).message}`;
      await new Promise((r) => setTimeout(r, interval));
      continue;
    }
    const out = matches(effect, snap, expected);
    if (out.ok) {
      return { expectation_met: true };
    }
    lastReason = out.mismatch_reason;
    await new Promise((r) => setTimeout(r, interval));
  }
  return {
    expectation_met: false,
    mismatch_reason: lastReason ?? "expectation never met within timeout",
  };
}
