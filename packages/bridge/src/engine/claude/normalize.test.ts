import { describe, it, expect } from "vitest";
import {
  liveEventToEvents,
  messageIdOf,
  normalizeContent,
  normalizeMessage,
  parseInit,
  previewToolResult,
} from "./normalize.js";

// Fixtures captured verbatim from a real `claude --output-format stream-json`
// run (v2.1.153) and the on-disk transcript shapes.
const INIT = {
  type: "system",
  subtype: "init",
  cwd: "/private/tmp",
  session_id: "29ff382a-4954-47a6-b484-6d5320aa0a7d",
  tools: ["Bash", "Read"],
  model: "claude-opus-4-7[1m]",
};
const ASSISTANT_TEXT = {
  type: "assistant",
  message: { role: "assistant", id: "msg_1", content: [{ type: "text", text: "pong" }] },
  session_id: "29ff382a",
  uuid: "bce08d3d-2ce2-4ec2-a9d8-b5d003111d3c",
};
const RESULT_OK = { type: "result", subtype: "success", is_error: false, result: "pong" };
const RATE_OK = { type: "rate_limit_event", rate_limit_info: { status: "allowed" } };

// Assistant thinking + tool_use (from on-disk shapes; live sends them in one event).
const ASSISTANT_WORK = {
  type: "assistant",
  uuid: "u-work",
  message: {
    role: "assistant",
    id: "msg_work",
    content: [
      { type: "thinking", thinking: "let me look", signature: "sig==" },
      { type: "tool_use", id: "toolu_1", name: "browser_read", input: { tab_id: "t_3" } },
    ],
  },
};
const USER_TOOL_RESULT = {
  type: "user",
  uuid: "u-tr",
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "Launching skill: browserops" },
    ],
  },
};

describe("normalizeContent", () => {
  it("wraps a bare string as a single text block", () => {
    expect(normalizeContent("read my last email")).toEqual([
      { kind: "text", text: "read my last email" },
    ]);
  });

  it("drops empty text/thinking blocks (Claude writes empty thinking)", () => {
    expect(normalizeContent([{ type: "thinking", thinking: "", signature: "x" }])).toEqual([]);
    expect(normalizeContent("   ")).toEqual([]);
  });

  it("maps the four block kinds, stripping the thinking signature", () => {
    expect(
      normalizeContent([
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "tool_use", id: "t1", name: "browser_click", input: { x: 1 } },
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
        { type: "text", text: "done" },
      ]),
    ).toEqual([
      { kind: "thinking", text: "hmm" },
      { kind: "tool_use", id: "t1", name: "browser_click", input: { x: 1 } },
      { kind: "tool_result", id: "t1", ok: true, preview: "ok" },
      { kind: "text", text: "done" },
    ]);
  });

  it("marks a failed tool_result not-ok", () => {
    expect(
      normalizeContent([
        { type: "tool_result", tool_use_id: "t9", is_error: true, content: "boom" },
      ]),
    ).toEqual([{ kind: "tool_result", id: "t9", ok: false, preview: "boom" }]);
  });
});

describe("previewToolResult", () => {
  it("joins text-block arrays and caps very long output", () => {
    expect(
      previewToolResult([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
    expect(previewToolResult("x".repeat(5000)).endsWith("…")).toBe(true);
  });
});

describe("normalizeMessage", () => {
  it("normalizes a real assistant text turn", () => {
    expect(normalizeMessage(ASSISTANT_TEXT.message, { id: "m" })).toEqual({
      id: "m",
      role: "assistant",
      blocks: [{ kind: "text", text: "pong" }],
    });
  });

  it("classifies a tool-result-only user message as the tool role", () => {
    const msg = normalizeMessage(USER_TOOL_RESULT.message, { id: "m", ts: 5 });
    expect(msg?.role).toBe("tool");
    expect(msg?.ts).toBe(5);
  });

  it("returns null when nothing renderable survives", () => {
    expect(normalizeMessage({ role: "assistant", content: [] }, { id: "m" })).toBeNull();
    expect(
      normalizeMessage(
        { role: "assistant", content: [{ type: "thinking", thinking: "" }] },
        { id: "m" },
      ),
    ).toBeNull();
  });
});

describe("parseInit / messageIdOf", () => {
  it("extracts session_id + cwd from the init envelope", () => {
    expect(parseInit(INIT)).toEqual({
      sessionId: "29ff382a-4954-47a6-b484-6d5320aa0a7d",
      cwd: "/private/tmp",
    });
    expect(parseInit(ASSISTANT_TEXT)).toBeNull();
  });

  it("reads the grouping message.id from a record", () => {
    expect(messageIdOf(ASSISTANT_WORK)).toBe("msg_work");
    expect(messageIdOf(USER_TOOL_RESULT)).toBeUndefined();
  });
});

describe("liveEventToEvents", () => {
  it("init yields nothing (runtime owns the session)", () => {
    expect(liveEventToEvents(INIT)).toEqual([]);
  });

  it("an assistant event becomes a message event", () => {
    expect(liveEventToEvents(ASSISTANT_TEXT)).toEqual([
      {
        type: "message",
        message: {
          id: "bce08d3d-2ce2-4ec2-a9d8-b5d003111d3c",
          role: "assistant",
          blocks: [{ kind: "text", text: "pong" }],
        },
      },
    ]);
  });

  it("a multi-block assistant event keeps thinking + tool_use together", () => {
    const [evt] = liveEventToEvents(ASSISTANT_WORK);
    expect(evt?.type).toBe("message");
    if (evt?.type === "message") {
      expect(evt.message.blocks.map((b) => b.kind)).toEqual(["thinking", "tool_use"]);
    }
  });

  it("a tool_result user event becomes a tool message", () => {
    const [evt] = liveEventToEvents(USER_TOOL_RESULT);
    expect(evt?.type === "message" && evt.message.role).toBe("tool");
  });

  it("result closes the turn as idle (or error)", () => {
    expect(liveEventToEvents(RESULT_OK)).toEqual([{ type: "status", state: "idle" }]);
    expect(
      liveEventToEvents({ type: "result", is_error: true, subtype: "error_max_turns" }),
    ).toEqual([{ type: "status", state: "error", detail: "error_max_turns" }]);
  });

  it("an allowed rate-limit event is silent; a blocked one is an error status", () => {
    expect(liveEventToEvents(RATE_OK)).toEqual([]);
    expect(
      liveEventToEvents({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }),
    ).toEqual([{ type: "status", state: "error", detail: "rate_limited" }]);
  });
});
