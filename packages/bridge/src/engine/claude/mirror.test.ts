import { describe, expect, it } from "vitest";
import { mirrorEventLine, mirrorHeader, mirrorUserLine } from "./mirror.js";

describe("mirror formatting", () => {
  it("header carries the session id; user line carries the text", () => {
    expect(mirrorHeader("sess-abc")).toContain("sess-abc");
    const line = mirrorUserLine("read my last email");
    expect(line).toContain("you:");
    expect(line).toContain("read my last email");
  });

  it("renders assistant text, tool calls, and (failed) results", () => {
    expect(
      mirrorEventLine({
        type: "message",
        message: { id: "m", role: "assistant", blocks: [{ kind: "text", text: "on it" }] },
      }),
    ).toContain("assistant");

    expect(
      mirrorEventLine({
        type: "message",
        message: {
          id: "m",
          role: "assistant",
          blocks: [{ kind: "tool_use", id: "t", name: "browser_click", input: { x: 1 } }],
        },
      }),
    ).toContain("browser_click");

    const res = mirrorEventLine({
      type: "message",
      message: {
        id: "m",
        role: "tool",
        blocks: [{ kind: "tool_result", id: "t", ok: false, preview: "boom" }],
      },
    });
    expect(res).toContain("✗");
    expect(res).toContain("boom");
  });

  it("thinking + ejected show; idle/starting are silent", () => {
    expect(mirrorEventLine({ type: "status", state: "thinking" })).toContain("thinking");
    expect(mirrorEventLine({ type: "status", state: "ejected" })).toContain("taken over");
    expect(mirrorEventLine({ type: "status", state: "idle" })).toBeNull();
    expect(mirrorEventLine({ type: "status", state: "starting" })).toBeNull();
  });
});
