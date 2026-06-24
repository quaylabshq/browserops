import { describe, it, expect } from "vitest";
import { AGENTS, DEFAULT_AGENT_ID, canChatAgent, getAgent, isLaunchableAgent } from "./agents.js";

describe("agent registry", () => {
  it("ships claude, codex, and cursor enabled for chat", () => {
    expect(getAgent("claude")?.enabled).toBe(true);
    expect(getAgent("codex")?.enabled).toBe(true);
    expect(getAgent("cursor")?.enabled).toBe(true);
  });

  it("every agent declares both capabilities", () => {
    for (const a of AGENTS) {
      expect(typeof a.caps.launch).toBe("boolean");
      expect(typeof a.caps.chat).toBe("boolean");
    }
  });

  it("claude can launch + chat; codex/cursor are chat-only in the extension", () => {
    expect(getAgent("claude")?.caps).toEqual({ launch: true, chat: true });
    expect(getAgent("codex")?.caps).toEqual({ launch: false, chat: true });
    expect(getAgent("cursor")?.caps).toEqual({ launch: false, chat: true });
  });

  it("canChatAgent is true only for known + chat-capable ids", () => {
    expect(canChatAgent("claude")).toBe(true);
    expect(canChatAgent("codex")).toBe(true);
    expect(canChatAgent("cursor")).toBe(true);
    expect(canChatAgent("ghost")).toBe(false);
    expect(canChatAgent("")).toBe(false);
  });

  it("disabled agents carry a note for the UI", () => {
    for (const a of AGENTS.filter((x) => !x.enabled)) {
      expect(a.note).toBeTruthy();
    }
  });

  it("default agent is a real, enabled agent", () => {
    expect(getAgent(DEFAULT_AGENT_ID)?.enabled).toBe(true);
  });

  it("getAgent returns undefined for unknown ids", () => {
    expect(getAgent("ghost")).toBeUndefined();
    expect(getAgent("")).toBeUndefined();
  });

  it("isLaunchableAgent is true only for known + enabled ids", () => {
    expect(isLaunchableAgent("claude")).toBe(true);
    expect(isLaunchableAgent("codex")).toBe(false);
    expect(isLaunchableAgent("ghost")).toBe(false);
  });

  it("ids are unique", () => {
    const ids = AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
