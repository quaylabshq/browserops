import { describe, it, expect } from "vitest";
import {
  classifyField,
  classifyLocator,
  type LocatorStabilityTier,
} from "./locator-stability.js";

/**
 * The stability classifier is the rulebook the uniqueness scorer (3.5)
 * uses to prefer one candidate over another. Tier 1 = author/contract-
 * controlled and survives rebuilds; tier 2 = stable within a build but
 * not across; tier 3 = fragile (we don't generate tier-3 candidates, but
 * the classifier names them so authors can be warned).
 */

describe("classifyField", () => {
  it("aria_label is tier 1 (author-controlled)", () => {
    expect(classifyField("aria_label")).toBe<LocatorStabilityTier>(1);
  });

  it("data_testid is tier 1 (test-author-controlled)", () => {
    expect(classifyField("data_testid")).toBe<LocatorStabilityTier>(1);
  });

  it("href is tier 1 (route-author-controlled)", () => {
    expect(classifyField("href")).toBe<LocatorStabilityTier>(1);
  });

  it("attr is tier 1 (the escape hatch is only useful for stable attrs)", () => {
    expect(classifyField("attr")).toBe<LocatorStabilityTier>(1);
  });

  it("role is tier 1 (semantic, framework-emitted but stable)", () => {
    expect(classifyField("role")).toBe<LocatorStabilityTier>(1);
  });

  it("name is tier 2 (text-derived accessible name churns when copy changes)", () => {
    expect(classifyField("name")).toBe<LocatorStabilityTier>(2);
  });

  it("has_text is tier 2 (same — text-derived)", () => {
    expect(classifyField("has_text")).toBe<LocatorStabilityTier>(2);
  });

  it("has_text_not is tier 2", () => {
    expect(classifyField("has_text_not")).toBe<LocatorStabilityTier>(2);
  });

  it("near is tier 2 (depends on layout proximity)", () => {
    expect(classifyField("near")).toBe<LocatorStabilityTier>(2);
  });

  it("nth is tier 3 (fragile — depends on document order)", () => {
    expect(classifyField("nth")).toBe<LocatorStabilityTier>(3);
  });

  it("in_frame is tier 1 (iframe name is page-author-controlled)", () => {
    expect(classifyField("in_frame")).toBe<LocatorStabilityTier>(1);
  });

  it("scope is not a match signal — classifier returns null", () => {
    expect(classifyField("scope")).toBeNull();
  });

  it("unknown field name returns null", () => {
    expect(classifyField("unknown_field")).toBeNull();
  });
});

describe("classifyLocator", () => {
  it("a locator with only tier-1 fields is tier 1 overall", () => {
    expect(
      classifyLocator({ role: "button", aria_label: "Send" }),
    ).toBe<LocatorStabilityTier>(1);
    expect(
      classifyLocator({ data_testid: "send-btn" }),
    ).toBe<LocatorStabilityTier>(1);
  });

  it("a locator with any tier-2 field is tier 2 overall (worst-tier-wins)", () => {
    expect(
      classifyLocator({ role: "button", name: "Send" }),
    ).toBe<LocatorStabilityTier>(2);
    expect(
      classifyLocator({ role: "button", has_text: "Send" }),
    ).toBe<LocatorStabilityTier>(2);
  });

  it("a locator with nth (tier 3) is tier 3 overall", () => {
    expect(
      classifyLocator({ role: "button", nth: 0 }),
    ).toBe<LocatorStabilityTier>(3);
    expect(
      classifyLocator({ role: "button", aria_label: "Send", nth: 1 }),
    ).toBe<LocatorStabilityTier>(3);
  });

  it("scope-only doesn't bump the tier (scope is not a match signal)", () => {
    expect(
      classifyLocator({ aria_label: "Send", scope: "document" }),
    ).toBe<LocatorStabilityTier>(1);
  });

  it("empty locator returns null (no signals to classify)", () => {
    expect(classifyLocator({})).toBeNull();
  });
});
