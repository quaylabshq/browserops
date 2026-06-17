import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent, ChatPageContext, SessionRef } from "@browserops/shared";
import { engineErrorCode } from "../errors.js";
import { ClaudePtyDriver, type ClaudePtyDriverDeps } from "./terminal-driver.js";
import type { PtyProcess, PtySpawner, SpawnPtyOptions } from "./pty.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const page: ChatPageContext = { url: "https://x.test", title: "T" };

const jsonl = (recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const userText = (uuid: string, text: string) => ({
  type: "user",
  uuid,
  message: { role: "user", content: text },
});
const asstText = (uuid: string, id: string, text: string, stop_reason: string) => ({
  type: "assistant",
  uuid,
  message: { role: "assistant", id, stop_reason, content: [{ type: "text", text }] },
});

class FakePty implements PtyProcess {
  pid = 1;
  writes: string[] = [];
  killed = false;
  resized: { cols: number; rows: number } | undefined;
  private dataCbs = new Set<(d: string) => void>();
  private exitCbs = new Set<(e: { exitCode: number; signal?: number }) => void>();
  write(d: string): void {
    this.writes.push(d);
  }
  resize(cols: number, rows: number): void {
    this.resized = { cols, rows };
  }
  onData(cb: (d: string) => void): { dispose(): void } {
    this.dataCbs.add(cb);
    return { dispose: () => this.dataCbs.delete(cb) };
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitCbs.add(cb);
    return { dispose: () => this.exitCbs.delete(cb) };
  }
  kill(): void {
    this.killed = true;
  }
  emitData(d: string): void {
    for (const c of [...this.dataCbs]) c(d);
  }
  emitExit(e: { exitCode: number; signal?: number }): void {
    for (const c of [...this.exitCbs]) c(e);
  }
}

describe("ClaudePtyDriver", () => {
  let tmp: string;
  let cwd: string;
  let projectsRoot: string;
  let claudeConfigPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "browserops-ptydriver-"));
    cwd = join(tmp, "ws");
    projectsRoot = join(tmp, "projects");
    claudeConfigPath = join(tmp, ".claude.json");
    await fs.mkdir(join(projectsRoot, "proj"), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function make(overrides: Partial<ClaudePtyDriverDeps> = {}) {
    const fake = new FakePty();
    let spawnOpts: SpawnPtyOptions | undefined;
    const spawner: PtySpawner = (o) => {
      spawnOpts = o;
      return fake;
    };
    const driver = new ClaudePtyDriver({
      bin: "/bin/claude",
      env: {},
      spawner,
      randomUUID: () => ID,
      now: () => 1,
      buildSystemPrompt: () => "SYS",
      buildPrompt: (p, i) => `SEED:${i ?? ""}:${p.url}`,
      projectsRoot,
      claudeConfigPath,
      tailer: { pollMs: 20, quiescenceMs: 1000 },
      ready: { quietMs: 10, timeoutMs: 500 },
      submit: { settleMs: 0, sleep: () => Promise.resolve() },
      ...overrides,
    });
    return { driver, fake, spawnOpts: () => spawnOpts };
  }

  const writeTranscript = (content: string) =>
    fs.writeFile(join(projectsRoot, "proj", `${ID}.jsonl`), content, "utf8");

  it("spawns an INTERACTIVE claude (no --print / skip-permissions) and seeds the turn", async () => {
    const { driver, fake, spawnOpts } = make();
    const ref = await driver.start({ page, instruction: "do it", cwd });
    expect(ref.sessionId).toBe(ID);
    expect(spawnOpts()!.file).toBe("/bin/claude");
    expect(spawnOpts()!.args).toEqual([
      "--session-id",
      ID,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "mcp__browserops",
      "--append-system-prompt",
      "SYS",
    ]);
    expect(spawnOpts()!.args).not.toContain("--print");
    expect(spawnOpts()!.args).not.toContain("--dangerously-skip-permissions");
    fake.emitData("rendered"); // TUI emits output → readiness quiesces, seed submits
    await sleep(60);
    expect(fake.writes).toEqual(["SEED:do it:https://x.test", "\r"]);
  });

  it("safe mode → --permission-mode default and no pre-allowed tools", async () => {
    const { driver, spawnOpts } = make();
    await driver.start({ page, safeMode: true, cwd });
    expect(spawnOpts()!.args).toEqual([
      "--session-id",
      ID,
      "--permission-mode",
      "default",
      "--append-system-prompt",
      "SYS",
    ]);
  });

  it("replays buffered events and streams transcript messages to subscribers", async () => {
    const { driver } = make();
    const ref = await driver.start({ page, instruction: "hi", cwd });
    const events: ChatEvent[] = [];
    driver.subscribe(ref, (e) => events.push(e));
    expect(events.some((e) => e.type === "status" && e.state === "thinking")).toBe(true);

    await writeTranscript(
      jsonl([userText("u1", "hi"), asstText("a1", "m", "hello there", "end_turn")]),
    );
    await sleep(80);
    const texts = events
      .filter((e): e is Extract<ChatEvent, { type: "message" }> => e.type === "message")
      .flatMap((e) => e.message.blocks)
      .flatMap((b) => (b.kind === "text" ? [b.text] : []));
    expect(texts).toContain("hello there");
    expect(events.some((e) => e.type === "status" && e.state === "idle")).toBe(true);
  });

  it("send injects a follow-up turn into the live session", async () => {
    const { driver, fake } = make();
    const ref = await driver.start({ page, cwd });
    fake.emitData("rendered"); // TUI emits output → readiness quiesces, seed submits
    await sleep(60);
    const before = fake.writes.length;
    await driver.send(ref, "follow up");
    expect(fake.writes.slice(before)).toEqual(["follow up", "\r"]);
  });

  it("rejects send / attachTerminal for an unknown session", async () => {
    const { driver } = make();
    const ghost: SessionRef = { agent: "claude", sessionId: "nope", cwd, createdAt: 1 };
    await expect(driver.send(ghost, "x").catch((e) => engineErrorCode(e))).resolves.toBe(
      "unknown_session",
    );
    expect(() => driver.attachTerminal(ghost)).toThrow();
  });

  it("attachTerminal bridges the pane to the live pty (data out, keys/resize in)", async () => {
    const { driver, fake } = make();
    const ref = await driver.start({ page, cwd });
    const handle = driver.attachTerminal(ref);
    const got: string[] = [];
    const unsub = handle.onData((d) => got.push(d));
    fake.emitData("\x1b[2J screen");
    expect(got).toContain("\x1b[2J screen");
    handle.write("typed-in-pane");
    handle.resize(80, 24);
    expect(fake.writes).toContain("typed-in-pane");
    expect(fake.resized).toEqual({ cols: 80, rows: 24 });
    unsub();
  });

  it("stop kills the pty, ends the stream, and refuses further sends", async () => {
    const { driver, fake } = make();
    const ref = await driver.start({ page, cwd });
    const events: ChatEvent[] = [];
    driver.subscribe(ref, (e) => events.push(e));
    await driver.stop(ref);
    expect(fake.killed).toBe(true);
    expect(events.some((e) => e.type === "end")).toBe(true);
    await expect(driver.send(ref, "x").catch((e) => engineErrorCode(e))).resolves.toBe(
      "unknown_session",
    );
  });

  it("pre-seeds workspace folder-trust in ~/.claude.json", async () => {
    const { driver } = make();
    await driver.start({ page, cwd });
    const cfg = JSON.parse(await fs.readFile(claudeConfigPath, "utf8")) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    expect(cfg.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
  });

  it("maps a node-pty load failure to pty_unavailable (engine then falls back)", async () => {
    const driver = new ClaudePtyDriver({
      bin: "/bin/claude",
      env: {},
      // no spawner → goes through loadPtySpawner, which we force to fail
      loaderDeps: {
        resolveDir: () => "/x",
        fsOps: { stat: async () => ({ mode: 0o755 }), chmod: async () => {} },
        importModule: async () => {
          throw new Error("Cannot find module 'node-pty'");
        },
      },
      randomUUID: () => ID,
      projectsRoot,
      claudeConfigPath,
    });
    await expect(driver.start({ page, cwd }).catch((e) => engineErrorCode(e))).resolves.toBe(
      "pty_unavailable",
    );
  });

  it("throws claude_not_found when the binary can't be resolved", async () => {
    const { driver } = make({ bin: null });
    await expect(driver.start({ page, cwd }).catch((e) => engineErrorCode(e))).resolves.toBe(
      "claude_not_found",
    );
  });
});
