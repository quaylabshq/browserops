import { describe, expect, it } from "vitest";
import { buildCursorArgs } from "./driver.js";
import { cursorLineToEvents } from "./normalize.js";

describe("CursorDriver args", () => {
  it("uses headless stream-json flags and force outside safe mode", () => {
    expect(
      buildCursorArgs({
        prompt: "do it",
        safeMode: false,
        cwd: "/w",
        first: true,
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--trust",
      "--workspace",
      "/w",
      "--force",
      "do it",
    ]);
  });

  it("omits force in safe mode", () => {
    expect(
      buildCursorArgs({
        prompt: "do it",
        safeMode: true,
        cwd: "/w",
        first: true,
      }),
    ).not.toContain("--force");
  });
});

describe("cursorLineToEvents", () => {
  it("normalizes assistant stream messages", () => {
    const out = cursorLineToEvents({
      type: "assistant",
      chatId: "cursor-native",
      message: { content: [{ text: "hello" }] },
      id: "m1",
    });
    expect(out.nativeSessionId).toBe("cursor-native");
    expect(out.events).toEqual([
      {
        type: "message",
        message: {
          id: "cursor-assistant-m1",
          role: "assistant",
          blocks: [{ kind: "text", text: "hello" }],
        },
      },
    ]);
  });

  it("normalizes tool completion events", () => {
    const out = cursorLineToEvents({
      type: "tool_call",
      subtype: "completed",
      tool_call: { readToolCall: { result: { success: { totalLines: 4 } } } },
      id: "t1",
    });
    expect(out.events[0]).toMatchObject({
      type: "message",
      message: { id: "cursor-tool-result-t1", role: "tool" },
    });
  });

  it("keeps Cursor partial output in one assistant bubble for a turn", () => {
    const partial = cursorLineToEvents(
      { type: "assistant", timestamp_ms: 1, message: { content: [{ text: "hel" }] } },
      "turn-1",
    );
    const complete = cursorLineToEvents({ type: "result", result: "hello" }, "turn-1");
    expect(partial.events[0]).toMatchObject({
      type: "message",
      message: { id: "turn-1-assistant", partial: true },
    });
    expect(complete.events[0]).toMatchObject({
      type: "message",
      message: { id: "turn-1-assistant" },
    });
    const final = complete.events[0];
    expect(final?.type === "message" ? final.message.partial : undefined).toBeUndefined();
  });
});
