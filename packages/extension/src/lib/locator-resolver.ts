/**
 * Pure-function locator resolver — matches a Locator descriptor against
 * a list of RefEntry rows from the per-tab ref cache.
 *
 * No DOM access. Callers are responsible for snapshotting the tree first
 * (via browser_read in a11y_tree mode); this module just does the
 * filtering and returns matched refs.
 */
import type { Locator } from "@browserops/shared";
import { parseSerialisedRegex } from "@browserops/shared";
import type { RefEntry } from "../background/ref-cache.js";

export interface LocatorMatchedEntry {
  ref: number;
  role: string;
  name: string;
  selector: string;
}

/**
 * Resolve a locator against the given RefEntry list.
 *
 * Returns ALL entries that pass every field in the descriptor.
 * Order is preserved from the input list.
 *
 * Empty / undefined locator returns no matches — callers should reject
 * empty locators before calling this (see `isLocatorEmpty`).
 */
export function resolveLocator(
  entries: readonly RefEntry[],
  loc: Locator,
): LocatorMatchedEntry[] {
  let matches: RefEntry[] = entries.slice();

  if (loc.role !== undefined && loc.role !== "") {
    const want = loc.role.toLowerCase();
    matches = matches.filter((e) => e.role.toLowerCase().includes(want));
  }

  if (loc.name !== undefined && loc.name !== "") {
    matches = matches.filter((e) => matchString(e.name, loc.name!));
  }

  // ---- Tier-1 attribute filters ----
  // aria_label → attrs["aria-label"]
  if (loc.aria_label !== undefined && loc.aria_label !== "") {
    matches = matches.filter((e) =>
      matchAttr(e, "aria-label", loc.aria_label!),
    );
  }

  // data_testid → any of attrs["data-testid" | "data-test" | "data-qa"]
  if (loc.data_testid !== undefined && loc.data_testid !== "") {
    matches = matches.filter(
      (e) =>
        matchAttr(e, "data-testid", loc.data_testid!) ||
        matchAttr(e, "data-test", loc.data_testid!) ||
        matchAttr(e, "data-qa", loc.data_testid!),
    );
  }

  // href → attrs["href"]
  if (loc.href !== undefined && loc.href !== "") {
    matches = matches.filter((e) => matchAttr(e, "href", loc.href!));
  }

  // attr → attrs[attr.name] matches attr.value (regex or substring)
  if (
    loc.attr !== undefined &&
    typeof loc.attr.name === "string" &&
    loc.attr.name.length > 0
  ) {
    const key = loc.attr.name;
    const val = loc.attr.value;
    matches = matches.filter((e) => matchAttr(e, key, val));
  }

  if (loc.has_text !== undefined && loc.has_text !== "") {
    // For `has_text` we approximate descendant-text by checking the
    // entry's accessible name PLUS any text attr. Without a parent/
    // descendant graph in the snapshot, this is the closest proxy.
    matches = matches.filter((e) => {
      if (matchString(e.name, loc.has_text!)) return true;
      const attrText = collectAttrText(e);
      return matchString(attrText, loc.has_text!);
    });
  }

  if (loc.has_text_not !== undefined && loc.has_text_not !== "") {
    matches = matches.filter((e) => {
      if (matchString(e.name, loc.has_text_not!)) return false;
      const attrText = collectAttrText(e);
      return !matchString(attrText, loc.has_text_not!);
    });
  }

  if (typeof loc.nth === "number") {
    if (loc.nth < 0 || loc.nth >= matches.length) {
      matches = [];
    } else {
      matches = [matches[loc.nth]!];
    }
  }

  return matches.map((e) => ({
    ref: e.ref,
    role: e.role,
    name: e.name,
    selector: e.selector,
  }));
}

/**
 * Match `value` against a pattern that may be a `/source/flags` serialised
 * regex or a plain substring. Both matches are case-insensitive when the
 * pattern is a substring; regexes honour their own flags.
 */
export function matchString(value: string, pattern: string): boolean {
  if (typeof value !== "string" || typeof pattern !== "string") return false;
  const re = parseSerialisedRegex(pattern);
  if (re !== undefined) {
    return re.test(value);
  }
  return value.toLowerCase().includes(pattern.toLowerCase());
}

function collectAttrText(e: RefEntry): string {
  if (!e.attrs) return "";
  return Object.values(e.attrs).filter((v) => typeof v === "string").join(" ");
}

/**
 * Match `pattern` against a single attribute on `e`. Returns false if the
 * entry has no attrs map or the attr is absent. Pattern matching uses the
 * same regex/substring rules as `matchString`.
 */
function matchAttr(e: RefEntry, key: string, pattern: string): boolean {
  if (!e.attrs) return false;
  const v = e.attrs[key];
  if (typeof v !== "string" || v.length === 0) return false;
  return matchString(v, pattern);
}
