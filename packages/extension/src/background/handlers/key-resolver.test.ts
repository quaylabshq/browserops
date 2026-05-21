import { describe, expect, it } from "vitest";
import { resolveKey } from "./key-resolver";

describe("resolveKey", () => {
  describe("named special keys", () => {
    it.each<[string, { key: string; code: string; vkCode: number; text?: string }]>([
      ["Enter",      { key: "Enter",      code: "Enter",      vkCode: 13 }],
      ["Tab",        { key: "Tab",        code: "Tab",        vkCode:  9 }],
      ["Escape",     { key: "Escape",     code: "Escape",     vkCode: 27 }],
      ["Backspace",  { key: "Backspace",  code: "Backspace",  vkCode:  8 }],
      ["Delete",     { key: "Delete",     code: "Delete",     vkCode: 46 }],
      ["Space",      { key: " ",          code: "Space",      vkCode: 32, text: " " }],
      ["ArrowUp",    { key: "ArrowUp",    code: "ArrowUp",    vkCode: 38 }],
      ["ArrowDown",  { key: "ArrowDown",  code: "ArrowDown",  vkCode: 40 }],
      ["ArrowLeft",  { key: "ArrowLeft",  code: "ArrowLeft",  vkCode: 37 }],
      ["ArrowRight", { key: "ArrowRight", code: "ArrowRight", vkCode: 39 }],
      ["Home",       { key: "Home",       code: "Home",       vkCode: 36 }],
      ["End",        { key: "End",        code: "End",        vkCode: 35 }],
      ["PageUp",     { key: "PageUp",     code: "PageUp",     vkCode: 33 }],
      ["PageDown",   { key: "PageDown",   code: "PageDown",   vkCode: 34 }],
      ["Insert",     { key: "Insert",     code: "Insert",     vkCode: 45 }],
      ["F1",         { key: "F1",         code: "F1",         vkCode: 112 }],
      ["F12",        { key: "F12",        code: "F12",        vkCode: 123 }],
    ])("%s", (token, expected) => {
      const tuple = resolveKey(token);
      expect(tuple.key).toBe(expected.key);
      expect(tuple.code).toBe(expected.code);
      expect(tuple.vkCode).toBe(expected.vkCode);
      if (expected.text !== undefined) expect(tuple.text).toBe(expected.text);
      else expect(tuple.text).toBeUndefined();
    });
  });

  describe("modifier keys (Shift/Control/Alt/Meta)", () => {
    it.each<[string, { code: string; vkCode: number }]>([
      ["Shift",   { code: "ShiftLeft",   vkCode: 16 }],
      ["Control", { code: "ControlLeft", vkCode: 17 }],
      ["Alt",     { code: "AltLeft",     vkCode: 18 }],
      ["Meta",    { code: "MetaLeft",    vkCode: 91 }],
    ])("%s carries the left-side code and matching vk", (token, expected) => {
      const tuple = resolveKey(token);
      expect(tuple.code).toBe(expected.code);
      expect(tuple.vkCode).toBe(expected.vkCode);
      expect(tuple.text).toBeUndefined();
    });
  });

  describe("event.code-style letter tokens", () => {
    it("KeyA resolves to lowercase 'a' with VK 65", () => {
      expect(resolveKey("KeyA")).toEqual({ key: "a", code: "KeyA", text: "a", vkCode: 65 });
    });

    it("KeyZ resolves to 'z' with VK 90", () => {
      expect(resolveKey("KeyZ")).toEqual({ key: "z", code: "KeyZ", text: "z", vkCode: 90 });
    });
  });

  describe("event.code-style digit tokens", () => {
    it("Digit0 resolves to '0' with VK 48", () => {
      expect(resolveKey("Digit0")).toEqual({ key: "0", code: "Digit0", text: "0", vkCode: 48 });
    });

    it("Digit9 resolves to '9' with VK 57", () => {
      expect(resolveKey("Digit9")).toEqual({ key: "9", code: "Digit9", text: "9", vkCode: 57 });
    });
  });

  describe("single printable characters", () => {
    it("lowercase letter 'a' resolves with derived code KeyA and VK 65", () => {
      expect(resolveKey("a")).toEqual({ key: "a", code: "KeyA", text: "a", vkCode: 65 });
    });

    it("uppercase letter 'A' resolves with code KeyA and VK 65", () => {
      expect(resolveKey("A")).toEqual({ key: "A", code: "KeyA", text: "A", vkCode: 65 });
    });

    it("digit '1' resolves with code Digit1 and VK 49", () => {
      expect(resolveKey("1")).toEqual({ key: "1", code: "Digit1", text: "1", vkCode: 49 });
    });

    it("a literal space ' ' resolves like the Space named key", () => {
      expect(resolveKey(" ")).toEqual({ key: " ", code: "Space", text: " ", vkCode: 32 });
    });

    it("a symbol like '@' is passed through with no portable code mapping", () => {
      const t = resolveKey("@");
      expect(t.key).toBe("@");
      expect(t.text).toBe("@");
      expect(t.code).toBe("");
      expect(t.vkCode).toBe("@".charCodeAt(0));
    });
  });

  describe("unknown tokens", () => {
    it("falls back to identity mapping with vkCode 0", () => {
      const t = resolveKey("MysteryKey");
      expect(t.key).toBe("MysteryKey");
      expect(t.code).toBe("MysteryKey");
      expect(t.vkCode).toBe(0);
      expect(t.text).toBeUndefined();
    });
  });

  describe("US-layout punctuation event.code names", () => {
    it.each<[string, { key: string; text: string; vkCode: number }]>([
      ["Slash",        { key: "/",  text: "/",  vkCode: 191 }],
      ["Period",       { key: ".",  text: ".",  vkCode: 190 }],
      ["Comma",        { key: ",",  text: ",",  vkCode: 188 }],
      ["Semicolon",    { key: ";",  text: ";",  vkCode: 186 }],
      ["Quote",        { key: "'",  text: "'",  vkCode: 222 }],
      ["Backquote",    { key: "`",  text: "`",  vkCode: 192 }],
      ["Minus",        { key: "-",  text: "-",  vkCode: 189 }],
      ["Equal",        { key: "=",  text: "=",  vkCode: 187 }],
      ["BracketLeft",  { key: "[",  text: "[",  vkCode: 219 }],
      ["BracketRight", { key: "]",  text: "]",  vkCode: 221 }],
      ["Backslash",    { key: "\\", text: "\\", vkCode: 220 }],
    ])("%s carries base-layer text", (token, expected) => {
      const tuple = resolveKey(token);
      expect(tuple.key).toBe(expected.key);
      expect(tuple.code).toBe(token);
      expect(tuple.text).toBe(expected.text);
      expect(tuple.vkCode).toBe(expected.vkCode);
    });
  });

  describe("shifted-text resolution under Shift mod", () => {
    it.each<[string, string]>([
      ["Digit1", "!"],
      ["Digit2", "@"],
      ["Digit3", "#"],
      ["Digit4", "$"],
      ["Digit5", "%"],
      ["Digit6", "^"],
      ["Digit7", "&"],
      ["Digit8", "*"],
      ["Digit9", "("],
      ["Digit0", ")"],
      ["Slash", "?"],
      ["Period", ">"],
      ["Comma", "<"],
      ["Semicolon", ":"],
      ["Quote", "\""],
      ["Backquote", "~"],
      ["Minus", "_"],
      ["Equal", "+"],
      ["BracketLeft", "{"],
      ["BracketRight", "}"],
      ["Backslash", "|"],
    ])("Shift+%s -> text:%s", (token, shifted) => {
      const tuple = resolveKey(token, { shift: true });
      expect(tuple.text).toBe(shifted);
      expect(tuple.key).toBe(shifted);
      // The code does NOT change under Shift — that matches real browser
      // KeyboardEvent semantics (event.code is the physical key, event.key
      // is the produced character).
      expect(tuple.code).toBe(token);
    });

    it("Shift+KeyA returns uppercase 'A'", () => {
      const t = resolveKey("KeyA", { shift: true });
      expect(t.key).toBe("A");
      expect(t.text).toBe("A");
      expect(t.code).toBe("KeyA");
      expect(t.vkCode).toBe(65);
    });

    it("Shift+Digit3 returns '#' (the classic Notion-H1 trigger)", () => {
      const t = resolveKey("Digit3", { shift: true });
      expect(t.text).toBe("#");
      expect(t.key).toBe("#");
    });

    it("Cmd+KeyA (meta chord) preserves text — downstream suppresses it", () => {
      // text is left intact by resolveKey; the cdpPress gate drops it under
      // ctrl/meta so Cmd+A doesn't insert a literal 'a'. Important: this
      // preserves the existing Cmd+A invariant.
      const t = resolveKey("KeyA", { meta: true });
      expect(t.text).toBe("a");
    });

    it("Ctrl+Shift+KeyA leaves text at 'a' (modifier chord, not pure-shift)", () => {
      const t = resolveKey("KeyA", { ctrl: true, shift: true });
      expect(t.text).toBe("a");
    });
  });
});
