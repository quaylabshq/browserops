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
