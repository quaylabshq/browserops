import type { ActionExpectation, Effect } from "@browserops/shared";

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
