import { describe, expect, it } from "vitest";
import { CodexPtyDriver } from "./codex/terminal-driver.js";
import { CursorPtyDriver } from "./cursor/terminal-driver.js";
import { createChatEngineDrivers } from "./factory.js";

describe("createChatEngineDrivers", () => {
  it("registers claude, codex, and cursor", () => {
    const set = createChatEngineDrivers({ chatTransport: "headless" });
    expect(set.drivers.claude?.id).toBe("claude");
    expect(set.drivers.codex?.id).toBe("codex");
    expect(set.drivers.cursor?.id).toBe("cursor");
    expect(set.fallbacks.claude).toBeUndefined();
  });

  it("runs every provider through a terminal TUI with a headless fallback", () => {
    const set = createChatEngineDrivers({ chatTransport: "terminal" });
    expect(set.drivers.claude?.id).toBe("claude");
    expect(set.drivers.codex?.id).toBe("codex");
    expect(set.drivers.cursor?.id).toBe("cursor");
    expect(set.drivers.codex).toBeInstanceOf(CodexPtyDriver);
    expect(set.drivers.cursor).toBeInstanceOf(CursorPtyDriver);
    expect(set.fallbacks.claude?.id).toBe("claude");
    expect(set.fallbacks.codex?.id).toBe("codex");
    expect(set.fallbacks.cursor?.id).toBe("cursor");
  });
});
