import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTranscriptPath, loadHistory, parseTranscript, slugForCwd } from "./transcript.js";

// A realistic, noisy transcript: non-conversation records, a per-block assistant
// turn split across two records (same message.id), a sub-agent sidechain, and a
// synthetic injection — all of which the reader must handle.
const RECORDS: unknown[] = [
  { type: "mode", mode: "normal", sessionId: "s" },
  { type: "file-history-snapshot", messageId: "x" },
  {
    type: "user",
    uuid: "u1",
    timestamp: "2026-06-16T00:00:00.000Z",
    message: { role: "user", content: "Current page…\nread my last email" },
  },
  {
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      id: "msg_A",
      content: [{ type: "thinking", thinking: "reasoning", signature: "sig" }],
    },
  },
  {
    type: "assistant",
    uuid: "a2",
    message: {
      role: "assistant",
      id: "msg_A",
      content: [{ type: "tool_use", id: "t1", name: "browser_read", input: {} }],
    },
  },
  {
    type: "user",
    uuid: "u2",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  },
  { type: "attachment", attachment: { type: "deferred_tools_delta" } },
  { type: "ai-title", aiTitle: "Read last email" },
  {
    type: "assistant",
    uuid: "a3",
    isSidechain: true,
    message: {
      role: "assistant",
      id: "msg_S",
      content: [{ type: "text", text: "subagent chatter" }],
    },
  },
  {
    type: "user",
    uuid: "u3",
    message: {
      role: "user",
      content: [{ type: "text", text: "<system-reminder>noise</system-reminder>" }],
    },
  },
  {
    type: "assistant",
    uuid: "a4",
    message: {
      role: "assistant",
      id: "msg_B",
      content: [{ type: "text", text: "Here is your last email." }],
    },
  },
];
const JSONL = RECORDS.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("parseTranscript", () => {
  const msgs = parseTranscript(JSONL);

  it("keeps only the four real conversation turns, in order", () => {
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("re-joins the per-block assistant records sharing a message.id", () => {
    expect(msgs[1]!.blocks.map((b) => b.kind)).toEqual(["thinking", "tool_use"]);
  });

  it("renders the real first user turn and a later assistant turn", () => {
    expect(msgs[0]!.blocks).toEqual([{ kind: "text", text: "Current page…\nread my last email" }]);
    expect(msgs[0]!.ts).toBe(Date.parse("2026-06-16T00:00:00.000Z"));
    expect(msgs[3]!.blocks).toEqual([{ kind: "text", text: "Here is your last email." }]);
  });

  it("drops sidechains, injections, and non-conversation noise", () => {
    const flat = JSON.stringify(msgs);
    expect(flat).not.toContain("subagent chatter");
    expect(flat).not.toContain("system-reminder");
  });

  it("tolerates blank and malformed lines", () => {
    expect(parseTranscript("\n\nnot json\n" + JSON.stringify(RECORDS[2]) + "\n")).toHaveLength(1);
  });
});

describe("slugForCwd", () => {
  it("turns non-alphanumerics into dashes (matching Claude's project dirs)", () => {
    expect(slugForCwd("/Users/saket/Documents/GitHub/browserops")).toBe(
      "-Users-saket-Documents-GitHub-browserops",
    );
    expect(slugForCwd("/Users/saket")).toBe("-Users-saket");
  });
});

describe("findTranscriptPath / loadHistory", () => {
  let root: string;
  const sessionId = "29ff382a-4954-47a6-b484-6d5320aa0a7d";

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "browserops-projects-"));
    const slugDir = join(root, "-some-weird.cwd-slug");
    await fs.mkdir(slugDir, { recursive: true });
    await fs.writeFile(join(slugDir, `${sessionId}.jsonl`), JSONL, "utf8");
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("finds the transcript by scanning project dirs (slug-agnostic)", async () => {
    const path = await findTranscriptPath(sessionId, { projectsRoot: root });
    expect(path).not.toBeNull();
    expect(path!.endsWith(`${sessionId}.jsonl`)).toBe(true);
  });

  it("returns null for an unknown session id", async () => {
    expect(await findTranscriptPath("does-not-exist", { projectsRoot: root })).toBeNull();
  });

  it("loadHistory resolves + normalizes end-to-end", async () => {
    const msgs = await loadHistory(sessionId, { projectsRoot: root });
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });
});
