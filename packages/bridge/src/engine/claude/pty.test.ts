import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PtySession,
  PtyUnavailableError,
  loadPtySpawner,
  resetPtyCache,
  submitText,
  type PtyProcess,
  type SpawnPtyOptions,
} from "./pty.js";

afterEach(() => resetPtyCache());

const ESC = "\x1b";

describe("submitText", () => {
  const immediate = () => Promise.resolve();

  it("writes single-line text then a discrete Enter (never one combined write)", async () => {
    const writes: string[] = [];
    await submitText((d) => writes.push(d), "what page am I on?", { sleep: immediate });
    expect(writes).toEqual(["what page am I on?", "\r"]);
  });

  it("bracketed-pastes multi-line text so embedded newlines don't submit early", async () => {
    const writes: string[] = [];
    await submitText((d) => writes.push(d), "line1\nline2", { sleep: immediate });
    expect(writes).toEqual([`${ESC}[200~line1\nline2${ESC}[201~`, "\r"]);
  });

  it("presses Enter only after the settle delay resolves", async () => {
    const writes: string[] = [];
    let release: () => void = () => {};
    const gated = () => new Promise<void>((r) => (release = r));
    const done = submitText((d) => writes.push(d), "hi", { sleep: gated });
    await Promise.resolve();
    expect(writes).toEqual(["hi"]); // Enter withheld until settle resolves
    release();
    await done;
    expect(writes).toEqual(["hi", "\r"]);
  });
});

describe("loadPtySpawner", () => {
  it("throws PtyUnavailableError when the native module can't be imported", async () => {
    await expect(
      loadPtySpawner({
        resolveDir: () => "/nope",
        fsOps: { stat: async () => ({ mode: 0o755 }), chmod: async () => {} },
        importModule: async () => {
          throw new Error("Cannot find module 'node-pty'");
        },
      }),
    ).rejects.toBeInstanceOf(PtyUnavailableError);
  });

  it("repairs the spawn-helper exec bit before spawning, then spawns", async () => {
    const chmods: { path: string; mode: number }[] = [];
    const spawned: SpawnPtyOptions[] = [];
    const fakeSpawn = (file: string, args: string[], opts: Record<string, unknown>): PtyProcess => {
      spawned.push({ file, args, cwd: String(opts["cwd"]), env: opts["env"] as NodeJS.ProcessEnv });
      return {} as PtyProcess;
    };
    const spawner = await loadPtySpawner({
      resolveDir: () => "/mod",
      fsOps: {
        stat: async () => ({ mode: 0o644 }), // no exec bit
        chmod: async (path, mode) => void chmods.push({ path, mode }),
      },
      importModule: async () => ({ spawn: fakeSpawn }),
    });
    spawner({ file: "/bin/claude", args: ["--session-id", "x"], cwd: "/w", env: { PATH: "/p" } });

    // both candidate helper paths get +x (0o644 | 0o755 = 0o755)
    expect(chmods.every((c) => (c.mode & 0o111) !== 0)).toBe(true);
    expect(chmods.some((c) => c.path.includes("spawn-helper"))).toBe(true);
    expect(spawned[0]).toMatchObject({
      file: "/bin/claude",
      args: ["--session-id", "x"],
      cwd: "/w",
    });
  });
});

class FakePty implements PtyProcess {
  pid = 4242;
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

async function startWithFake(): Promise<{ session: PtySession; fake: FakePty }> {
  const fake = new FakePty();
  const session = await PtySession.start({
    file: "/bin/claude",
    args: [],
    cwd: "/w",
    env: {},
    spawner: () => fake,
  });
  return { session, fake };
}

describe("PtySession", () => {
  it("forwards write / submit / resize to the pty", async () => {
    const { session, fake } = await startWithFake();
    session.write("raw");
    await session.submit("hello", { sleep: () => Promise.resolve() });
    session.resize(100, 40);
    expect(fake.writes).toEqual(["raw", "hello", "\r"]);
    expect(fake.resized).toEqual({ cols: 100, rows: 40 });
    expect(session.pid).toBe(4242);
  });

  it("fans raw output out to every listener", async () => {
    const { session, fake } = await startWithFake();
    const a: string[] = [];
    const b: string[] = [];
    session.onData((d) => a.push(d));
    session.onData((d) => b.push(d));
    fake.emitData("xyz");
    expect(a).toEqual(["xyz"]);
    expect(b).toEqual(["xyz"]);
  });

  it("replays scrollback to a late attacher", async () => {
    const { session, fake } = await startWithFake();
    fake.emitData("before-");
    fake.emitData("attach");
    const got: string[] = [];
    session.onData((d) => got.push(d));
    expect(got).toEqual(["before-attach"]); // replayed as one chunk
    fake.emitData("-after");
    expect(got).toEqual(["before-attach", "-after"]);
  });

  it("tracks exit and stops fanning after kill", async () => {
    const { session, fake } = await startWithFake();
    const exits: number[] = [];
    session.onExit((e) => exits.push(e.exitCode));
    fake.emitExit({ exitCode: 0 });
    expect(exits).toEqual([0]);
    expect(session.hasExited).toBe(true);

    const seen: string[] = [];
    session.onData((d) => seen.push(d));
    session.kill();
    expect(fake.killed).toBe(true);
    fake.emitData("late");
    expect(seen).toEqual([]); // listeners cleared on kill
  });

  it("waitUntilReady resolves after output quiesces", async () => {
    vi.useFakeTimers();
    try {
      const { session, fake } = await startWithFake();
      const ready = session.waitUntilReady({ quietMs: 50, timeoutMs: 5000 });
      let done = false;
      void ready.then(() => (done = true));
      fake.emitData("rendering…");
      await vi.advanceTimersByTimeAsync(30);
      expect(done).toBe(false); // still within the quiet window
      await vi.advanceTimersByTimeAsync(60);
      await ready;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
