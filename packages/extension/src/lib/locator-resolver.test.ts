import { describe, it, expect } from "vitest";
import type { RefEntry } from "../background/ref-cache.js";
import { resolveLocator, matchString } from "./locator-resolver.js";

const fixture: RefEntry[] = [
  { ref: 1, role: "button", name: "Compose", selector: "#compose-btn" },
  { ref: 2, role: "button", name: "Send", selector: "#send-btn" },
  { ref: 3, role: "button", name: "Schedule send", selector: "#schedule-btn" },
  { ref: 4, role: "textbox", name: "Subject", selector: "#subject" },
  { ref: 5, role: "textbox", name: "Message body", selector: "#body" },
  { ref: 6, role: "link", name: "Help", selector: "a#help" },
  { ref: 7, role: "menuitem", name: "Reply all", selector: "#reply-all" },
];

describe("matchString", () => {
  it("substring is case-insensitive", () => {
    expect(matchString("Compose", "comp")).toBe(true);
    expect(matchString("Compose", "send")).toBe(false);
  });

  it("regex /pattern/i works", () => {
    expect(matchString("Send", "/^send$/i")).toBe(true);
    expect(matchString("Schedule send", "/^send$/i")).toBe(false);
  });
});

describe("resolveLocator", () => {
  it("filters by role substring", () => {
    const out = resolveLocator(fixture, { role: "button" });
    expect(out.map((m) => m.ref)).toEqual([1, 2, 3]);
  });

  it("filters by name substring", () => {
    const out = resolveLocator(fixture, { name: "Send" });
    // Both "Send" and "Schedule send" match a substring search
    expect(out.map((m) => m.ref).sort()).toEqual([2, 3]);
  });

  it("filters by name regex anchor", () => {
    const out = resolveLocator(fixture, { name: "/^send$/i" });
    expect(out.map((m) => m.ref)).toEqual([2]);
  });

  it("excludes via has_text_not", () => {
    const out = resolveLocator(fixture, {
      role: "button",
      name: "send",
      has_text_not: "/schedule/i",
    });
    expect(out.map((m) => m.ref)).toEqual([2]);
  });

  it("nth selects the indexed match", () => {
    const out = resolveLocator(fixture, { role: "button", nth: 1 });
    expect(out.map((m) => m.ref)).toEqual([2]);
  });

  it("nth out of range returns empty", () => {
    const out = resolveLocator(fixture, { role: "button", nth: 99 });
    expect(out).toEqual([]);
  });

  it("empty role-only locator still matches all entries", () => {
    const out = resolveLocator(fixture, {});
    expect(out.length).toBe(fixture.length);
  });

  it("returns ref+role+name+selector only", () => {
    const out = resolveLocator(fixture, { role: "link" });
    expect(out).toEqual([{ ref: 6, role: "link", name: "Help", selector: "a#help" }]);
  });
});

// ---------------------------------------------------------------------------
// Tier-1 attribute filters (Substep 3.3)
// ---------------------------------------------------------------------------

const tier1Fixture: RefEntry[] = [
  {
    ref: 1,
    role: "button",
    name: "Compose",
    selector: "#compose-btn",
    attrs: { "aria-label": "Compose new email", "data-testid": "compose-btn" },
  },
  {
    ref: 2,
    role: "button",
    name: "Send",
    selector: "#send-btn",
    attrs: { "aria-label": "Send message", "data-testid": "send" },
  },
  {
    ref: 3,
    role: "button",
    name: "Send",
    selector: "#send-later-btn",
    attrs: { "aria-label": "Schedule send", "data-test": "schedule-send" },
  },
  {
    ref: 4,
    role: "link",
    name: "Inbox",
    selector: "a#inbox",
    attrs: { href: "/mail/u/0/#inbox" },
  },
  {
    ref: 5,
    role: "link",
    name: "Sent",
    selector: "a#sent",
    attrs: { href: "/mail/u/0/#sent" },
  },
  {
    ref: 6,
    role: "textbox",
    name: "Body",
    selector: "textarea#body",
    attrs: { name: "body", "data-qa": "compose-body" },
  },
  {
    ref: 7,
    role: "row",
    name: "Row 42",
    selector: "#row-42",
    attrs: { "data-row-id": "42" },
  },
  {
    ref: 8,
    role: "row",
    name: "Row 7",
    selector: "#row-7",
    attrs: { "data-row-id": "7" },
  },
];

describe("resolveLocator with tier-1 fields", () => {
  it("matches aria_label against attrs['aria-label'] (substring)", () => {
    const out = resolveLocator(tier1Fixture, { aria_label: "send message" });
    expect(out.map((m) => m.ref)).toEqual([2]);
  });

  it("matches aria_label against attrs['aria-label'] (regex)", () => {
    const out = resolveLocator(tier1Fixture, { aria_label: "/^schedule/i" });
    expect(out.map((m) => m.ref)).toEqual([3]);
  });

  it("matches data_testid against any of data-testid / data-test / data-qa", () => {
    expect(
      resolveLocator(tier1Fixture, { data_testid: "send" }).map((m) => m.ref).sort(),
    ).toEqual([2, 3]); // data-testid="send" on #2, data-test="schedule-send" substring on #3
    expect(
      resolveLocator(tier1Fixture, { data_testid: "compose-body" }).map((m) => m.ref),
    ).toEqual([6]); // data-qa hit
  });

  it("matches href on links", () => {
    const out = resolveLocator(tier1Fixture, { href: "/^\\/mail\\/u\\/0\\/#sent/" });
    expect(out.map((m) => m.ref)).toEqual([5]);
  });

  it("matches name attribute on form controls (locator field 'attr' with name='name')", () => {
    const out = resolveLocator(tier1Fixture, {
      attr: { name: "name", value: "body" },
    });
    expect(out.map((m) => m.ref)).toEqual([6]);
  });

  it("attr filter matches a custom data attribute by name+value", () => {
    const out = resolveLocator(tier1Fixture, {
      attr: { name: "data-row-id", value: "42" },
    });
    expect(out.map((m) => m.ref)).toEqual([7]);
  });

  it("attr filter supports regex on value", () => {
    const out = resolveLocator(tier1Fixture, {
      attr: { name: "data-row-id", value: "/^\\d$/" },
    });
    expect(out.map((m) => m.ref)).toEqual([8]); // single-digit "7"
  });

  it("composes tier-1 fields with role to disambiguate (the core uniqueness use-case)", () => {
    // Two buttons both have name="Send" — anchored data_testid regex
    // picks the one whose testid is exactly "send", not "schedule-send".
    const out = resolveLocator(tier1Fixture, {
      role: "button",
      name: "Send",
      data_testid: "/^send$/i",
    });
    expect(out.map((m) => m.ref)).toEqual([2]);
  });

  it("returns no matches when the tier-1 attr is missing from every entry", () => {
    const out = resolveLocator(tier1Fixture, { aria_label: "no-such-label" });
    expect(out).toEqual([]);
  });
});
