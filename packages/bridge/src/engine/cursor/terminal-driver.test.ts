import { describe, expect, it } from "vitest";
import {
  buildCursorInteractiveArgs,
  createCursorTranscriptReducer,
  cursorProjectSlug,
} from "./terminal-driver.js";

const ref = {
  agent: "cursor" as const,
  sessionId: "driver-1",
  cwd: "/Users/me/.browserops/workspace",
  createdAt: 1,
};

describe("buildCursorInteractiveArgs", () => {
  it("starts the regular TUI without converting it to print-mode automation", () => {
    expect(buildCursorInteractiveArgs({ ref, safeMode: false, resume: false })).toEqual([
      "--workspace",
      "/Users/me/.browserops/workspace",
    ]);
    expect(cursorProjectSlug(ref.cwd)).toBe("Users-me-browserops-workspace");
  });

  it("resumes the native Cursor chat after a bridge restart", () => {
    expect(
      buildCursorInteractiveArgs({
        ref: { ...ref, nativeSessionId: "chat-1" },
        safeMode: false,
        resume: true,
      }),
    ).toEqual(["--resume", "chat-1"]);
  });
});

describe("createCursorTranscriptReducer", () => {
  it("drops Cursor's timestamp wrapper and normalizes a completed turn", () => {
    const reducer = createCursorTranscriptReducer();
    const user = reducer.push({
      role: "user",
      message: {
        content: [
          {
            type: "text",
            text: "<timestamp>now</timestamp>\n<user_query>Read my email.</user_query>",
          },
        ],
      },
    });
    expect(user.events).toMatchObject([
      { type: "message", message: { role: "user", blocks: [{ text: "Read my email." }] } },
    ]);

    const assistant = reducer.push({
      role: "assistant",
      message: { content: [{ type: "text", text: "I will check the inbox." }] },
    });
    expect(assistant.events).toMatchObject([
      {
        type: "message",
        message: { role: "assistant", blocks: [{ kind: "text", text: "I will check the inbox." }] },
      },
    ]);
    expect(reducer.push({ type: "turn_ended", status: "success" }).events).toEqual([
      { type: "status", state: "idle" },
    ]);
  });
});
