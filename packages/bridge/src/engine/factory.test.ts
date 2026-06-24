import { describe, expect, it } from "vitest";
import { createChatEngineDrivers } from "./factory.js";

describe("createChatEngineDrivers", () => {
  it("registers claude, codex, and cursor", () => {
    const set = createChatEngineDrivers({ chatTransport: "headless" });
    expect(set.drivers.claude?.id).toBe("claude");
    expect(set.drivers.codex?.id).toBe("codex");
    expect(set.drivers.cursor?.id).toBe("cursor");
    expect(set.fallbacks.claude).toBeUndefined();
  });

  it("adds a claude headless fallback for terminal transport", () => {
    const set = createChatEngineDrivers({ chatTransport: "terminal" });
    expect(set.drivers.claude?.id).toBe("claude");
    expect(set.fallbacks.claude?.id).toBe("claude");
  });
});
