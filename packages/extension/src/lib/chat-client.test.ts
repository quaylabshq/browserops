import { describe, it, expect } from "vitest";
import type { ChatEvent, ChatMessage } from "@browserops/shared";
import {
  appendUserMessage,
  buildNewBody,
  chatBase,
  chatCancel,
  collectToolActivity,
  initialChatState,
  ptyInputFrame,
  ptyResizeFrame,
  ptyUrl,
  reduceChat,
  statusLabel,
  streamUrl,
} from "./chat-client.js";

describe("buildNewBody", () => {
  it("includes token/agent/url and maps siteName → site_name; drops empties", () => {
    expect(
      buildNewBody({
        token: "t",
        agent: "claude",
        instruction: "  do it  ",
        meta: { url: "https://x", title: "T", siteName: "S", description: "" },
      }),
    ).toEqual({
      token: "t",
      agent: "claude",
      url: "https://x",
      instruction: "do it",
      title: "T",
      site_name: "S",
    });
  });
});

describe("reduceChat", () => {
  const msg = (id: string, role: ChatMessage["role"], text: string): ChatMessage => ({
    id,
    role,
    blocks: [{ kind: "text", text }],
  });

  it("captures the session ref", () => {
    const ref = { agent: "claude" as const, sessionId: "s1", cwd: "/w", createdAt: 1 };
    const state = reduceChat(initialChatState(), { type: "session", ref });
    expect(state.session).toEqual(ref);
  });

  it("appends messages and replaces by id on re-emit", () => {
    let s = initialChatState();
    s = reduceChat(s, { type: "message", message: msg("a", "assistant", "one") });
    s = reduceChat(s, { type: "message", message: msg("b", "tool", "two") });
    s = reduceChat(s, { type: "message", message: msg("a", "assistant", "one-updated") });
    expect(s.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(s.messages[0]!.blocks[0]).toEqual({ kind: "text", text: "one-updated" });
  });

  it("reconciles an optimistic user echo with its transcript record (no duplicate)", () => {
    let s = appendUserMessage(initialChatState(), "hello there");
    const optimisticId = s.messages[0]!.id;
    expect(optimisticId.startsWith("local-")).toBe(true);

    // The pty tailer later emits the same turn as a real transcript record (uuid
    // id, flattened text) — adopt the id, keep the original text, no 2nd bubble.
    s = reduceChat(s, {
      type: "message",
      message: { id: "u-uuid", role: "user", blocks: [{ kind: "text", text: "hello there" }] },
    });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.id).toBe("u-uuid");
    expect(s.messages[0]!.blocks[0]).toEqual({ kind: "text", text: "hello there" });
  });

  it("a user turn with no pending optimistic echo appends (live read-only mirror)", () => {
    const s = reduceChat(initialChatState(), {
      type: "message",
      message: { id: "u-ext", role: "user", blocks: [{ kind: "text", text: "typed in terminal" }] },
    });
    expect(s.messages.map((m) => m.id)).toEqual(["u-ext"]);
  });

  it("suppresses a repeated provider echo of an already-rendered user message", () => {
    let s = reduceChat(initialChatState(), {
      type: "message",
      message: { id: "canonical", role: "user", blocks: [{ kind: "text", text: "open docs" }] },
    });
    s = reduceChat(s, {
      type: "message",
      message: { id: "provider-echo", role: "user", blocks: [{ kind: "text", text: "open docs" }] },
    });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.id).toBe("canonical");
  });

  it("tracks status, latches ejected, and drops terminal capabilities on eject", () => {
    let s = {
      ...initialChatState(),
      capabilities: {
        embeddedTerminal: true,
        externalTakeover: true,
        migrationSource: true,
        migrationTarget: true,
      },
    };
    s = reduceChat(s, { type: "status", state: "thinking" });
    expect(s.status).toBe("thinking");
    expect(s.capabilities.embeddedTerminal).toBe(true); // still live
    s = reduceChat(s, { type: "status", state: "ejected" });
    expect(s.ejected).toBe(true);
    expect(s.capabilities.embeddedTerminal).toBe(false); // pty handed to the external terminal
    expect(s.capabilities.externalTakeover).toBe(false);
    s = reduceChat(s, { type: "status", state: "idle" });
    expect(s.status).toBe("idle");
    expect(s.ejected).toBe(true); // latched
  });

  it("end resets status to idle", () => {
    const s = reduceChat(
      { ...initialChatState(), status: "thinking" },
      { type: "end", reason: "x" },
    );
    expect(s.status).toBe("idle");
  });
});

