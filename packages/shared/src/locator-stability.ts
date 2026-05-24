/**
 * Locator stability tier classifier.
 *
 * The uniqueness scorer (packages/extension/src/lib/locator-propose.ts)
 * uses these tiers to prefer one candidate over another. Tier 1 is the
 * goal: author/contract-controlled signals that survive UI rebuilds
 * (aria-label, data-testid, href, attr, role, in_frame). Tier 2 is OK
 * but text-derived — copy changes will churn it. Tier 3 is fragile and
 * the scorer only emits it as a last resort, always with an explicit
 * warning.
 *
 * Pure module: just classification rules. No runtime resolution.
 */
import type { Locator } from "./locator.js";

export type LocatorStabilityTier = 1 | 2 | 3;

/** Field name → tier. `scope` is not a match signal and returns null. */
const FIELD_TIERS: Record<string, LocatorStabilityTier> = {
  // Tier 1 — author/contract-controlled, survives rebuilds.
  aria_label: 1,
  data_testid: 1,
  href: 1,
  attr: 1,
  role: 1,
  in_frame: 1,

  // Tier 2 — text-derived or layout-derived. Stable within a build, churns
  // when copy or DOM order changes.
  name: 2,
  has_text: 2,
  has_text_not: 2,
  near: 2,

  // Tier 3 — fragile. Depends on document order or rendered position;
  // breaks when the page re-orders matching elements.
  nth: 3,
};

/**
 * Tier of an individual locator field. Returns `null` for `scope` (which
 * controls search range but isn't a match signal) and for any unknown
 * field name.
 */
export function classifyField(field: string): LocatorStabilityTier | null {
  return FIELD_TIERS[field] ?? null;
}

/**
 * Overall tier of a locator descriptor — worst-tier-wins across populated
 * fields. Returns `null` for an empty/no-signal descriptor.
 *
 * Worst-wins is intentional: a descriptor with a perfect `aria_label` AND
 * an `nth: 3` selector is only as reliable as the nth — if a sibling
 * appears, the locator picks the wrong element.
 */
export function classifyLocator(loc: Locator): LocatorStabilityTier | null {
  let worst: LocatorStabilityTier | null = null;
  for (const key of Object.keys(loc) as Array<keyof Locator>) {
    const value = loc[key];
    if (value === undefined || value === null) continue;
    if (key === "scope") continue;
    if (typeof value === "string" && value.length === 0) continue;
    const tier = classifyField(key as string);
    if (tier === null) continue;
    if (worst === null || tier > worst) worst = tier;
  }
  return worst;
}
