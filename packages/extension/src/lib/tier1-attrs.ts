/**
 * Tier-1 attribute extraction — the spec for which DOM attributes the
 * locator resolver matches against.
 *
 * "Tier 1" means signals that are author- or contract-controlled and
 * stable across rebuilds: aria-label, data-testid/test/qa, href, and the
 * form-control `name` attribute. These survive UI-framework restyling
 * and CSS-in-JS class-name churn, so the uniqueness scorer prefers them.
 *
 * Keys are the literal DOM attribute names (`"aria-label"`, not
 * `"aria_label"`). The resolver translates between locator-field names
 * (snake_case, see `Locator` in @browserops/shared) and these DOM names.
 *
 * The injected a11y-walk in `background/handlers/read.ts` keeps an inline
 * copy of this logic — MAIN-world injection cannot close over outer
 * helpers. Any change to the rules here must be mirrored there.
 */

/** Minimal duck-type so callers can run in node tests without jsdom. */
export interface ElementLike {
  tagName: string;
  getAttribute(name: string): string | null;
}

const MAX_VALUE_LEN = 400;

const TIER1_ATTRS_ALL = [
  "aria-label",
  "data-testid",
  "data-test",
  "data-qa",
] as const;

const FORM_CONTROL_TAGS = new Set([
  "INPUT",
  "SELECT",
  "TEXTAREA",
  "BUTTON",
  "FIELDSET",
  "FORM",
]);

/**
 * Extract tier-1 attributes from an element. Returns a flat record keyed
 * by the literal DOM attribute name. Empty/missing values are omitted.
 *
 * Long values are truncated to 400 chars to bound storage size.
 */
export function extractTier1Attrs(el: ElementLike): Record<string, string> {
  const out: Record<string, string> = {};
  const tag = (el.tagName ?? "").toUpperCase();

  for (const attr of TIER1_ATTRS_ALL) {
    const v = el.getAttribute(attr);
    if (typeof v === "string" && v.length > 0) {
      out[attr] = v.slice(0, MAX_VALUE_LEN);
    }
  }

  // href: any element that exposes one is fair game (<a>, <link>, <area>, ...).
  const href = el.getAttribute("href");
  if (typeof href === "string" && href.length > 0) {
    out["href"] = href.slice(0, MAX_VALUE_LEN);
  }

  // name: only on real form controls. Skip on <a name="..."> which is a
  // legacy anchor target and not a stable test signal.
  if (FORM_CONTROL_TAGS.has(tag)) {
    const name = el.getAttribute("name");
    if (typeof name === "string" && name.length > 0) {
      out["name"] = name.slice(0, MAX_VALUE_LEN);
    }
  }

  return out;
}
