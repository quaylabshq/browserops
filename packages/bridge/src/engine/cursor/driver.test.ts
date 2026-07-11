import { describe, expect, it } from "vitest";
import { buildCursorArgs, CursorDriver } from "./driver.js";
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

  it("correlates Cursor tool starts and results with the documented call_id", () => {
    const start = cursorLineToEvents({
      type: "tool_call",
      subtype: "started",
      call_id: "toolu_123",
      tool_call: { writeToolCall: { args: { path: "summary.txt" } } },
    });
    const complete = cursorLineToEvents({
      type: "tool_call",
      subtype: "completed",
      call_id: "toolu_123",
      tool_call: { writeToolCall: { result: { success: true } } },
    });
    expect(start.events[0]).toMatchObject({
      type: "message",
      message: { blocks: [{ kind: "tool_use", id: "toolu_123", name: "writeToolCall" }] },
    });
    expect(complete.events[0]).toMatchObject({
      type: "message",
      message: { blocks: [{ kind: "tool_result", id: "toolu_123", ok: true }] },
    });
  });

  it("keeps each contiguous Cursor stream in one assistant bubble", () => {
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

  it("assigns a resumed stream to a new assistant message after a tool pause", () => {
    const driver = new CursorDriver({ bin: "agent" });
    const normalize = (
      driver as unknown as {
        normalizeLine(
          raw: unknown,
          context: { turnId: string },
        ): ReturnType<typeof cursorLineToEvents>;
      }
    ).normalizeLine.bind(driver);

    const first = normalize(
      { type: "assistant", message: { content: [{ text: "Before the tool." }] } },
      { turnId: "turn-1" },
    );
    const tool = normalize(
      {
        type: "tool_call",
        subtype: "started",
        call_id: "tool-1",
        tool_call: { browserAction: { args: { task: "read" } } },
      },
      { turnId: "turn-1" },
    );
    const resumed = normalize(
      { type: "assistant", message: { content: [{ text: "After the tool." }] } },
      { turnId: "turn-1" },
    );
    const terminal = normalize(
      { type: "result", result: "Before the tool. After the tool." },
      { turnId: "turn-1" },
    );

    expect(first.events[0]).toMatchObject({
      type: "message",
      message: { id: "turn-1-assistant", partial: true },
    });
    expect(tool.events[0]).toMatchObject({ type: "message", message: { role: "assistant" } });
    expect(resumed.events[0]).toMatchObject({
      type: "message",
      message: { id: "turn-1-assistant-2", partial: true },
    });
    // The terminal Cursor result aggregates already-streamed text, so it must
    // not replace the second bubble with a duplicate of both streams.
    expect(terminal.events).toEqual([{ type: "status", state: "idle" }]);
  });

  it("treats unlabelled assistant output as turn-scoped stream content", () => {
    const out = cursorLineToEvents(
      { type: "assistant", message: { content: [{ text: "streamed" }] } },
      "turn-2",
    );
    expect(out.events[0]).toMatchObject({
      type: "message",
      message: { id: "turn-2-assistant", partial: true },
    });
  });
});
