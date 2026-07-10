import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendBrowserTranscriptMessage,
  formatMessagesForProvider,
  formatMessagesForPrompt,
  readBrowserTranscript,
} from "./transcript.js";

describe("BrowserOps transcript", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-transcript-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("appends and re-reads normalized messages, deduping by id", async () => {
    await appendBrowserTranscriptMessage(
      "s1",
      { id: "m1", role: "assistant", blocks: [{ kind: "text", text: "one" }] },
      dir,
    );
    await appendBrowserTranscriptMessage(
      "s1",
      { id: "m1", role: "assistant", blocks: [{ kind: "text", text: "one updated" }] },
      dir,
    );
    await appendBrowserTranscriptMessage(
      "s1",
      { id: "m2", role: "user", blocks: [{ kind: "text", text: "two" }] },
      dir,
    );
    expect(await readBrowserTranscript("s1", dir)).toEqual([
      { id: "m1", role: "assistant", blocks: [{ kind: "text", text: "one updated" }] },
      { id: "m2", role: "user", blocks: [{ kind: "text", text: "two" }] },
    ]);
  });

  it("formats recent messages for migration prompts", () => {
    expect(
      formatMessagesForPrompt([
        { id: "u", role: "user", blocks: [{ kind: "text", text: "hello" }] },
        {
          id: "a",
          role: "assistant",
          blocks: [{ kind: "tool_use", id: "t", name: "read", input: {} }],
        },
      ]),
    ).toContain("assistant: [tool_use:read]");
  });

  it("keeps the newest context when a migration prompt is capped", () => {
    const first = "a".repeat(18_000);
    const newest = "newest user request";
    const out = formatMessagesForPrompt(
      [
        { id: "old", role: "assistant", blocks: [{ kind: "text", text: first }] },
        { id: "new", role: "user", blocks: [{ kind: "text", text: newest }] },
      ],
      100,
    );
    expect(out).toContain(newest);
    expect(out).toContain("earlier transcript omitted");
  });

  it("does not project hidden reasoning into a different provider", () => {
    const out = formatMessagesForProvider([
      {
        id: "a",
        role: "assistant",
        blocks: [
          { kind: "thinking", text: "private chain of thought" },
          { kind: "text", text: "visible answer" },
        ],
      },
    ]);
    expect(out).toContain("visible answer");
    expect(out).not.toContain("private chain of thought");
  });
});
