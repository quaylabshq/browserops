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
