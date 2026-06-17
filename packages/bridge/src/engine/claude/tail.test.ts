import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "@browserops/shared";
import { stopReasonOf } from "./normalize.js";
import { IncrementalTranscript, TranscriptTailer, detectTurnState } from "./tail.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- record builders (the on-disk camelCase wrapper + inner Anthropic message) ---
const userText = (uuid: string, text: string, timestamp?: string) => ({
  type: "user",
  uuid,
  ...(timestamp ? { timestamp } : {}),
  message: { role: "user", content: text },
});
const asstThinking = (uuid: string, id: string) => ({
  type: "assistant",
  uuid,
  message: {
    role: "assistant",
    id,
    content: [{ type: "thinking", thinking: "reason", signature: "s" }],
  },
});
const asstTool = (uuid: string, id: string, stop_reason: string) => ({
  type: "assistant",
  uuid,
  message: {
    role: "assistant",
    id,
    stop_reason,
    content: [{ type: "tool_use", id: "t1", name: "browser_read", input: {} }],
  },
});
const toolResult = (uuid: string) => ({
  type: "user",
  uuid,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
});
const asstText = (uuid: string, id: string, text: string, stop_reason: string) => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", id, stop_reason, content: [{ type: "text", text }] },
});
const jsonl = (recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("stopReasonOf", () => {
  it("reads message.stop_reason; undefined for user / missing / non-objects", () => {
    expect(stopReasonOf({ type: "assistant", message: { stop_reason: "end_turn" } })).toBe(
      "end_turn",
    );
    expect(
      stopReasonOf({ type: "user", message: { role: "user", content: "hi" } }),
    ).toBeUndefined();
    expect(stopReasonOf({ message: null })).toBeUndefined();
    expect(stopReasonOf("nope")).toBeUndefined();
  });
});

describe("detectTurnState", () => {
  const q = 1000;
  it("idles immediately on a terminal stop_reason regardless of activity", () => {
    expect(detectTurnState({ stopReason: "end_turn", msSinceActivity: 0, quiescenceMs: q })).toBe(
      "idle",
    );
    expect(
      detectTurnState({ stopReason: "stop_sequence", msSinceActivity: 0, quiescenceMs: q }),
    ).toBe("idle");
  });
  it("is thinking while a tool_use turn is active and recent", () => {
    expect(detectTurnState({ stopReason: "tool_use", msSinceActivity: 10, quiescenceMs: q })).toBe(
      "thinking",
    );
    expect(detectTurnState({ stopReason: undefined, msSinceActivity: 10, quiescenceMs: q })).toBe(
      "thinking",
    );
  });
  it("idles on quiescence even without a terminal stop (interrupt / human turn)", () => {
    expect(
      detectTurnState({ stopReason: "tool_use", msSinceActivity: 1000, quiescenceMs: q }),
    ).toBe("idle");
    expect(detectTurnState({ stopReason: undefined, msSinceActivity: 1500, quiescenceMs: q })).toBe(
      "idle",
    );
  });
});

describe("IncrementalTranscript", () => {
  const turn = [
    userText("u1", "read my email", "2026-06-16T00:00:00.000Z"),
    asstThinking("a1", "msg_A"),
    asstTool("a2", "msg_A", "tool_use"),
    toolResult("u2"),
    asstText("a4", "msg_B", "Here is your email.", "end_turn"),
  ];

  it("normalizes a full turn: roles, joined assistant blocks, terminal stop_reason", () => {
    const inc = new IncrementalTranscript();
    const msgs = inc.push(jsonl(turn));
    // The two msg_A records re-emit the same joined message, so by-id the panel
    // sees roles user / assistant / tool / assistant.
    const byId = new Map(msgs.map((m) => [m.id, m]));
    expect([...byId.values()].map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const joined = msgs.find((m) => m.id === "a1")!;
    expect(joined.blocks.map((b) => b.kind)).toEqual(["thinking", "tool_use"]);
    expect(inc.stopReason).toBe("end_turn");
  });

  it("buffers partial lines split mid-record", () => {
    const whole = jsonl(turn);
    const cut = 40; // mid-first-line
    const a = new IncrementalTranscript();
    const split = [...a.push(whole.slice(0, cut)), ...a.push(whole.slice(cut))];
    const b = new IncrementalTranscript();
    const once = b.push(whole);
    expect(JSON.stringify(split)).toEqual(JSON.stringify(once));
  });

  it("resets the terminal marker when a new user turn opens", () => {
    const inc = new IncrementalTranscript();
    inc.push(jsonl([asstText("a1", "msg_A", "done", "end_turn")]));
    expect(inc.stopReason).toBe("end_turn");
    inc.push(jsonl([userText("u2", "next turn")]));
    expect(inc.stopReason).toBeUndefined();
  });

  it("does not reset on a tool_result (role tool, mid-turn)", () => {
    const inc = new IncrementalTranscript();
    inc.push(jsonl([asstTool("a1", "msg_A", "tool_use")]));
    inc.push(jsonl([toolResult("u2")]));
    expect(inc.stopReason).toBe("tool_use");
  });
});

describe("TranscriptTailer", () => {
  let root: string;
  let dir: string;
  const id = "11111111-2222-3333-4444-555555555555";

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "browserops-tail-"));
    dir = join(root, "proj");
    await fs.mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const path = () => join(dir, `${id}.jsonl`);
  function run(opts: { pollMs: number; quiescenceMs: number }) {
    const events: ChatEvent[] = [];
    const tailer = new TranscriptTailer(id, "/some/cwd", (e) => events.push(e), {
      projectsRoot: root,
      ...opts,
    });
    return { events, tailer };
  }
  const statuses = (events: ChatEvent[]) =>
    events
      .filter((e): e is Extract<ChatEvent, { type: "status" }> => e.type === "status")
      .map((e) => e.state);
  const texts = (events: ChatEvent[]) =>
    events
      .filter((e): e is Extract<ChatEvent, { type: "message" }> => e.type === "message")
      .flatMap((e) => e.message.blocks)
      .flatMap((b) => (b.kind === "text" ? [b.text] : []));

  it("streams an in-flight turn as thinking, then idles on end_turn", async () => {
    await fs.writeFile(
      path(),
      jsonl([userText("u1", "do it"), asstTool("a1", "msg_A", "tool_use")]),
    );
    const { events, tailer } = run({ pollMs: 20, quiescenceMs: 1000 });
    tailer.start();
    try {
      await sleep(120);
      expect(statuses(events)).toContain("thinking");
      await fs.appendFile(
        path(),
        jsonl([toolResult("u2"), asstText("a3", "msg_B", "done", "end_turn")]),
      );
      await sleep(120);
      expect(statuses(events).at(-1)).toBe("idle");
      expect(texts(events)).toContain("done");
    } finally {
      tailer.stop();
    }
  });

  it("idles on quiescence even when the turn never reaches a terminal stop", async () => {
    await fs.writeFile(
      path(),
      jsonl([userText("u1", "do it"), asstTool("a1", "msg_A", "tool_use")]),
    );
    const { events, tailer } = run({ pollMs: 20, quiescenceMs: 60 });
    tailer.start();
    try {
      await sleep(220);
      expect(statuses(events).at(-1)).toBe("idle");
    } finally {
      tailer.stop();
    }
  });

  it("tolerates the transcript being created after the tailer starts", async () => {
    const { events, tailer } = run({ pollMs: 20, quiescenceMs: 1000 });
    tailer.start();
    try {
      await sleep(80);
      await fs.writeFile(
        path(),
        jsonl([userText("u1", "hi"), asstText("a1", "msg_A", "hello", "end_turn")]),
      );
      await sleep(150);
      expect(texts(events)).toEqual(expect.arrayContaining(["hi", "hello"]));
    } finally {
      tailer.stop();
    }
  });
});
