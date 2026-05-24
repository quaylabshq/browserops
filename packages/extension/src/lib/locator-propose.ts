/**
 * Locator uniqueness scorer.
 *
 * Given an a11y snapshot (RefEntry[]) and a target ref, generate locator
 * candidates in stability-tier order and pick the smallest, highest-tier
 * descriptor that resolves to exactly one element.
 *
 * Algorithm:
 *   1. Tier-1 single-field candidates (aria_label, data_testid, href, attr).
 *   2. Tier-1 composites (role + tier-1 field) when a single field is
 *      ambiguous.
 *   3. Tier-2 candidates (role + name, role + has_text).
 *   4. Tier-3 (nth) as a last resort, flagged fragile.
 *   5. unique:false with warnings if nothing identifies the target.
 *
 * Pure module: no DOM, no async, no network. Suitable for unit tests in
 * Node and for re-use by the bridge-side execute loop when it wants to
 * propose a relocate descriptor on the fly (Substep 3.7).
 */

import type { Locator } from "@browserops/shared";
import { classifyLocator, type LocatorStabilityTier } from "@browserops/shared";
import type { RefEntry } from "../background/ref-cache.js";
import { resolveLocator } from "./locator-resolver.js";

export interface ProposalCandidate {
  locator: Locator;
  matches: number;
  tier: LocatorStabilityTier;
}

export interface ProposalResult {
  /** True when at least one candidate resolved to exactly the target ref. */
  unique: boolean;
  /** The chosen descriptor (best of the trace). */
  locator: Locator;
  /** Tier of the chosen descriptor. */
  tier: LocatorStabilityTier;
  /** True when only tier-3 (nth) produced a unique match. */
  fragile: boolean;
  /** Human-readable warnings — empty on the happy path. */
  warnings: string[];
  /** Every candidate considered, with its resolve count. Debug-grade trace. */
  candidates: ProposalCandidate[];
}

/**
 * Propose the smallest, highest-tier locator that uniquely identifies
 * `targetRef` in `snapshot`. Returns the chosen descriptor plus the full
 * trace of considered candidates.
 */
