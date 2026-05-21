/**
 * Retrying expect-predicate evaluator for the playbook execute loop.
 *
 * `evaluateExpect` is the one-shot check: given an ExpectDef and an
 * Observation snapshot, returns matched/reason.
 *
 * `pollExpect` polls a caller-supplied `getObservation` at the configured
 * interval until the predicate matches or `timeout_ms` elapses. Returns
 * the last evaluation either way.
 */
import type { PlaybookExpectDef, PageEffect } from "@browserops/shared";
import { parseSerialisedRegex } from "@browserops/shared";

/**
 * Snapshot of post-action state that the expect evaluator inspects.
 * The execute loop builds this from the tool result + extra observations
 * (browser_read / browser_observe) as needed.
 */
export interface Observation {
  /** Full or stripped URL of the active tab. */
  url?: string;
  /** Title of the active tab. */
  title?: string;
  /** All text visible to the user in the latest a11y/structure read. */
  text?: string;
  /** Most recently observed page_effect envelope. */
  page_effect?: PageEffect;
  /** Roles of any new dialogs that appeared during the action. */
  new_dialogs?: Array<{ name?: string; role?: string }>;
  /** Most recent observed network endpoints. */
  network_endpoints?: string[];
  /** Visual hash delta, 0..1. */
  visual_hash_delta?: number;
  /** Selector of the element that now has focus. */
  focus_selector?: string;
  /** Console error count during the action window. */
  console_errors?: number;
}

export type ExpectCheck =
  | { matched: true }
  | { matched: false; reason: string };

const DEFAULT_TIMEOUT = 3000;
const DEFAULT_POLL = 200;

function matchPattern(value: string, pattern: string): boolean {
  if (typeof pattern !== "string") return false;
  const re = parseSerialisedRegex(pattern);
  if (re !== undefined) return re.test(value);
  return value.toLowerCase().includes(pattern.toLowerCase());
}

export function evaluateExpect(
  expect: PlaybookExpectDef | undefined,
  observed: Observation | undefined,
): ExpectCheck {
  if (expect === undefined || expect === null) return { matched: true };
  if (observed === undefined) {
    return { matched: false, reason: "no observation available" };
  }

  if (expect.url_matches !== undefined) {
    const url = observed.url ?? "";
    if (!matchPattern(url, expect.url_matches)) {
      return {
        matched: false,
        reason: `url ${JSON.stringify(url)} does not match ${expect.url_matches}`,
      };
    }
  }

  if (expect.text_visible !== undefined) {
    const text = observed.text ?? "";
    if (!matchPattern(text, expect.text_visible)) {
      return {
        matched: false,
        reason: `expected visible text ${JSON.stringify(expect.text_visible)} not found`,
      };
    }
  }

  if (expect.text_invisible !== undefined) {
    const text = observed.text ?? "";
    if (matchPattern(text, expect.text_invisible)) {
      return {
        matched: false,
        reason: `expected text ${JSON.stringify(expect.text_invisible)} to be hidden, but it was visible`,
      };
    }
  }

  if (expect.new_dialog !== undefined) {
    const dialogs = observed.new_dialogs ?? [];
    if (expect.new_dialog === true) {
      if (dialogs.length === 0) {
        return { matched: false, reason: "expected a new dialog to appear" };
      }
    } else if (typeof expect.new_dialog === "string") {
      const pat = expect.new_dialog;
      const hit = dialogs.some((d) =>
        d.name ? matchPattern(d.name, pat) : false,
      );
      if (!hit) {
        return {
          matched: false,
          reason: `no new dialog matched ${JSON.stringify(pat)}`,
        };
      }
    }
  }

  const networkPattern = expect.network_endpoint ?? expect.network_endpoint_seen;
  if (networkPattern !== undefined) {
    const endpoints = observed.network_endpoints ?? [];
    const hit = endpoints.some((e) => matchPattern(e, networkPattern));
    if (!hit) {
      return {
        matched: false,
        reason: `no network endpoint matched ${JSON.stringify(networkPattern)} (saw ${endpoints.length})`,
      };
    }
  }

  if (expect.visual_delta_at_least !== undefined) {
    const v = observed.visual_hash_delta ?? 0;
    if (v < expect.visual_delta_at_least) {
      return {
        matched: false,
        reason: `visual delta ${v.toFixed(3)} < threshold ${expect.visual_delta_at_least}`,
      };
    }
  }

  if (expect.focus_moved_to !== undefined) {
    if (observed.focus_selector === undefined) {
      return { matched: false, reason: "no focus selector observed" };
    }
  }

  if (expect.dom_added_min !== undefined) {
    const added = observed.page_effect?.dom?.added ?? 0;
    if (added < expect.dom_added_min) {
      return {
        matched: false,
        reason: `dom.added ${added} < min ${expect.dom_added_min}`,
      };
    }
  }

  if (expect.dom_removed_min !== undefined) {
    const removed = observed.page_effect?.dom?.removed ?? 0;
    if (removed < expect.dom_removed_min) {
      return {
        matched: false,
        reason: `dom.removed ${removed} < min ${expect.dom_removed_min}`,
      };
    }
  }

  if (expect.console_errors_max !== undefined) {
    const errors = observed.console_errors ?? observed.page_effect?.console_errors ?? 0;
    if (errors > expect.console_errors_max) {
      return {
        matched: false,
        reason: `console_errors ${errors} > max ${expect.console_errors_max}`,
      };
    }
  }

  return { matched: true };
}

export interface PollResult {
  matched: boolean;
  observed?: Observation;
  reason?: string;
}

/**
 * Poll an observation source until the expect predicate matches or
 * `expect.timeout_ms` elapses. Sleeps `expect.poll_interval_ms` between
 * iterations.
 *
 * Even when `expect` is undefined this function still performs ONE call
 * to `getObservation` and returns matched:true with the result, so the
 * execute loop can use this as the universal step-completion hook.
 */
export async function pollExpect(
  expect: PlaybookExpectDef | undefined,
  getObservation: () => Promise<Observation | undefined>,
  options?: { now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<PollResult> {
  const now = options?.now ?? (() => Date.now());
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const timeoutMs = expect?.timeout_ms ?? DEFAULT_TIMEOUT;
  const pollMs = expect?.poll_interval_ms ?? DEFAULT_POLL;
  const deadline = now() + timeoutMs;

  let lastObserved: Observation | undefined;
  let lastReason: string | undefined;

  while (true) {
    lastObserved = await getObservation();
    const check = evaluateExpect(expect, lastObserved);
    if (check.matched) {
      const r: PollResult = { matched: true };
      if (lastObserved !== undefined) r.observed = lastObserved;
      return r;
    }
    lastReason = check.reason;
    if (now() >= deadline) break;
    await sleep(pollMs);
  }

  const r: PollResult = { matched: false };
  if (lastObserved !== undefined) r.observed = lastObserved;
  if (lastReason !== undefined) r.reason = lastReason;
  return r;
}
