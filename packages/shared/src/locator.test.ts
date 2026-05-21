import { describe, it, expect } from "vitest";
import {
  parseSerialisedRegex,
  serialiseRegex,
  locatorToCanonical,
  isLocatorEmpty,
  type Locator,
} from "./locator.js";

describe("parseSerialisedRegex", () => {
  it("parses a plain serialised regex", () => {
    const re = parseSerialisedRegex("/^send/i");
    expect(re).toBeInstanceOf(RegExp);
    expect(re?.source).toBe("^send");
    expect(re?.flags).toBe("i");
  });

  it("returns undefined for a substring (no slashes)", () => {
    expect(parseSerialisedRegex("send")).toBeUndefined();
  });

  it("returns undefined for malformed regex", () => {
    expect(parseSerialisedRegex("/[unclosed/i")).toBeUndefined();
  });

  it("returns undefined for unknown flags", () => {
    expect(parseSerialisedRegex("/abc/zzz")).toBeUndefined();
  });

  it("round-trips through serialiseRegex", () => {
    const original = /^foo/i;
    const serialised = serialiseRegex(original);
    const reparsed = parseSerialisedRegex(serialised);
    expect(reparsed?.source).toBe(original.source);
    expect(reparsed?.flags).toBe(original.flags);
  });
});

describe("locatorToCanonical", () => {
  it("formats a regex name without quotes", () => {
    const loc: Locator = { role: "button", name: "/^send/i" };
    expect(locatorToCanonical(loc)).toBe("button[name=/^send/i]");
  });

  it("quotes a substring name", () => {
    const loc: Locator = { role: "button", name: "Send" };
    expect(locatorToCanonical(loc)).toBe('button[name="Send"]');
  });

  it("includes nth + scope", () => {
    const loc: Locator = { role: "button", name: "Send", nth: 1, scope: "document" };
    expect(locatorToCanonical(loc)).toBe('button[name="Send",nth=1,scope=document]');
  });

  it("handles has_text + has_text_not", () => {
    const loc: Locator = {
      role: "button",
      has_text: "Reply",
      has_text_not: "/^all/i",
    };
    expect(locatorToCanonical(loc)).toBe(
      'button[has_text="Reply",has_text_not=/^all/i]',
    );
  });

  it("handles a near() anchor", () => {
    const loc: Locator = {
      role: "textbox",
      near: { ref: 12, radius_px: 80 },
    };
    expect(locatorToCanonical(loc)).toBe("textbox[near(ref=12,radius=80)]");
  });

  it("returns empty string for null / undefined", () => {
    expect(locatorToCanonical(null)).toBe("");
    expect(locatorToCanonical(undefined)).toBe("");
  });
});

describe("isLocatorEmpty", () => {
  it("flags fully empty as empty", () => {
    expect(isLocatorEmpty({})).toBe(true);
    expect(isLocatorEmpty(null)).toBe(true);
    expect(isLocatorEmpty(undefined)).toBe(true);
  });

  it("considers a scope-only locator empty", () => {
    expect(isLocatorEmpty({ scope: "document" })).toBe(true);
  });

  it("recognises any meaningful field as non-empty", () => {
    expect(isLocatorEmpty({ role: "button" })).toBe(false);
    expect(isLocatorEmpty({ name: "Send" })).toBe(false);
    expect(isLocatorEmpty({ has_text: "x" })).toBe(false);
    expect(isLocatorEmpty({ in_frame: "iframe" })).toBe(false);
    expect(isLocatorEmpty({ near: { ref: 1 } })).toBe(false);
    expect(isLocatorEmpty({ nth: 0 })).toBe(false);
  });
});
