import { describe, it, expect } from "vitest";
import { extractTier1Attrs, type ElementLike } from "./tier1-attrs.js";

/**
 * Tier-1 attribute extraction is the spec for which DOM attributes the
 * locator resolver matches against (`aria_label`, `data_testid`, `href`,
 * `attr`). The injected a11y-walk in `read.ts` MUST keep its inline copy
 * in sync with this helper — drift here breaks descriptor matching.
 *
 * Tests use a duck-typed `ElementLike` so they run in plain Node without
 * jsdom; the real injected code passes a Node `Element`.
 */

function el(
  tagName: string,
  attrs: Record<string, string | null> = {},
): ElementLike {
  return {
    tagName: tagName.toUpperCase(),
    getAttribute: (n: string) => (n in attrs ? attrs[n]! : null),
  };
}

describe("extractTier1Attrs", () => {
  it("returns an empty record for an element with no tier-1 attributes", () => {
    expect(extractTier1Attrs(el("div"))).toEqual({});
  });

  it("captures aria-label when present", () => {
    expect(extractTier1Attrs(el("button", { "aria-label": "Send" }))).toEqual({
      "aria-label": "Send",
    });
  });

  it("captures data-testid", () => {
    expect(
      extractTier1Attrs(el("button", { "data-testid": "send-btn" })),
    ).toEqual({ "data-testid": "send-btn" });
  });

  it("captures data-test and data-qa as aliases under their own keys", () => {
    expect(extractTier1Attrs(el("button", { "data-test": "send" }))).toEqual({
      "data-test": "send",
    });
    expect(extractTier1Attrs(el("button", { "data-qa": "send" }))).toEqual({
      "data-qa": "send",
    });
  });

  it("captures href on any element that has one (not just <a>)", () => {
    expect(extractTier1Attrs(el("a", { href: "/inbox" }))).toEqual({
      href: "/inbox",
    });
    expect(extractTier1Attrs(el("link", { href: "/style.css" }))).toEqual({
      href: "/style.css",
    });
  });

  it("captures the name attribute on form controls", () => {
    expect(extractTier1Attrs(el("input", { name: "email" }))).toEqual({
      name: "email",
    });
    expect(extractTier1Attrs(el("select", { name: "country" }))).toEqual({
      name: "country",
    });
    expect(extractTier1Attrs(el("textarea", { name: "body" }))).toEqual({
      name: "body",
    });
  });

  it("does NOT capture name on non-form elements (avoids collision with semantic name)", () => {
    // <a name="anchor"> is a legacy anchor; not a stable test signal.
    expect(extractTier1Attrs(el("a", { name: "anchor" }))).toEqual({});
  });

  it("captures multiple tier-1 attributes together", () => {
    const out = extractTier1Attrs(
      el("button", {
        "aria-label": "Send",
        "data-testid": "send-btn",
      }),
    );
    expect(out).toEqual({
      "aria-label": "Send",
      "data-testid": "send-btn",
    });
  });

  it("skips empty-string values (treat as absent)", () => {
    expect(
      extractTier1Attrs(el("button", { "aria-label": "", "data-testid": "" })),
    ).toEqual({});
  });

  it("truncates very long values to 400 chars", () => {
    const long = "x".repeat(1000);
    const out = extractTier1Attrs(el("button", { "aria-label": long }));
    expect(out["aria-label"]!.length).toBe(400);
  });
});

describe("tier-1 attribute key names", () => {
  it("uses literal DOM attribute names as keys (not locator-field names)", () => {
    // The resolver maps locator field aria_label → attrs["aria-label"],
    // data_testid → attrs["data-testid"], etc. The augment side stores
    // the DOM names verbatim so the resolver does the translation.
    const out = extractTier1Attrs(
      el("button", {
        "aria-label": "Send",
        "data-testid": "send",
      }),
    );
    expect(Object.keys(out).sort()).toEqual(["aria-label", "data-testid"]);
  });
});
