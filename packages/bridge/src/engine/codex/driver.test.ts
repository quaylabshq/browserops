import { describe, expect, it } from "vitest";
import { buildCodexArgs } from "./driver.js";
import { codexLineToEvents } from "./normalize.js";

describe("CodexDriver args", () => {
  it("uses JSON, workspace-write sandbox, and modern approval bypass by default", () => {
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
      "--ask-for-approval",
      "never",
      "-C",
      "/w",
      "--",
      "do it",
    ]);
  });

  it("resumes when a native session id is known and omits approval override in safe mode", () => {
    expect(
      buildCodexArgs({
        prompt: "next",
        safeMode: true,
        cwd: "/w",
        first: false,
        nativeSessionId: "native-1",
      }),
    ).toEqual([
      "exec",
      "resume",
      "native-1",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-C",
      "/w",
      "--",
      "next",
    ]);
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

  it("normalizes result events into final text plus idle", () => {
    const out = codexLineToEvents({ type: "result", result: "done", id: "r1" });
    expect(out.events).toEqual([
      {
        type: "message",
        message: { id: "r1", role: "assistant", blocks: [{ kind: "text", text: "done" }] },
      },
      { type: "status", state: "idle" },
    ]);
  });
});