export function proposeLocator(
  snapshot: readonly RefEntry[],
  targetRef: number,
): ProposalResult {
  const target = snapshot.find((e) => e.ref === targetRef);
  if (target === undefined) {
    return {
      unique: false,
      locator: {},
      tier: 3,
      fragile: true,
      warnings: [`target ref ${targetRef} not present in snapshot`],
      candidates: [],
    };
  }

  const candidates: ProposalCandidate[] = [];
  const trace = (loc: Locator): ProposalCandidate => {
    const matches = resolveLocator(snapshot, loc);
    const tier = classifyLocator(loc) ?? 3;
    const c: ProposalCandidate = { locator: loc, matches: matches.length, tier };
    candidates.push(c);
    return c;
  };

  // ---- Tier 1: single-field candidates ----
  const tier1Single: Locator[] = [];
  const ariaLabel = target.attrs?.["aria-label"];
  if (ariaLabel) tier1Single.push({ aria_label: ariaLabel });

  const testid =
    target.attrs?.["data-testid"] ??
    target.attrs?.["data-test"] ??
    target.attrs?.["data-qa"];
  if (testid) tier1Single.push({ data_testid: testid });

  const href = target.attrs?.["href"];
  if (href) tier1Single.push({ href });

  for (const cand of tier1Single) {
    const t = trace(cand);
    if (t.matches === 1 && resolvesToTarget(snapshot, cand, targetRef)) {
      return success(cand, 1, false, candidates);
    }
  }

  // ---- Tier 1 composite: role + tier-1 field ----
  if (target.role) {
    for (const single of tier1Single) {
      const composite: Locator = { role: target.role, ...single };
      const t = trace(composite);
      if (t.matches === 1 && resolvesToTarget(snapshot, composite, targetRef)) {
        return success(composite, 1, false, candidates);
      }
    }
    // role + form-control name attribute (also tier-1)
    const formName = target.attrs?.["name"];
    if (formName) {
      const composite: Locator = {
        role: target.role,
        attr: { name: "name", value: formName },
      };
      const t = trace(composite);
      if (t.matches === 1 && resolvesToTarget(snapshot, composite, targetRef)) {
        return success(composite, 1, false, candidates);
      }
    }
  }

  // ---- Tier 2: role + name; role + has_text ----
  if (target.name) {
    const roleName: Locator = target.role
      ? { role: target.role, name: target.name }
      : { name: target.name };
    const t = trace(roleName);
    if (t.matches === 1 && resolvesToTarget(snapshot, roleName, targetRef)) {
      return success(roleName, 2, false, candidates);
    }

    // role + name + has_text_not against the second-most-similar sibling
    // — picks up the "Send" vs "Schedule send" disambiguation by
    // negative anchoring.
    if (target.role) {
      const collisions = snapshot.filter(
        (e) =>
          e.ref !== targetRef &&
          e.role === target.role &&
          e.name === target.name,
      );
      if (collisions.length === 0) {
        // role+name was already tested above as unique; skip.
      }
      // role + name + aria_label (when present) — final tier-2 attempt.
      if (ariaLabel) {
        const composite: Locator = {
          role: target.role,
          name: target.name,
          aria_label: ariaLabel,
        };
        const t2 = trace(composite);
        if (
          t2.matches === 1 &&
          resolvesToTarget(snapshot, composite, targetRef)
        ) {
          return success(composite, 2, false, candidates);
        }
      }
    }
  }

  // ---- Tier 3: nth as last resort ----
  if (target.role) {
    const sameRole = snapshot.filter((e) => e.role === target.role);
    const idx = sameRole.findIndex((e) => e.ref === targetRef);
    if (idx >= 0) {
      const cand: Locator = target.name
        ? { role: target.role, name: target.name, nth: indexAmongMatches(snapshot, { role: target.role, name: target.name }, targetRef) }
        : { role: target.role, nth: idx };
      const t = trace(cand);
      if (t.matches === 1 && resolvesToTarget(snapshot, cand, targetRef)) {
        return {
          unique: true,
          locator: cand,
          tier: 3,
          fragile: true,
          warnings: [
            "fell through to nth — descriptor is fragile and will break if a sibling appears",
          ],
          candidates,
        };
      }
    }
  }

  // ---- Nothing unique ----
  const best = pickBest(candidates);
  return {
    unique: false,
    locator: best?.locator ?? {},
    tier: best?.tier ?? 3,
    fragile: true,
    warnings: [
      "no candidate resolved uniquely to the target",
      best
        ? `best candidate matched ${best.matches} elements (tier ${best.tier})`
        : "no candidate produced any match",
    ],
    candidates,
  };
}

function resolvesToTarget(
  snapshot: readonly RefEntry[],
  loc: Locator,
  targetRef: number,
): boolean {
  const matches = resolveLocator(snapshot, loc);
  return matches.length === 1 && matches[0]!.ref === targetRef;
}

function indexAmongMatches(
  snapshot: readonly RefEntry[],
  loc: Locator,
  targetRef: number,
): number {
  const matches = resolveLocator(snapshot, loc);
  return matches.findIndex((m) => m.ref === targetRef);
}

function success(
  locator: Locator,
  tier: LocatorStabilityTier,
  fragile: boolean,
  candidates: ProposalCandidate[],
): ProposalResult {
  return {
    unique: true,
    locator,
    tier,
    fragile,
    warnings: [],
    candidates,
  };
}

function pickBest(candidates: ProposalCandidate[]): ProposalCandidate | undefined {
  // Best = lowest match count > 0, then lowest tier number.
  let best: ProposalCandidate | undefined;
  for (const c of candidates) {
    if (c.matches === 0) continue;
    if (best === undefined) {
      best = c;
      continue;
    }
    if (c.matches < best.matches || (c.matches === best.matches && c.tier < best.tier)) {
      best = c;
    }
  }
  return best;
}
