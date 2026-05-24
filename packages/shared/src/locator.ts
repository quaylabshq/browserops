/**
 * Locator descriptor — a Playwright-style semantic selector that gets
 * re-resolved against the live a11y tree on every step.
 *
 * Procedure authors hand-write these (or let browser_propose_locator pick); the extension's locator resolver
 * (packages/extension/src/background/handlers/locate.ts) does the matching.
 *
 * Serialised regex form: `/source/flags` — YAML carries strings; the
 * helpers below convert between live RegExp objects and the persisted
 * form so a procedure YAML file round-trips losslessly.
 */

/**
 * ARIA roles we expect to encounter. Not exhaustive — the resolver does a
 * case-insensitive substring match anyway. Listed here for documentation
 * value and JSON-Schema enum hinting.
 */
export type AriaRole =
  | "button"
  | "checkbox"
  | "combobox"
  | "dialog"
  | "form"
  | "heading"
  | "img"
  | "link"
  | "list"
  | "listbox"
  | "listitem"
  | "menu"
  | "menuitem"
  | "navigation"
  | "option"
  | "radio"
  | "region"
  | "row"
  | "search"
  | "searchbox"
  | "switch"
  | "tab"
  | "tabpanel"
  | "textbox"
  | "tooltip"
  | string;

/** Persisted form of a regex — accepted in YAML alongside plain strings. */
export type RegexLike = string;

/**
 * One locator descriptor. All fields optional; an empty locator is invalid
 * (the runtime refuses it). Order of operations during resolution:
 *
 *   1. role           — case-insensitive substring on a11y role
 *   2. name           — case-insensitive substring or regex on accessible name
 *   3. aria_label     — explicit aria-label attribute match (tier-1 stable)
 *   4. data_testid    — data-testid / data-test / data-qa attribute (tier-1 stable)
 *   5. href           — link href attribute (tier-1 stable)
 *   6. attr           — generic stable-attribute escape hatch {name, value}
 *   7. has_text       — descendant text must match
 *   8. has_text_not   — descendant text must NOT match
 *   9. in_frame       — restrict to nodes inside the given iframe
 *  10. near           — restrict to nodes within radius_px of an anchor
 *  11. scope          — viewport (default) or document
 *  12. nth            — 0-based pick among remaining matches
 *
 * Tier-1 fields (`aria_label`, `data_testid`, `href`, `attr`) match against
 * `RefEntry.attrs`. They are preferred by the uniqueness scorer because
 * they're author/contract-controlled and stable across rebuilds.
 */
export interface Locator {
  role?: AriaRole;
  name?: RegexLike;
  aria_label?: RegexLike;
  data_testid?: RegexLike;
  href?: RegexLike;
  attr?: {
    name: string;
    value: RegexLike;
  };
  has_text?: RegexLike;
  has_text_not?: RegexLike;
  in_frame?: string;
  near?: {
    ref?: number;
    locator?: Locator;
    radius_px?: number;
  };
  nth?: number;
  scope?: "viewport" | "document";
}

/**
 * Try to parse a string as a serialised regex (`/source/flags`).
 *
 * Returns the RegExp on success, undefined on failure (caller should fall
 * back to substring matching). A literal string with leading/trailing
 * slashes that doesn't compile is treated as not-a-regex on purpose —
 * authors who want a literal "/something/" pass `"/something/"` and the
 * resolver does a substring match on the slashes.
 */
export function parseSerialisedRegex(value: string): RegExp | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length < 2 || value[0] !== "/") return undefined;
  const lastSlash = value.lastIndexOf("/");
  if (lastSlash <= 0) return undefined;
  const source = value.slice(1, lastSlash);
  const flags = value.slice(lastSlash + 1);
  if (!/^[gimsuy]*$/.test(flags)) return undefined;
  try {
    return new RegExp(source, flags);
  } catch {
    return undefined;
  }
}

/**
 * Build the serialised form of a regex for persistence in YAML.
 * Idempotent — passing the output back through `parseSerialisedRegex` yields
 * an equivalent regex (modulo flag ordering).
 */
export function serialiseRegex(re: RegExp): string {
  return `/${re.source}/${re.flags}`;
}

/**
 * Stable, single-line canonical form of a locator — used for trace lines
 * and error messages. Not a parser-friendly format; lossy on purpose.
 *
 * Examples:
 *   {role: "button", name: "/^send/i"}             → "button[name=/^send/i]"
 *   {role: "textbox", name: "To"}                  → "textbox[name=\"To\"]"
 *   {role: "button", name: "Send", nth: 1}         → "button[name=\"Send\"][nth=1]"
 *   {locator: {has_text: "Hello"}}                 → "[has_text=\"Hello\"]"
 */