describe("collectToolActivity", () => {
  it("collapses tool use and result into one completed browser action", () => {
    const activity = collectToolActivity([
      {
        id: "call",
        role: "assistant",
        blocks: [
          { kind: "tool_use", id: "tool-1", name: "browser_observe", input: { tab_id: "t1" } },
        ],
      },
      {
        id: "result",
        role: "tool",
        blocks: [{ kind: "tool_result", id: "tool-1", ok: true, preview: "Page inspected" }],
      },
    ]);
    expect(activity).toMatchObject({ active: false, completed: 1 });
    expect(activity.items).toEqual([
      expect.objectContaining({
        id: "tool-1",
        label: "Inspecting the page",
        active: false,
        ok: true,
        result: "Page inspected",
      }),
    ]);
  });

  it("keeps an incomplete call live for the animated activity banner", () => {
    const activity = collectToolActivity([
      {
        id: "call",
        role: "assistant",
        blocks: [
          { kind: "tool_use", id: "tool-2", name: "browser_type", input: { text: "hello" } },
        ],
      },
    ]);
    expect(activity).toMatchObject({ active: true, completed: 0 });
    expect(activity.latest).toMatchObject({ label: "Entering text", active: true });
  });

  it("turns BrowserOps tool inputs into a user-readable action", () => {
    const activity = collectToolActivity([
      {
        id: "call",
        role: "assistant",
        blocks: [
          {
            kind: "tool_use",
            id: "tool-3",
            name: "mcp__browserops__browser_click_by_text",
            input: { text: "Sign in", role: "button" },
          },
        ],
      },
    ]);
    expect(activity.latest).toMatchObject({ label: "Clicking “Sign in”", detail: "button" });
  });
});

describe("appendUserMessage", () => {
  it("optimistically appends a user turn and flips to thinking", () => {
    const s = appendUserMessage(initialChatState(), "hello");
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.role).toBe("user");
    expect(s.messages[0]!.blocks[0]).toEqual({ kind: "text", text: "hello" });
    expect(s.status).toBe("thinking");
  });
});

describe("statusLabel", () => {
  it("prefers the ejected message, else maps status to copy", () => {
    expect(statusLabel("thinking", true)).toBe("Controlled in your terminal");
    expect(statusLabel("thinking", false)).toBe("Working…");
    expect(statusLabel("error", false)).toBe("Something went wrong");
    expect(statusLabel("error", false, "agent_not_found", "codex")).toContain("Codex CLI");
    expect(statusLabel("error", false, "exit_1: authentication failed", "cursor")).toContain(
      "authentication failed",
    );
    expect(statusLabel("idle", false)).toBe("");
  });
});

describe("streamUrl", () => {
  it("encodes token + session id into the SSE url", () => {
    const url = streamUrl("tok en", "s/1");
    expect(url).toContain("/chat/stream?token=tok%20en");
    expect(url).toContain("session_id=s%2F1");
  });
});

describe("chatCancel", () => {
  it("sends the session id to the cancellation endpoint", async () => {
    const originalFetch = globalThis.fetch;
    let request: Request | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      await expect(chatCancel("token", "session-1")).resolves.toMatchObject({ ok: true });
      expect(request?.url).toContain("/chat/cancel");
      expect(await request?.text()).toBe(
        JSON.stringify({ token: "token", session_id: "session-1" }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("chatBase", () => {
  it("uses the paired host and port rather than assuming the default loopback port", () => {
    expect(chatBase({ host: "localhost", port: 9876 })).toBe("http://localhost:9876");
  });
});

describe("ptyUrl / pty frames", () => {
  it("builds a ws:// url with token + session id in the query", () => {
    const url = ptyUrl("tok en", "s/1");
    expect(url.startsWith("ws://127.0.0.1:57321/chat/pty?")).toBe(true);
    expect(url).toContain("token=tok%20en");
    expect(url).toContain("session_id=s%2F1");
  });
  it("frames input and resize as JSON", () => {
    expect(ptyInputFrame("a\r")).toBe(JSON.stringify({ type: "input", data: "a\r" }));
    expect(ptyResizeFrame(80, 24)).toBe(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
  });
});

// Keep the unused-import checker happy about the ChatEvent type re-export.
const _evt: ChatEvent = { type: "end", reason: "x" };
void _evt;
