import { describe, expect, it } from "vitest";
import { isDestructiveChord } from "./destructive-chords.js";

describe("isDestructiveChord", () => {
  it("refuses Meta+W (close tab on mac)", () => {
    expect(isDestructiveChord("KeyW", ["Meta"])).toMatch(/closes the tab/i);
  });

  it("refuses Control+W (close tab on win/linux)", () => {
    expect(isDestructiveChord("KeyW", ["Control"])).toMatch(/closes the tab/i);
  });

  it("refuses Meta+Shift+W (close window)", () => {
    expect(isDestructiveChord("KeyW", ["Meta", "Shift"])).toMatch(/closes the window/i);
  });

  it("refuses Alt+F4", () => {
    expect(isDestructiveChord("F4", ["Alt"])).toMatch(/closes the window/i);
  });

  it("refuses Meta+Q (quit browser)", () => {
    expect(isDestructiveChord("KeyQ", ["Meta"])).toMatch(/quits the browser/i);
  });

  it("refuses Primary+T / Primary+N / Primary+Shift+N", () => {
    expect(isDestructiveChord("KeyT", ["Meta"])).toMatch(/new tab/i);
    expect(isDestructiveChord("KeyT", ["Control"])).toMatch(/new tab/i);
    expect(isDestructiveChord("KeyN", ["Meta"])).toMatch(/new window/i);
    expect(isDestructiveChord("KeyN", ["Meta", "Shift"])).toMatch(/incognito/i);
  });

  it("allows Primary+A (select all)", () => {
    expect(isDestructiveChord("KeyA", ["Meta"])).toBeNull();
    expect(isDestructiveChord("KeyA", ["Control"])).toBeNull();
  });

  it("allows Primary+C / Primary+V / Primary+Z", () => {
    expect(isDestructiveChord("KeyC", ["Meta"])).toBeNull();
    expect(isDestructiveChord("KeyV", ["Meta"])).toBeNull();
    expect(isDestructiveChord("KeyZ", ["Meta"])).toBeNull();
  });

  it("allows plain Delete / Backspace / Enter / Tab / Escape", () => {
    expect(isDestructiveChord("Delete", [])).toBeNull();
    expect(isDestructiveChord("Backspace", [])).toBeNull();
    expect(isDestructiveChord("Enter", [])).toBeNull();
    expect(isDestructiveChord("Tab", [])).toBeNull();
    expect(isDestructiveChord("Escape", [])).toBeNull();
  });

  it("allows bare W / Q / T / N without a Primary modifier", () => {
    // Without Meta/Control, these are just letter keys.
    expect(isDestructiveChord("KeyW", [])).toBeNull();
    expect(isDestructiveChord("KeyQ", [])).toBeNull();
    expect(isDestructiveChord("KeyT", [])).toBeNull();
    expect(isDestructiveChord("KeyN", [])).toBeNull();
  });

  it("normalises letter keys across KeyA / a / A forms", () => {
    expect(isDestructiveChord("a", ["Meta"])).toBeNull();
    expect(isDestructiveChord("W", ["Meta"])).toMatch(/closes the tab/i);
  });

  it("does NOT match Shift-less rule when Shift is present", () => {
    // Primary+W vs Primary+Shift+W are distinct: the Shift-less rule for
    // close-tab must not fire when Shift is present (that's the window rule).
    const withShift = isDestructiveChord("KeyW", ["Meta", "Shift"]);
    expect(withShift).toMatch(/closes the window/i);
    expect(withShift).not.toMatch(/closes the tab/i);
  });
});
