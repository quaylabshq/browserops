/**
 * Per-step fallback strategies — `retry` (same locator, with backoff) and
 * `relocate` (widen the locator descriptor and try again).
 *
 * Pure functions: they decide what to do next, and the execute loop
 * carries it out. The loop is responsible for budget accounting.
 */
import type {
  Locator,
  FallbackDef,
  StepDef,
} from "@browserops/shared";

export interface RetryDecision {
  action: "retry" | "give_up";
  backoff_ms: number;
  attempt: number;
}

const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_BACKOFF_MS = 500;

/**
 * Decide whether to retry the step verbatim. `attempt` is 0-based — the
 * first call corresponds to "we already tried once and failed", so the
 * function returns retry if attempt < attempts.
 */
export function applyRetry(
  step: StepDef,
  attempt: number,
): RetryDecision {
  const fallback: FallbackDef | undefined = step.fallback;
  const attempts = fallback?.retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS;
  const backoff = fallback?.retry?.backoff_ms ?? DEFAULT_BACKOFF_MS;
  if (attempt < attempts) {
    return { action: "retry", backoff_ms: backoff, attempt: attempt + 1 };
  }
  return { action: "give_up", backoff_ms: 0, attempt };
}

export interface RelocateDecision {
  action: "retry_with" | "give_up";
  /** A widened locator descriptor to try next time. */
  locator?: Locator;
  /** Why we widened — kept for trace logs. */
  reason?: string;
}

/**
 * Widen the locator according to the step's relocate config and return
 * the new descriptor. If no widening produces a different descriptor (or
 * the relocate config is empty), returns give_up.
 *
 * Widening rules:
 *   - widen_role: drop role filter.
 *   - widen_name: regex → strip anchors / make case-insensitive substring;
 *                  substring → leave it (substring is already permissive).
 *   - consider_text: lift step.goal tokens into has_text fallback when name
 *                    wasn't already a substring match.
 */
export function applyRelocate(
  step: StepDef,
): RelocateDecision {
  const fallback = step.fallback;
  const cfg = fallback?.relocate;
  if (cfg === undefined) {
    return { action: "give_up" };
  }
  if (step.locator === undefined) {
    return { action: "give_up", reason: "no locator on step" };
  }

  const widened: Locator = { ...step.locator };
  let changed = false;
  const reasons: string[] = [];

  if (cfg.widen_role && widened.role !== undefined) {
    delete widened.role;
    changed = true;
    reasons.push("dropped role");
  }

  if (cfg.widen_name && widened.name !== undefined) {
    const next = relaxNamePattern(widened.name);
    if (next !== widened.name) {
      widened.name = next;
      changed = true;
      reasons.push("relaxed name");
    }
  }

  if (cfg.consider_text && widened.has_text === undefined) {
    const goalTokens = (step.goal ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 3);
    if (goalTokens.length > 0) {
      widened.has_text = goalTokens[0]!;
      changed = true;
      reasons.push("added has_text from goal");
    }
  }

  if (!changed) return { action: "give_up", reason: "no widening produced a change" };

  return {
    action: "retry_with",
    locator: widened,
    reason: reasons.join("; "),
  };
}

/**
 * Convert an anchored regex source like `/^send/i` to a softer substring.
 * A non-regex string is returned unchanged.
 */
function relaxNamePattern(pattern: string): string {
  // /source/flags form
  if (pattern.length >= 2 && pattern[0] === "/") {
    const lastSlash = pattern.lastIndexOf("/");
    if (lastSlash > 0) {
      const source = pattern.slice(1, lastSlash);
      // Strip ^ / $ anchors so the regex matches anywhere in the name.
      const relaxed = source.replace(/^\^/, "").replace(/\$$/, "");
      // Drop $-anchored regex flavour entirely → substring match.
      const literal = relaxed.replace(/\\(.)/g, "$1").replace(/[.*+?()[\]{}|]/g, "");
      if (literal.length > 0) return literal;
    }
  }
  return pattern;
}
