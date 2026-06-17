import { describe, it, expect } from "vitest";
import type { ChatEvent, ChatMessage } from "@browserops/shared";
import {
  appendUserMessage,
  buildNewBody,
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

  it("tracks status, latches ejected, and drops terminalCapable on eject", () => {
    let s = { ...initialChatState(), terminalCapable: true };
    s = reduceChat(s, { type: "status", state: "thinking" });
    expect(s.status).toBe("thinking");
    expect(s.terminalCapable).toBe(true); // still live
    s = reduceChat(s, { type: "status", state: "ejected" });
    expect(s.ejected).toBe(true);
    expect(s.terminalCapable).toBe(false); // pty handed to the external terminal
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
