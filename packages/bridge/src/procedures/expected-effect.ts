/**
 * checkExpectation — verify an ExpectedEffect against an observed PageEffect.
 *
 * Used by procedures_execute (Phase 5) to validate each step's page_effect
 * against the loose assertions emitted by procedures_compile (Phase 4).
 *
 * Matching rules:
 *   dom.any: true     → observed.dom.added + removed + attr_changes + text_changes > 0
 *   dom.added_min: N  → observed.dom.added >= N
 *   dom.removed_min   → observed.dom.removed >= N
 *   dom.attr_changes_min → observed.dom.attr_changes >= N
 *   dom.text_changes_min → observed.dom.text_changes >= N
 *   url.changed       → observed.url.changed === expected
 *   focus.changed     → observed.focus.changed === expected
 *   network.requests_started_min: N → observed.network.requests_started >= N
 *   network.requests_completed_min: N → observed.network.requests_completed >= N
 *   console_errors_max: N → observed.console_errors <= N
 *
 * When expected is undefined → { matched: true } (no assertion = no check).
 * When observed is undefined but expected is present → { matched: false }.
 */

import type { ExpectedEffect } from "@browserops/shared";
import type { PageEffect } from "@browserops/shared";

export type CheckResult =
  | { matched: true }
  | { matched: false; reason: string };

export function checkExpectation(
  expected: ExpectedEffect | undefined,
  observed: PageEffect | undefined,
): CheckResult {
  // No assertion declared — always passes.
  if (expected === undefined || expected === null) {
    return { matched: true };
  }

  // Assertion present but no observed data available.
  if (observed === undefined || observed === null) {
    return {
      matched: false,
      reason: "observed page_effect unavailable",
    };
  }

  // ---- dom checks ----
  if (expected.dom !== undefined && expected.dom !== null) {
    const { dom } = expected;
    const obs = observed.dom;

    if (dom.any === true) {
      const total =
        obs.added + obs.removed + obs.attr_changes + obs.text_changes;
      if (total === 0) {
        return {
          matched: false,
          reason:
            `expected dom.any: true but observed no DOM mutations ` +
            `(added=${obs.added} removed=${obs.removed} attr_changes=${obs.attr_changes} text_changes=${obs.text_changes})`,
        };
      }
    }

    if (dom.any === false) {
      const total =
        obs.added + obs.removed + obs.attr_changes + obs.text_changes;
      if (total > 0) {
        return {
          matched: false,
          reason:
            `expected dom.any: false but observed DOM mutations ` +
            `(total=${total})`,
        };
      }
    }

    if (dom.added_min !== undefined) {
      if (obs.added < dom.added_min) {
        return {
          matched: false,
          reason: `expected dom.added_min: ${dom.added_min} but observed ${obs.added}`,
        };
      }
    }

    if (dom.removed_min !== undefined) {
      if (obs.removed < dom.removed_min) {
        return {
          matched: false,
          reason: `expected dom.removed_min: ${dom.removed_min} but observed ${obs.removed}`,
        };
      }
    }

    if (dom.attr_changes_min !== undefined) {
      if (obs.attr_changes < dom.attr_changes_min) {
        return {
          matched: false,
          reason: `expected dom.attr_changes_min: ${dom.attr_changes_min} but observed ${obs.attr_changes}`,
        };
      }
    }

    if (dom.text_changes_min !== undefined) {
      if (obs.text_changes < dom.text_changes_min) {
        return {
          matched: false,
          reason: `expected dom.text_changes_min: ${dom.text_changes_min} but observed ${obs.text_changes}`,
        };
      }
    }
  }

  // ---- url checks ----
  if (expected.url !== undefined && expected.url !== null) {
    const { url } = expected;
    if (url.changed !== undefined) {
      if (observed.url.changed !== url.changed) {
        return {
          matched: false,
          reason: `expected url.changed: ${url.changed} but observed ${observed.url.changed}`,
        };
      }
    }
  }

  // ---- focus checks ----
  if (expected.focus !== undefined && expected.focus !== null) {
    const { focus } = expected;
    if (focus.changed !== undefined) {
      if (observed.focus.changed !== focus.changed) {
        return {
          matched: false,
          reason: `expected focus.changed: ${focus.changed} but observed ${observed.focus.changed}`,
        };
      }
    }
  }

  // ---- network checks ----
  if (expected.network !== undefined && expected.network !== null) {
    const { network } = expected;
    if (network.requests_started_min !== undefined) {
      if (observed.network.requests_started < network.requests_started_min) {
        return {
          matched: false,
          reason:
            `expected network.requests_started_min: ${network.requests_started_min} ` +
            `but observed ${observed.network.requests_started}`,
        };
      }
    }
    if (network.requests_completed_min !== undefined) {
      if (observed.network.requests_completed < network.requests_completed_min) {
        return {
          matched: false,
          reason:
            `expected network.requests_completed_min: ${network.requests_completed_min} ` +
            `but observed ${observed.network.requests_completed}`,
        };
      }
    }
  }

  // ---- console_errors check ----
  if (expected.console_errors_max !== undefined) {
    if (observed.console_errors > expected.console_errors_max) {
      return {
        matched: false,
        reason:
          `expected console_errors_max: ${expected.console_errors_max} ` +
          `but observed ${observed.console_errors}`,
      };
    }
  }

  return { matched: true };
}
