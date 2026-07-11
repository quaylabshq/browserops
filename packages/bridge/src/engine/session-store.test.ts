import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "./session-store.js";

describe("SessionStore", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function store(): Promise<SessionStore> {
    const dir = await fs.mkdtemp(join(tmpdir(), "browserops-session-store-"));
    dirs.push(dir);
    let event = 0;
    return new SessionStore(
      dir,
      () => 100,
      () => `event-${++event}`,
    );
  }

  it("is canonical: partial provider updates collapse into a final durable message", async () => {
    const sessions = await store();
    await sessions.append(
      "chat-1",
      {
        type: "message",
        message: {
          id: "a",
          role: "assistant",
          partial: true,
          blocks: [{ kind: "text", text: "hel" }],
        },
      },
      "codex",
    );
    await sessions.append(
      "chat-1",
      {
        type: "message",
        message: { id: "a", role: "assistant", blocks: [{ kind: "text", text: "hello" }] },
      },
      "codex",
    );

    expect(await sessions.history("chat-1")).toEqual([
      { id: "a", role: "assistant", blocks: [{ kind: "text", text: "hello" }] },
    ]);
    expect((await sessions.events("chat-1")).map((event) => event.sequence)).toEqual([1, 2]);
    expect((await sessions.events("chat-1", 1)).map((event) => event.sequence)).toEqual([2]);
  });

  it("recovers the durable prefix when an event journal ends in a torn line", async () => {
    const sessions = await store();
    await sessions.append(
      "chat-1",
      {
        type: "message",
        message: { id: "u", role: "user", blocks: [{ kind: "text", text: "hello" }] },
      },
      "panel",
    );
    const journal = join(dirs[0]!, "sessions", "chat-1", "events.jsonl");
    await fs.appendFile(journal, '{"version":2', "utf8");
    await fs.rm(join(dirs[0]!, "sessions", "chat-1", "snapshot.json"));

    expect(await sessions.history("chat-1")).toEqual([
      { id: "u", role: "user", blocks: [{ kind: "text", text: "hello" }] },
    ]);
  });

  it("orders a repeated provider id by its latest durable event, after newer user turns", async () => {
    const sessions = await store();
    await sessions.append(
      "chat-1",
      {
        type: "message",
        message: { id: "item_0", role: "assistant", blocks: [{ kind: "text", text: "first" }] },
      },
      "codex",
    );
    await sessions.append(
      "chat-1",
      {
        type: "message",
        message: { id: "user-2", role: "user", blocks: [{ kind: "text", text: "next" }] },
      },
      "panel",
    );
    await sessions.append(
      "chat-1",
      {
        type: "message",
        message: { id: "item_0", role: "assistant", blocks: [{ kind: "text", text: "second" }] },
      },
      "codex",
    );
    // A v2 snapshot used Map insertion order and loses the chronology. The
    // v3 reader must rebuild old sessions from the durable journal instead.
    await fs.writeFile(
      join(dirs[0]!, "sessions", "chat-1", "snapshot.json"),
      JSON.stringify({ version: 2, lastSequence: 3, messages: [] }),
      "utf8",
    );

    expect((await sessions.history("chat-1")).map((message) => message.id)).toEqual([
      "item_0",
      "user-2",
      "item_0-legacy-3",
    ]);
    expect((await sessions.history("chat-1"))[2]?.blocks).toEqual([
      { kind: "text", text: "second" },
    ]);
  });
});
