import { describe, it, expect } from "vitest";
import {
  CHAT_ROLES,
  TERMINAL_MODES,
  isChatRole,
  isTerminalMode,
  type ChatEvent,
  type ChatMessage,
} from "./chat.js";

describe("chat vocabulary guards", () => {
  it("isChatRole accepts the four roles and rejects anything else", () => {
    for (const r of CHAT_ROLES) expect(isChatRole(r)).toBe(true);
    expect(isChatRole("toolresult")).toBe(false);
    expect(isChatRole("")).toBe(false);
    expect(isChatRole(undefined)).toBe(false);
    expect(isChatRole(3)).toBe(false);
  });

  it("isTerminalMode accepts only mirror/takeover", () => {
    for (const m of TERMINAL_MODES) expect(isTerminalMode(m)).toBe(true);
    expect(isTerminalMode("eject")).toBe(false);
    expect(isTerminalMode(null)).toBe(false);
  });
});

describe("normalized shapes compile to the intended unions", () => {
  it("a tool-call assistant turn carries discriminated blocks", () => {
    const msg: ChatMessage = {
      id: "m1",
      role: "assistant",
      blocks: [
        { kind: "thinking", text: "let me look" },
        { kind: "tool_use", id: "t1", name: "browser_read", input: { tab_id: "t_3" } },
        { kind: "text", text: "done" },
      ],
    };
    expect(msg.blocks.map((b) => b.kind)).toEqual(["thinking", "tool_use", "text"]);
  });

  it("ChatEvent is a tagged union over the streamed cases", () => {
    const events: ChatEvent[] = [
      { type: "session", ref: { agent: "claude", sessionId: "s", cwd: "/w", createdAt: 0 } },
      { type: "status", state: "thinking" },
      {
        type: "message",
        message: { id: "m", role: "user", blocks: [{ kind: "text", text: "hi" }] },
      },
      { type: "end", reason: "result" },
    ];
    expect(events.map((e) => e.type)).toEqual(["session", "status", "message", "end"]);
  });
});
