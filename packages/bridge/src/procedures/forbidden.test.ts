import { describe, expect, it } from "vitest";
import { checkForbidden } from "./forbidden.js";

describe("checkForbidden", () => {
  it("undefined block always allows", () => {
    expect(
      checkForbidden(undefined, { action: "click", locator: { name: "Delete" } }).allowed,
    ).toBe(true);
  });

  it("blocks forbidden action", () => {
    const r = checkForbidden(
      { actions: ["browser_execute_js"] },
      { action: "browser_execute_js", locator: undefined },
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/forbidden\.actions/);
  });

  it("allows non-listed action", () => {
    const r = checkForbidden(
      { actions: ["browser_execute_js"] },
      { action: "click", locator: undefined },
    );
    expect(r.allowed).toBe(true);
  });

  it("blocks locator name substring overlap", () => {
    const r = checkForbidden(
      { locators: [{ name: "/^delete/i" }] },
      { action: "click", locator: { role: "button", name: "Delete account" } },
    );
    expect(r.allowed).toBe(false);
  });

  it("blocks role + name substring", () => {
    const r = checkForbidden(
      { locators: [{ role: "button", name: "delete" }] },
      { action: "click", locator: { role: "button", name: "Delete" } },
    );
    expect(r.allowed).toBe(false);
  });

  it("allows when role mismatches denied role", () => {
    const r = checkForbidden(
      { locators: [{ role: "button", name: "delete" }] },
      { action: "click", locator: { role: "link", name: "Delete" } },
    );
    expect(r.allowed).toBe(true);
  });

  it("refuses unknown candidate name when denied name is set", () => {
    const r = checkForbidden(
      { locators: [{ name: "/^delete/i" }] },
      { action: "click", locator: { role: "button" } },
    );
    // candidate.name is undefined → assume overlap, refuse.
    expect(r.allowed).toBe(false);
  });

  it("compares aria_label before refusing a denied name", () => {
    const r = checkForbidden(
      { locators: [{ name: "/^delete/i" }] },
      { action: "type", locator: { aria_label: "Cell A1" } },
    );
    expect(r.allowed).toBe(true);
  });

  it("blocks aria_label that overlaps a denied name", () => {
    const r = checkForbidden(
      { locators: [{ name: "/^delete/i" }] },
      { action: "click", locator: { aria_label: "Delete account" } },
    );
    expect(r.allowed).toBe(false);
  });

  it("compares aria_label deny patterns before refusing", () => {
    const r = checkForbidden(
      { locators: [{ aria_label: "/^delete/i" }] },
      { action: "type", locator: { aria_label: "Project name" } },
    );
    expect(r.allowed).toBe(true);
  });

  it("blocks aria_label that overlaps an aria_label deny pattern", () => {
    const r = checkForbidden(
      { locators: [{ aria_label: "/^delete/i" }] },
      { action: "click", locator: { aria_label: "Delete account" } },
    );
    expect(r.allowed).toBe(false);
  });

  it("locator-only block ignores action checks", () => {
    const r = checkForbidden(
      { locators: [{ name: "delete" }] },
      { action: "click", locator: { role: "button", name: "Send" } },
    );
    expect(r.allowed).toBe(true);
  });
});
