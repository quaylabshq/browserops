import { describe, expect, it } from "vitest";
import { TOOL_DEFS, TOOL_DEF_MAP } from "./tools.js";
import { ERROR_CODES } from "./errors.js";

describe("TOOL_DEFS catalogue", () => {
  it("contains 20 v1 tools", () => {
    expect(TOOL_DEFS).toHaveLength(20);
  });

  it("every tool name is prefixed browser. and unique", () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.startsWith("browser.")).toBe(true);
  });

  it("TOOL_DEF_MAP matches the array", () => {
    for (const t of TOOL_DEFS) {
      expect(TOOL_DEF_MAP[t.name]).toBe(t);
    }
  });

  it("action_weight is 0, 0.5, or 1", () => {
    for (const t of TOOL_DEFS) {
      expect([0, 0.5, 1]).toContain(t.action_weight);
    }
  });

  it("risky is always / conditional / never", () => {
    for (const t of TOOL_DEFS) {
      expect(["always", "conditional", "never"]).toContain(t.risky);
    }
  });

  it("error codes are all in the canonical set", () => {
    const canonical = new Set<string>(ERROR_CODES);
    for (const t of TOOL_DEFS) {
      for (const code of t.errorCodes) {
        expect(canonical.has(code)).toBe(true);
      }
    }
  });

  it("execute_js is always risky", () => {
    const exec = TOOL_DEF_MAP["browser.execute_js"];
    expect(exec?.risky).toBe("always");
  });

  it("click and type are conditional risky", () => {
    expect(TOOL_DEF_MAP["browser.click"]?.risky).toBe("conditional");
    expect(TOOL_DEF_MAP["browser.type"]?.risky).toBe("conditional");
  });

  it("read and screenshot cost 0.5", () => {
    expect(TOOL_DEF_MAP["browser.read"]?.action_weight).toBe(0.5);
    expect(TOOL_DEF_MAP["browser.screenshot"]?.action_weight).toBe(0.5);
  });

  it("observation tools cost 0", () => {
    expect(TOOL_DEF_MAP["browser.list_tabs"]?.action_weight).toBe(0);
    expect(TOOL_DEF_MAP["browser.current_tab"]?.action_weight).toBe(0);
    expect(TOOL_DEF_MAP["browser.wait_for"]?.action_weight).toBe(0);
  });
});
