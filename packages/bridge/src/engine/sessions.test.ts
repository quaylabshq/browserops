import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionIndex, type SessionMeta } from "./sessions.js";

function meta(id: string, lastActive: number, over: Partial<SessionMeta> = {}): SessionMeta {
  return { agent: "claude", sessionId: id, cwd: "/w", createdAt: 1, lastActive, ...over };
}

describe("SessionIndex", () => {
  let dir: string;
  let idx: SessionIndex;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-sessions-"));
    idx = new SessionIndex(dir);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns [] when the file does not exist", async () => {
    expect(await idx.load()).toEqual([]);
  });

  it("upserts and lists newest-active first", async () => {
    await idx.upsert(meta("a", 10));
    await idx.upsert(meta("b", 30));
    await idx.upsert(meta("c", 20));
    expect((await idx.load()).map((m) => m.sessionId)).toEqual(["b", "c", "a"]);
  });

  it("upsert replaces by id rather than duplicating", async () => {
    await idx.upsert(meta("a", 10, { title: "old" }));
    await idx.upsert(meta("a", 40, { title: "new" }));
    const all = await idx.load();
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe("new");
  });

  it("get + remove", async () => {
    await idx.upsert(meta("a", 10));
    expect((await idx.get("a"))?.sessionId).toBe("a");
    await idx.remove("a");
    expect(await idx.get("a")).toBeUndefined();
  });

  it("touch bumps lastActive and reorders; missing id is a no-op", async () => {
    await idx.upsert(meta("a", 10));
    await idx.upsert(meta("b", 20));
    await idx.touch("a", 99);
    expect((await idx.load()).map((m) => m.sessionId)).toEqual(["a", "b"]);
    await idx.touch("missing", 5);
  });

  it("tolerates a corrupt index file", async () => {
    await fs.writeFile(join(dir, "index.json"), "{ not json", "utf8");
    expect(await idx.load()).toEqual([]);
  });

  it("drops malformed entries on load", async () => {
    await fs.writeFile(
      join(dir, "index.json"),
      JSON.stringify([meta("ok", 1), { bad: true }, null]),
      "utf8",
    );
    expect((await idx.load()).map((m) => m.sessionId)).toEqual(["ok"]);
  });
});
