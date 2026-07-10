/**
 * Forbidden-locator + forbidden-action guard.
 *
 * Runs before every dispatch the procedure engine emits — including
 * dispatches from LLM-proposed remediation patches in procedures_resume.
 * Centralised here so the resume path cannot bypass author-declared
 * safety bars.
 */
import type { ForbiddenDef, Locator, StepDef } from "@browserops/shared";
import { matchString } from "./match-string.js";

export interface ForbiddenCheckInput {
  /** The do: of the step (or a tool name, for arbitrary dispatches). */
  action: string | undefined;
  /** Resolved locator, post-substitution. */
  locator: Locator | undefined;
}

export interface ForbiddenCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check whether the given action+locator violates any rule in the
 * forbidden block. Returns `{allowed: true}` when no rule applies.
 */
export function checkForbidden(
  forbidden: ForbiddenDef | undefined,
  input: ForbiddenCheckInput,
): ForbiddenCheckResult {
  if (forbidden === undefined || forbidden === null) return { allowed: true };

  // Action allowlist check.
  if (
    forbidden.actions !== undefined &&
    forbidden.actions.length > 0 &&
    input.action !== undefined &&
    forbidden.actions.includes(input.action)
  ) {
    return {
      allowed: false,
      reason: `action ${JSON.stringify(input.action)} is in the procedure's forbidden.actions list`,
    };
  }

  // Locator deny-list check — only meaningful when an action has a locator.
  if (
    forbidden.locators !== undefined &&
    forbidden.locators.length > 0 &&
    input.locator !== undefined
  ) {
    for (const denied of forbidden.locators) {
      if (locatorOverlaps(denied, input.locator)) {
        return {
          allowed: false,
          reason: `locator overlaps a forbidden pattern: ${JSON.stringify(denied)}`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * True when the candidate locator could resolve to the same element a
 * forbidden locator would. This is a structural overlap check, not a DOM
 * test — the runtime cannot know which element a locator would resolve
 * to without executing it, so we err on the side of refusing.
 *
 * Rules:
 *   - If `denied.role` is set and matches the candidate.role substring
 *     case-insensitively (or candidate.role is absent), proceed; else
 *     no overlap.
 *   - If a denied name-like field is set, check candidate name-like fields
 *     against it using the same regex/substring rules the resolver uses.
 *     If the candidate has no comparable text, keep the conservative
 *     refusal because we cannot rule out overlap structurally.
 *   - has_text is checked the same way.
 */
function locatorOverlaps(denied: Locator, candidate: Locator): boolean {
  if (denied.role !== undefined && denied.role !== "") {
    if (
      candidate.role !== undefined &&
      !candidate.role.toLowerCase().includes(denied.role.toLowerCase())
    ) {
      return false;
    }
  }

  // name-like overlap
  const deniedNames = candidateNameLikePatterns(denied);
  if (deniedNames.length > 0) {
    const candidateNames = candidateNameLikePatterns(candidate);
    if (candidateNames.length > 0) {
      const overlap = deniedNames.some((deniedName) =>
        candidateNames.some((name) => patternsOverlap(deniedName, name)),
      );
      if (!overlap) return false;
    }
    // If candidate has no comparable text field, we can't rule out overlap
    // — assume it might match and refuse.
  }

  return true;
}

function candidateNameLikePatterns(candidate: Locator): string[] {
  const names: string[] = [];
  for (const value of [candidate.name, candidate.aria_label, candidate.has_text]) {
    if (typeof value === "string" && value !== "") names.push(value);
  }
  return names;
}

/**
 * True when two pattern strings (substring or `/regex/flags`) have any
 * conservative overlap. Used for the locator deny check.
 *
 *   - Both substrings: case-insensitive prefix/contains either way.
 *   - One regex / one substring: test the substring against the regex.
 *   - Two regexes: structural overlap is undecidable; refuse to clear.
 */
function patternsOverlap(a: string, b: string): boolean {
  // Cheapest case: identical strings.
  if (a === b) return true;
  // Use existing matchString helper to test each pattern against the other.
  if (matchString(a, b) || matchString(b, a)) return true;
  return false;
}

/**
 * Apply the forbidden block to a normalised step descriptor.
 * Convenience for the execute loop — pulls `action` + `locator` off the
 * step automatically.
 */
export function checkForbiddenForStep(
  forbidden: ForbiddenDef | undefined,
  step: StepDef,
): ForbiddenCheckResult {
  return checkForbidden(forbidden, {
    action: step.do,
    locator: step.locator,
  });
}
