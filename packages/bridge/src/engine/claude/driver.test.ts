import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent } from "@browserops/shared";
import { ClaudeDriver } from "./driver.js";
import type { ChildLike, SpawnLike } from "./runtime.js";

// A fake `claude`: records argv, then emits canned stream-json (init, assistant
// echo, result) split across two stdout chunks to exercise line buffering.
function fakeClaude() {
  const calls: string[][] = [];
  const spawn: SpawnLike = (_cmd, args) => {
    const argv = [...args];
    calls.push(argv);

    const dataCbs: ((c: string) => void)[] = [];
    const closeCbs: ((code: number | null) => void)[] = [];
    const stream = {
      setEncoding() {},
      on(_e: "data", cb: (c: string) => void) {
        dataCbs.push(cb);
      },
    };
    const child: ChildLike = {
      stdout: stream,
      stderr: { setEncoding() {}, on() {} },
      on(ev: "error" | "close", cb: (arg: never) => void) {
        if (ev === "close") closeCbs.push(cb as (code: number | null) => void);
      },
    };

    queueMicrotask(() => {
      const sid = valueAfter(argv, "--session-id") ?? valueAfter(argv, "--resume") ?? "";
      const dash = argv.indexOf("--");
      const prompt = dash >= 0 ? argv.slice(dash + 1).join(" ") : "";
      const lines = [
        JSON.stringify({ type: "system", subtype: "init", session_id: sid, cwd: "/w" }),
        JSON.stringify({
          type: "assistant",
          uuid: `u-${calls.length}`,
          message: {
            role: "assistant",
            id: `m-${calls.length}`,
            content: [{ type: "text", text: `ack:${prompt}` }],
          },
        }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ack" }),
      ];
      const text = lines.map((l) => l + "\n").join("");
      const mid = Math.floor(text.length / 2);
      for (const cb of dataCbs) cb(text.slice(0, mid));
      for (const cb of dataCbs) cb(text.slice(mid));
      for (const cb of closeCbs) cb(0);
    });

    return child;
  };
  return { spawn, calls };
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Poll a file (written best-effort/async by the mirror) until it contains needle. */
async function readWhen(path: string, needle: string, ms = 1000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    try {
      const c = await fs.readFile(path, "utf8");
      if (c.includes(needle)) return c;
    } catch {
      /* not written yet */
    }
    if (Date.now() - t0 > ms) throw new Error(`mirror never contained: ${needle}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const UUID = "11111111-1111-1111-1111-111111111111";

function makeDriver(over: Partial<ConstructorParameters<typeof ClaudeDriver>[0]> = {}) {
  const fake = fakeClaude();
  const driver = new ClaudeDriver({
    bin: "/fake/claude",
    spawn: fake.spawn,
    env: { PATH: "/usr/bin" },
    randomUUID: () => UUID,
    now: () => 1000,
    buildSystemPrompt: () => "SYS",
    buildPrompt: (page, instruction) =>
      `PAGE ${page.url}${instruction ? ` :: ${instruction}` : ""}`,
    ...over,
  });
  return { driver, calls: fake.calls };
}

describe("ClaudeDriver", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-driver-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("starts a session, streams the seeded turn, and mints the id with --session-id", async () => {
    const { driver, calls } = makeDriver({ chatDir: join(dir, "chat") });
    const events: ChatEvent[] = [];

    const ref = await driver.start({ page: { url: "https://x.test" }, instruction: "hello" });
    driver.subscribe(ref, (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === "status" && e.state === "idle"));

    expect(ref).toMatchObject({
      agent: "claude",
      sessionId: UUID,
      title: "hello",
      createdAt: 1000,
    });

    // First turn mints the session id; the visible seed = page facts + instruction.
    expect(calls[0]).toContain("--session-id");
    expect(calls[0]).toContain(UUID);
    expect(calls[0]).not.toContain("--resume");
    expect(calls[0]!.slice(calls[0]!.indexOf("--") + 1).join(" ")).toBe(
      "PAGE https://x.test :: hello",
    );
    expect(calls[0]).toContain("--dangerously-skip-permissions");

    const kinds = events.map((e) => (e.type === "status" ? `status:${e.state}` : e.type));
    expect(kinds).toContain("status:thinking");
    expect(kinds).toContain("message");
    expect(kinds).toContain("status:idle");

    const assistant = events.find((e) => e.type === "message" && e.message.role === "assistant");
    expect(assistant?.type === "message" && assistant.message.blocks[0]).toEqual({
      kind: "text",
      text: "ack:PAGE https://x.test :: hello",
    });
  });

  it("writes the mirror log: header, the user turn, and the assistant reply", async () => {
    const { driver } = makeDriver({ chatDir: join(dir, "chat") });
    const ref = await driver.start({ page: { url: "https://x.test" }, instruction: "hello" });
    const events: ChatEvent[] = [];
    driver.subscribe(ref, (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === "status" && e.state === "idle"));
    const mirror = await readWhen(
      join(dir, "chat", `${UUID}.mirror.log`),
      "ack:PAGE https://x.test :: hello",
    );
    expect(mirror).toContain("read-only mirror");
    expect(mirror).toContain("you:");
  });

  it("resumes with --resume on later turns and never re-mints the id", async () => {
    const { driver, calls } = makeDriver({ chatDir: join(dir, "chat") });
    const ref = await driver.start({ page: { url: "https://x.test" } });
    await driver.send(ref, "follow up");

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--resume");
    expect(calls[1]).toContain(UUID);
    expect(calls[1]).not.toContain("--session-id");
    expect(calls[1]!.slice(calls[1]!.indexOf("--") + 1).join(" ")).toBe("follow up");
  });

  it("passes user text as a single argv element (no shell → injection-inert)", async () => {
    const { driver, calls } = makeDriver({ chatDir: join(dir, "chat") });
    const ref = await driver.start({ page: { url: "https://x.test" } });
    const evil = "$(touch /tmp/PWNED) `id`; rm -rf ~";
    await driver.send(ref, evil);
    const last = calls[1]!;
    expect(last[last.length - 1]).toBe(evil); // exactly one element, after "--"
    expect(last.indexOf("--")).toBe(last.length - 2);
  });

  it("replays buffered events to a late subscriber", async () => {
    const { driver } = makeDriver({ chatDir: join(dir, "chat") });
    const first: ChatEvent[] = [];
    const ref = await driver.start({ page: { url: "https://x.test" } });
    driver.subscribe(ref, (e) => first.push(e));
    await waitFor(() => first.some((e) => e.type === "status" && e.state === "idle"));

    const late: ChatEvent[] = [];
    driver.subscribe(ref, (e) => late.push(e)); // attaches after the turn finished
    expect(late.some((e) => e.type === "message")).toBe(true);
    expect(late.some((e) => e.type === "status" && e.state === "idle")).toBe(true);
  });

  it("stop() ejects: emits an ejected status and refuses further sends", async () => {
    const { driver } = makeDriver({ chatDir: join(dir, "chat") });
    const events: ChatEvent[] = [];
    const ref = await driver.start({ page: { url: "https://x.test" } });
    driver.subscribe(ref, (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === "status" && e.state === "idle"));

    await driver.stop(ref);
    expect(events.some((e) => e.type === "status" && e.state === "ejected")).toBe(true);
    await expect(driver.send(ref, "still there?")).rejects.toThrow(/eject/);
  });

  it("reports claude_not_found instead of throwing when the binary is missing", async () => {
    const { driver } = makeDriver({ chatDir: join(dir, "chat"), bin: null });
    const events: ChatEvent[] = [];
    const ref = await driver.start({ page: { url: "https://x.test" } });
    driver.subscribe(ref, (e) => events.push(e));
    await waitFor(() =>
      events.some(
        (e) => e.type === "status" && e.state === "error" && e.detail === "claude_not_found",
      ),
    );
  });

  it("history() re-reads the session transcript by id", async () => {
    const projectsRoot = join(dir, "projects");
    await fs.mkdir(join(projectsRoot, "-some-slug"), { recursive: true });
    const jsonl =
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi there" } }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        message: { role: "assistant", id: "m", content: [{ type: "text", text: "hello back" }] },
      }) +
      "\n";
    await fs.writeFile(join(projectsRoot, "-some-slug", `${UUID}.jsonl`), jsonl, "utf8");

    const { driver } = makeDriver({ chatDir: join(dir, "chat"), projectsRoot });
    const ref = await driver.start({ page: { url: "https://x.test" } });
    const msgs = await driver.history(ref);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.blocks).toEqual([{ kind: "text", text: "hello back" }]);
  });
});
