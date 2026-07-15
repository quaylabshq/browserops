import { describe, expect, it } from "vitest";
import { buildCodexInteractiveArgs, createCodexTranscriptReducer } from "./terminal-driver.js";

const ref = {
  agent: "codex" as const,
  sessionId: "driver-1",
  cwd: "/work",
  createdAt: 1,
};

describe("buildCodexInteractiveArgs", () => {
  it("starts a native TUI with BrowserOps MCP auto-approval outside safe mode", () => {
    expect(buildCodexInteractiveArgs({ ref, safeMode: false, resume: false })).toEqual([
      "--no-alt-screen",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "-c",
      'mcp_servers.browserops.default_tools_approval_mode="auto"',
      "-C",
      "/work",
    ]);
  });

  it("resumes the provider's persisted interactive session", () => {
    expect(
      buildCodexInteractiveArgs({
        ref: { ...ref, nativeSessionId: "native-1" },
        safeMode: false,
        resume: true,
      }),
    ).toEqual([
      "resume",
      "native-1",
      "--no-alt-screen",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "-c",
      'mcp_servers.browserops.default_tools_approval_mode="auto"',
      "-C",
      "/work",
    ]);
  });
});

describe("createCodexTranscriptReducer", () => {
  it("normalizes the native session id, messages, tools, and turn completion", () => {
    const reducer = createCodexTranscriptReducer();
    expect(
      reducer.push({
        type: "session_meta",
        payload: { session_id: "native-1" },
      }),
    ).toMatchObject({ nativeSessionId: "native-1" });

    const user = reducer.push({
      type: "response_item",
      payload: {
        type: "message",
        id: "u1",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    });
    expect(user.events).toMatchObject([
      { type: "message", message: { id: "u1", role: "user", blocks: [{ text: "hello" }] } },
    ]);

    const tool = reducer.push({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "call-1",
        name: "mcp__browserops__browser_list_tabs",
        input: {},
        status: "completed",
      },
    });
    expect(tool.events).toMatchObject([
      {
        type: "message",
        message: { role: "assistant", blocks: [{ kind: "tool_use", id: "call-1" }] },
      },
      {
        type: "message",
        message: { role: "tool", blocks: [{ kind: "tool_result", id: "call-1", ok: true }] },
      },
    ]);

    expect(reducer.push({ type: "event_msg", payload: { type: "task_complete" } }).events).toEqual([
      { type: "status", state: "idle" },
    ]);
  });
});