export function locatorToCanonical(loc: Locator | undefined | null): string {
  if (loc === undefined || loc === null) return "";
  const parts: string[] = [];
  const role = loc.role ?? "";
  if (typeof loc.name === "string" && loc.name.length > 0) {
    parts.push(`name=${formatRegexLike(loc.name)}`);
  }
  if (typeof loc.aria_label === "string" && loc.aria_label.length > 0) {
    parts.push(`aria_label=${formatRegexLike(loc.aria_label)}`);
  }
  if (typeof loc.data_testid === "string" && loc.data_testid.length > 0) {
    parts.push(`data_testid=${formatRegexLike(loc.data_testid)}`);
  }
  if (typeof loc.href === "string" && loc.href.length > 0) {
    parts.push(`href=${formatRegexLike(loc.href)}`);
  }
  if (loc.attr !== undefined && typeof loc.attr.name === "string" && loc.attr.name.length > 0) {
    parts.push(`attr={${loc.attr.name}=${formatRegexLike(loc.attr.value)}}`);
  }
  if (typeof loc.has_text === "string" && loc.has_text.length > 0) {
    parts.push(`has_text=${formatRegexLike(loc.has_text)}`);
  }
  if (typeof loc.has_text_not === "string" && loc.has_text_not.length > 0) {
    parts.push(`has_text_not=${formatRegexLike(loc.has_text_not)}`);
  }
  if (typeof loc.in_frame === "string" && loc.in_frame.length > 0) {
    parts.push(`in_frame="${loc.in_frame}"`);
  }
  if (loc.near !== undefined) {
    const innerParts: string[] = [];
    if (typeof loc.near.ref === "number") innerParts.push(`ref=${loc.near.ref}`);
    if (loc.near.locator) innerParts.push(`of=${locatorToCanonical(loc.near.locator)}`);
    if (typeof loc.near.radius_px === "number") {
      innerParts.push(`radius=${loc.near.radius_px}`);
    }
    parts.push(`near(${innerParts.join(",")})`);
  }
  if (typeof loc.nth === "number") parts.push(`nth=${loc.nth}`);
  if (loc.scope === "document") parts.push("scope=document");
  const body = parts.length === 0 ? "" : `[${parts.join(",")}]`;
  return `${role}${body}`;
}

function formatRegexLike(v: string): string {
  const re = parseSerialisedRegex(v);
  if (re !== undefined) return v;
  return `"${v}"`;
}

/**
 * Returns true iff every field is undefined / empty — used by the
 * validator to reject a no-op descriptor before sending it to the
 * resolver.
 */
export function isLocatorEmpty(loc: Locator | undefined | null): boolean {
  if (loc === undefined || loc === null) return true;
  return (
    !loc.role &&
    !loc.name &&
    !loc.aria_label &&
    !loc.data_testid &&
    !loc.href &&
    !loc.attr &&
    !loc.has_text &&
    !loc.has_text_not &&
    !loc.in_frame &&
    !loc.near &&
    loc.nth === undefined
  );
}

/**
 * Inline JSON-Schema fragment for a Locator — referenced from the
 * procedure schema and from the optional `locator:` field on action
 * inputs.
 *
 * Untyped so consumers don't have to import the JSONSchemaObject type
 * from tools.ts (avoids a circular import in shared/index.ts).
 */
export const LOCATOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    role: { type: "string", minLength: 1, maxLength: 40 },
    name: { type: "string", minLength: 1, maxLength: 400 },
    aria_label: { type: "string", minLength: 1, maxLength: 400 },
    data_testid: { type: "string", minLength: 1, maxLength: 200 },
    href: { type: "string", minLength: 1, maxLength: 400 },
    attr: {
      type: "object",
      additionalProperties: false,
      required: ["name", "value"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
        value: { type: "string", minLength: 1, maxLength: 400 },
      },
    },
    has_text: { type: "string", minLength: 1, maxLength: 400 },
    has_text_not: { type: "string", minLength: 1, maxLength: 400 },
    in_frame: { type: "string", minLength: 1, maxLength: 400 },
    near: {
      type: "object",
      additionalProperties: false,
      properties: {
        ref: { type: "integer", minimum: 1 },
        // Recursive locator shape is intentionally untyped here to avoid
        // pulling a $ref into the schema; the resolver validates the inner
        // shape at runtime.
        locator: { type: "object", additionalProperties: true },
        radius_px: { type: "number", minimum: 0 },
      },
    },
    nth: { type: "integer", minimum: 0 },
    scope: { enum: ["viewport", "document"] as const },
  },
} as const;
