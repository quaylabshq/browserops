import { describe, expect, it } from "vitest";
import { buildCodexArgs } from "./driver.js";
import { codexLineToEvents } from "./normalize.js";

describe("CodexDriver args", () => {
  it("uses only flags supported by the current initial Codex exec contract", () => {
    expect(
      buildCodexArgs({
        prompt: "do it",
        safeMode: false,
        cwd: "/w",
        first: true,
      }),
    ).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-C",
      "/w",
      "--",
      "do it",
    ]);
  });

  it("resumes with the intentionally smaller resume flag surface", () => {
    expect(
      buildCodexArgs({
        prompt: "next",
        safeMode: true,
        cwd: "/w",
        first: false,
        nativeSessionId: "native-1",
      }),
    ).toEqual(["exec", "resume", "native-1", "--json", "--skip-git-repo-check", "--", "next"]);
  });
});

describe("codexLineToEvents", () => {
  it("normalizes assistant text and captures native session ids", () => {
    const out = codexLineToEvents({
      type: "assistant",
      session_id: "codex-native",
      message: { content: [{ text: "hello" }] },
      id: "m1",
    });
    expect(out.nativeSessionId).toBe("codex-native");
    expect(out.events).toEqual([
      {
        type: "message",
        message: { id: "m1", role: "assistant", blocks: [{ kind: "text", text: "hello" }] },
      },
    ]);
  });

  it("normalizes result events into final text without treating a provider item as a turn lifecycle", () => {
    const out = codexLineToEvents({ type: "result", result: "done", id: "r1" });
    expect(out.events).toEqual([
      {
        type: "message",
        message: { id: "r1", role: "assistant", blocks: [{ kind: "text", text: "done" }] },
      },
    ]);
  });

  it("treats a completed item as a message, not as an idle turn", () => {
    const out = codexLineToEvents({
      type: "item.completed",
      item: { id: "agent-1", type: "agent_message", text: "stream complete" },
    });
    expect(out.events).toEqual([
      {
        type: "message",
        message: {
          id: "agent-1",
          role: "assistant",
          blocks: [{ kind: "text", text: "stream complete" }],
        },
      },
    ]);
  });

  it("retains MCP server/tool/arguments so the UI can describe the action", () => {
    const start = codexLineToEvents({
      type: "item.started",
      item: {
        id: "mcp-1",
        type: "mcp_tool_call",
        server: "browserops",
        tool: "browser_click_by_text",
        arguments: '{"text":"Sign in"}',
        status: "in_progress",
      },
    });
    const completed = codexLineToEvents({
      type: "item.completed",
      item: {
        id: "mcp-1",
        type: "mcp_tool_call",
        server: "browserops",
        tool: "browser_click_by_text",
        result: { clicked: true },
        status: "completed",
      },
    });
    expect(start.events[0]).toMatchObject({
      type: "message",
      message: {
        blocks: [
          {
            kind: "tool_use",
            id: "mcp-1",
            name: "mcp__browserops__browser_click_by_text",
            input: { text: "Sign in" },
          },
        ],
      },
    });
    expect(completed.events[0]).toMatchObject({
      type: "message",
      message: { blocks: [{ kind: "tool_result", id: "mcp-1", ok: true }] },
    });
  });
});
