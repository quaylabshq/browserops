import { describe, it, expect } from "vitest";
import type { RefEntry } from "../background/ref-cache.js";
import { proposeLocator, type ProposalCandidate } from "./locator-propose.js";

/**
 * The uniqueness scorer is the algorithm that takes a target element and
 * the live a11y snapshot, then emits the minimum-information,
 * highest-tier locator that resolves to exactly one element.
 *
 * Algorithm contract:
 *   1. Generate candidates in tier order (tier-1 first).
 *   2. For each candidate, count matches in the snapshot.
 *   3. Emit the smallest tier-1 candidate with exactly one match.
 *   4. Fall through to tier-2 only when no tier-1 candidate is unique;
 *      flag the result as `tier: 2`.
 *   5. Fall through to tier-3 (nth) only when nothing else worked;
 *      flag `fragile: true` AND `tier: 3`.
 *   6. If nothing is unique, return `unique: false` with the best
 *      candidate and a warning.
 */

function entry(
  ref: number,
  role: string,
  name: string,
  attrs?: Record<string, string>,
): RefEntry {
  const base: RefEntry = { ref, role, name, selector: `#ref-${ref}` };
  if (attrs) base.attrs = attrs;
  return base;
}

describe("proposeLocator — happy path", () => {
  it("returns aria_label-only when aria-label uniquely identifies the target", () => {
    const snapshot: RefEntry[] = [
      entry(1, "button", "Compose", { "aria-label": "Compose new email" }),
      entry(2, "button", "Send", { "aria-label": "Send message" }),
      entry(3, "button", "Send", { "aria-label": "Schedule send" }),
    ];
    const result = proposeLocator(snapshot, 2);
    expect(result.unique).toBe(true);
    expect(result.tier).toBe(1);
    expect(result.locator).toEqual({ aria_label: "Send message" });
  });

  it("returns data_testid-only when data-testid uniquely identifies the target", () => {
    const snapshot: RefEntry[] = [
      entry(1, "button", "Send", { "data-testid": "send-now" }),
      entry(2, "button", "Send", { "data-testid": "send-later" }),
    ];
    const result = proposeLocator(snapshot, 1);
    expect(result.unique).toBe(true);
    expect(result.tier).toBe(1);
    expect(result.locator).toEqual({ data_testid: "send-now" });
  });

  it("returns role+href when href identifies a link uniquely", () => {
    const snapshot: RefEntry[] = [
      entry(1, "link", "Inbox", { href: "/inbox" }),
      entry(2, "link", "Sent", { href: "/sent" }),
    ];
    const result = proposeLocator(snapshot, 1);
    expect(result.unique).toBe(true);
    expect(result.tier).toBe(1);
    expect(result.locator.href).toBe("/inbox");
  });
});

describe("proposeLocator — composition when single field is not unique", () => {
  it("composes role+aria_label when aria_label alone is ambiguous", () => {
    const snapshot: RefEntry[] = [
      entry(1, "button", "Send", { "aria-label": "Send" }),
      entry(2, "menuitem", "Send", { "aria-label": "Send" }),
    ];
    const result = proposeLocator(snapshot, 1);
    expect(result.unique).toBe(true);
    expect(result.tier).toBe(1);
    expect(result.locator).toEqual({ role: "button", aria_label: "Send" });
  });

  it("falls through to tier 2 (role+name) when no tier-1 disambiguates", () => {
    const snapshot: RefEntry[] = [
      entry(1, "button", "Compose"),
      entry(2, "button", "Send"),
      entry(3, "menuitem", "Send"),
    ];
    const result = proposeLocator(snapshot, 2);
    expect(result.unique).toBe(true);
    expect(result.tier).toBe(2);
    expect(result.locator).toEqual({ role: "button", name: "Send" });
  });
});

describe("proposeLocator — degraded paths", () => {
  it("emits nth as the last resort with fragile=true", () => {
    const snapshot: RefEntry[] = [
      entry(1, "button", "Send"),
      entry(2, "button", "Send"),
    ];
    const result = proposeLocator(snapshot, 2);
    expect(result.unique).toBe(true);
    expect(result.tier).toBe(3);
    expect(result.fragile).toBe(true);
    expect(result.locator.nth).toBe(1);
  });

  it("returns unique=false when even nth cannot distinguish (target absent)", () => {
    const snapshot: RefEntry[] = [
      entry(1, "button", "Send"),
      entry(2, "button", "Send"),
    ];
    const result = proposeLocator(snapshot, 99);
    expect(result.unique).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("returns unique=false when snapshot is empty", () => {
    const result = proposeLocator([], 1);
    expect(result.unique).toBe(false);
  });
});

describe("proposeLocator — candidate trace", () => {
  it("includes every tried candidate with its match count", () => {
    const snapshot: RefEntry[] = [
      entry(1, "button", "Send", { "aria-label": "Send" }),
      entry(2, "menuitem", "Send", { "aria-label": "Send" }),
    ];
    const result = proposeLocator(snapshot, 1);
    expect(result.candidates.length).toBeGreaterThan(0);
    const first = result.candidates[0] as ProposalCandidate;
    expect(first).toHaveProperty("locator");
    expect(first).toHaveProperty("matches");
    expect(first).toHaveProperty("tier");
  });
});
