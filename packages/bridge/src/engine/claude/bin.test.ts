import { afterEach, describe, expect, it } from "vitest";
import { firstPathLine, resetBinCache, resolveClaudeBin } from "./bin.js";

afterEach(() => resetBinCache());

describe("firstPathLine", () => {
  it("picks the first absolute-looking path, skipping warnings", () => {
    expect(firstPathLine("/opt/homebrew/bin/claude\n")).toBe("/opt/homebrew/bin/claude");
    expect(firstPathLine("warning: slow\n/usr/local/bin/claude\n")).toBe("/usr/local/bin/claude");
    expect(firstPathLine("C:\\tools\\claude.exe")).toBe("C:\\tools\\claude.exe");
    expect(firstPathLine("command not found")).toBeNull();
    expect(firstPathLine(undefined)).toBeNull();
  });
});

describe("resolveClaudeBin", () => {
  it("short-circuits to an explicit override without touching PATH", () => {
    expect(resolveClaudeBin("/custom/claude")).toBe("/custom/claude");
  });
});
