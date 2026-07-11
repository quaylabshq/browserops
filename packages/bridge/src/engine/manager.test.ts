import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId, ChatEvent, ChatMessage, SessionRef } from "@browserops/shared";
import type {
  AgentDriver,
  ChatEventListener,
  StartOpts,
  TerminalAttachable,
  TerminalHandle,
  Unsubscribe,
} from "./driver.js";
import { EngineError, engineErrorCode, type EngineErrorCode } from "./errors.js";
import { ChatEngine } from "./manager.js";
import { SessionStore } from "./session-store.js";
import { SessionIndex } from "./sessions.js";

class FakeDriver implements AgentDriver {
  readonly id: AgentId;
  started: StartOpts[] = [];
  sent: { id: string; text: string }[] = [];
  cancelled: string[] = [];
  stopped: string[] = [];
  historyResult: ChatMessage[] = [];
  private seq = 0;
  private readonly listeners = new Map<string, Set<ChatEventListener>>();

  constructor(id: AgentId = "claude") {
    this.id = id;
  }

  async start(opts: StartOpts): Promise<SessionRef> {
    this.started.push(opts);
    const sessionId = `s${++this.seq}`;
    this.listeners.set(sessionId, new Set());
    return {
      agent: this.id,
      sessionId,
      cwd: opts.cwd ?? "/w",
      createdAt: 7,
      ...(opts.instruction !== undefined ? { title: opts.instruction } : {}),
      ...(opts.migratedFrom !== undefined ? { migratedFrom: opts.migratedFrom } : {}),
      ...(opts.migrationSourceAgent !== undefined
        ? { migrationSourceAgent: opts.migrationSourceAgent }
        : {}),
    };
  }
  async send(ref: SessionRef, text: string): Promise<void> {
    this.sent.push({ id: ref.sessionId, text });
  }
  subscribe(ref: SessionRef, listener: ChatEventListener): Unsubscribe {
    let set = this.listeners.get(ref.sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(ref.sessionId, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }
  async history(): Promise<ChatMessage[]> {
    return this.historyResult;
  }
  async stop(ref: SessionRef): Promise<void> {
    this.stopped.push(ref.sessionId);
  }
  async cancel(ref: SessionRef): Promise<void> {
    this.cancelled.push(ref.sessionId);
  }
  emit(sessionId: string, event: ChatEvent): void {
    for (const l of this.listeners.get(sessionId) ?? []) l(event);
  }
}

class FailingDriver implements AgentDriver {
  readonly id = "claude" as const;
  constructor(private readonly code: EngineErrorCode) {}
  start(): Promise<SessionRef> {
    return Promise.reject(new EngineError(this.code));
  }
  send(): Promise<void> {
    return Promise.resolve();
  }
  subscribe(): Unsubscribe {
    return () => {};
  }
  history(): Promise<ChatMessage[]> {
    return Promise.resolve([]);
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
}

/** A driver with a distinct eject (the pty transport's relinquish). */
class RelinquishDriver extends FakeDriver {
  relinquished: string[] = [];
  async relinquish(ref: SessionRef): Promise<void> {
    this.relinquished.push(ref.sessionId);
  }
}

/** A terminal-attachable driver with a controllable live flag. */
class FakeTerminalDriver extends FakeDriver implements TerminalAttachable {
  live = true;
  attachTerminal(): TerminalHandle {
    return { onData: () => () => {}, write: () => {}, resize: () => {} };
  }
  terminalLive(): boolean {
    return this.live;
  }
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return engineErrorCode(e);
  }
}

describe("ChatEngine", () => {
  let dir: string;
  let index: SessionIndex;
  let store: SessionStore;
  let driver: FakeDriver;
  let engine: ChatEngine;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-engine-"));
    index = new SessionIndex(dir);
    store = new SessionStore(join(dir, "chat"));
    driver = new FakeDriver();
    let ids = 0;
    engine = new ChatEngine({
      drivers: { claude: driver },
      index,
      store,
      now: () => 1000,
      randomUUID: () => `browserops-${++ids}`,
    });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("start routes to the driver and records the session", async () => {
    const ref = await engine.start({
      agent: "claude",
      page: { url: "https://x" },
      instruction: "hi",
    });
    expect(ref.sessionId).toBe("browserops-1");
    expect(ref.bindingId).toBe("browserops-4");
    expect(driver.started).toHaveLength(1);
    const sessions = await engine.listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual([ref.sessionId]);
    expect(sessions[0]).toMatchObject({ lastActive: 1000, title: "hi" });
  });

  it("subscribe fans driver events to the listener", async () => {
    const ref = await engine.start({ agent: "claude", page: { url: "x" } });
    const got: ChatEvent[] = [];
    await engine.subscribe(ref.sessionId, (e) => got.push(e));
    expect(got[0]).toMatchObject({ type: "session", ref: { sessionId: ref.sessionId } });
    driver.emit("s1", { type: "status", state: "thinking" });
    for (let i = 0; got.length < 2 && i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(got.at(-1)).toMatchObject({ type: "status", state: "thinking", sequence: 2 });
  });

  it("send routes through and bumps lastActive", async () => {
    const ref = await engine.start({ agent: "claude", page: { url: "x" } });
    const engine2 = new ChatEngine({
      drivers: { claude: driver },
      index,
      store,
      now: () => 2000,
    });
    await engine2.send(ref.sessionId, "next");
    expect(driver.sent).toEqual([{ id: "s1", text: "next" }]);
    expect((await index.get(ref.sessionId))!.lastActive).toBe(2000);
  });

  it("history routes to the driver", async () => {
    driver.historyResult = [{ id: "m", role: "assistant", blocks: [{ kind: "text", text: "yo" }] }];
    const ref = await engine.start({ agent: "claude", page: { url: "x" } });
    expect(await engine.history(ref.sessionId)).toEqual(driver.historyResult);
  });

  it("stop tears down via the driver", async () => {
    const ref = await engine.start({ agent: "claude", page: { url: "x" } });
    await engine.stop(ref.sessionId);
    expect(driver.stopped).toEqual(["s1"]);
  });

  it("cancel interrupts the current response without stopping the session", async () => {
    const ref = await engine.start({ agent: "claude", page: { url: "x" } });
    await engine.cancel(ref.sessionId);
    expect(driver.cancelled).toEqual(["s1"]);
    expect(driver.stopped).toEqual([]);
  });

  it("eject prefers the driver's relinquish over stop", async () => {
    const d = new RelinquishDriver();
    const e = new ChatEngine({ drivers: { claude: d }, index, now: () => 1 });
    const ref = await e.start({ agent: "claude", page: { url: "x" } });
    await e.eject(ref.sessionId);
    expect(d.relinquished).toEqual(["s1"]);
    expect(d.stopped).toEqual([]); // hard stop NOT used when relinquish exists
  });

  it("eject falls back to stop for a driver without relinquish (headless)", async () => {
    const ref = await engine.start({ agent: "claude", page: { url: "x" } });
    await engine.eject(ref.sessionId);
    expect(driver.stopped).toEqual(["s1"]);
  });

  it("keeps the public BrowserOps id out of terminal takeover commands", async () => {
    const ref = await engine.start({ agent: "claude", page: { url: "x" } });
    const target = await engine.terminalTarget(ref.sessionId);
    expect(target.sessionId).toBe("browserops-3");
    expect(target.sessionId).not.toBe(ref.sessionId);
    expect(target.mirrorPath).toContain("s1.mirror.log");
  });

  it("terminalCapable: live terminal driver true; not-live / headless / cold false", async () => {
    const term = new FakeTerminalDriver();
    const e = new ChatEngine({ drivers: { claude: term }, index, now: () => 1 });
    const ref = await e.start({ agent: "claude", page: { url: "x" } });
    expect(e.terminalCapable(ref.sessionId)).toBe(true);
    term.live = false; // after eject the pty is gone
    expect(e.terminalCapable(ref.sessionId)).toBe(false);
    expect(e.terminalCapable("never-seen")).toBe(false); // cold / not cached

    // A headless (non-terminal-attachable) driver is never terminal-capable.
    const headless = new FakeDriver();
    const e2 = new ChatEngine({ drivers: { claude: headless }, index, now: () => 1 });
    const ref2 = await e2.start({ agent: "claude", page: { url: "x" } });
    expect(e2.terminalCapable(ref2.sessionId)).toBe(false);
  });

  it("reports session capabilities from the owning driver", async () => {
    const term = new FakeTerminalDriver();
    const e = new ChatEngine({ drivers: { claude: term }, index, now: () => 1 });
    const ref = await e.start({ agent: "claude", page: { url: "x" } });
    expect(await e.capabilities(ref.sessionId)).toMatchObject({
      embeddedTerminal: true,
      externalTakeover: true,
      migrationSource: true,
      migrationTarget: true,
    });
    term.live = false;
    expect(await e.capabilities(ref.sessionId)).toMatchObject({
      embeddedTerminal: false,
      externalTakeover: false,
    });
  });

  it("defers a new target provider until the user sends the next real turn", async () => {
    const source = new FakeDriver("claude");
    source.historyResult = [
      { id: "u", role: "user", blocks: [{ kind: "text", text: "summarize this" }] },
      { id: "a", role: "assistant", blocks: [{ kind: "text", text: "done" }] },
    ];
    const target = new FakeDriver("codex");
    const e = new ChatEngine({
      drivers: { claude: source, codex: target },
      index,
      store,
      now: () => 1,
    });
    const ref = await e.start({ agent: "claude", page: { url: "x" } });
    const migrated = await e.migrate(ref.sessionId, "codex");
    expect(migrated.agent).toBe("codex");
    expect(migrated.sessionId).toBe(ref.sessionId);
    expect(migrated.migrationSourceAgent).toBe("claude");
    expect(target.started).toHaveLength(0);
    await e.send(ref.sessionId, "continue with a shorter version");
    expect(target.started).toHaveLength(1);
    expect(target.started[0]?.instruction).toContain("Canonical transcript");
    expect(target.started[0]?.instruction).toContain("user: summarize this");
    expect(target.started[0]?.instruction).toContain("assistant: done");
    expect(target.started[0]?.instruction).toContain("continue with a shorter version");
    expect(target.sent).toEqual([]); // the real user turn is the target's seed, not a duplicate send
    const back = await e.migrate(ref.sessionId, "claude");
    expect(back.sessionId).toBe(ref.sessionId);
    expect(back.agent).toBe("claude");
    expect(source.started).toHaveLength(1); // native Claude binding was reused
  });

  it("projects missed canonical turns before resuming a paused provider binding", async () => {
    const source = new FakeDriver("claude");
    source.historyResult = [{ id: "u", role: "user", blocks: [{ kind: "text", text: "first" }] }];
    const target = new FakeDriver("codex");
    const e = new ChatEngine({
      drivers: { claude: source, codex: target },
      index,
      store,
      now: () => 1,
    });
    const ref = await e.start({ agent: "claude", page: { url: "x" } });
    await e.migrate(ref.sessionId, "codex");
    await e.send(ref.sessionId, "pick up the work here");
    target.emit("s1", {
      type: "message",
      message: {
        id: "codex-answer",
        role: "assistant",
        blocks: [{ kind: "text", text: "codex update" }],
      },
    });
    for (let i = 0; i < 20; i++) {
      if ((await e.history(ref.sessionId)).some((message) => message.id === "codex-answer")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await e.migrate(ref.sessionId, "claude");
    await e.send(ref.sessionId, "continue here");

    expect(source.sent.at(-1)?.text).toContain("codex update");
    expect(source.sent.at(-1)?.text).toContain("continue here");
    expect(
      (await e.history(ref.sessionId)).filter(
        (message) =>
          message.role === "user" &&
          message.blocks[0]?.kind === "text" &&
          message.blocks[0].text === "continue here",
      ),
    ).toHaveLength(1);
  });

  it("keeps a deferred provider dormant across a restart until a real user turn", async () => {
    const source = new FakeDriver("claude");
    source.historyResult = [
      { id: "a", role: "assistant", blocks: [{ kind: "text", text: "done" }] },
    ];
    const target = new FakeDriver("codex");
    const first = new ChatEngine({
      drivers: { claude: source, codex: target },
      index,
      store,
      now: () => 1,
    });
    const ref = await first.start({ agent: "claude", page: { url: "x" } });
    await first.migrate(ref.sessionId, "codex");
    expect(target.started).toHaveLength(0);

    const restoredSource = new FakeDriver("claude");
    const restoredTarget = new FakeDriver("codex");
    const restored = new ChatEngine({
      drivers: { claude: restoredSource, codex: restoredTarget },
      index,
      store,
      now: () => 2,
    });
    await restored.send(ref.sessionId, "continue");

    expect(restoredTarget.started).toHaveLength(1);
    expect(restoredTarget.sent).toEqual([]);
  });

  it("resolves a cold session from the index after a restart", async () => {
    const ref = await engine.start({ agent: "claude", page: { url: "x" } });
    const driver2 = new FakeDriver();
    const engine2 = new ChatEngine({
      drivers: { claude: driver2 },
      index,
      store,
      now: () => 3000,
    });
    await engine2.send(ref.sessionId, "cold");
    expect(driver2.sent).toEqual([{ id: "s1", text: "cold" }]);
  });

  it("surfaces engine error codes for unknown sessions and unavailable agents", async () => {
    expect(await codeOf(engine.send("nope", "x"))).toBe("unknown_session");
    expect(await codeOf(engine.start({ agent: "codex", page: { url: "x" } }))).toBe(
      "agent_unavailable",
    );
  });

  it("falls back to the fallback driver on pty_unavailable, routing later calls to it", async () => {
    const primary = new FailingDriver("pty_unavailable");
    const fallback = new FakeDriver();
    const e = new ChatEngine({
      drivers: { claude: primary },
      fallbacks: { claude: fallback },
      index,
      store,
      now: () => 1,
    });
    const ref = await e.start({ agent: "claude", page: { url: "x" }, instruction: "hi" });
    expect(fallback.started).toHaveLength(1);
    await e.send(ref.sessionId, "next");
    expect(fallback.sent).toEqual([{ id: "s1", text: "next" }]);
  });

  it("does not fall back for non-pty errors", async () => {
    const fallback = new FakeDriver();
    const e = new ChatEngine({
      drivers: { claude: new FailingDriver("claude_not_found") },
      fallbacks: { claude: fallback },
      index,
      now: () => 1,
    });
    expect(await codeOf(e.start({ agent: "claude", page: { url: "x" } }))).toBe("claude_not_found");
    expect(fallback.started).toHaveLength(0);
  });

  it("propagates pty_unavailable when no fallback is registered", async () => {
    const e = new ChatEngine({
      drivers: { claude: new FailingDriver("pty_unavailable") },
      index,
      now: () => 1,
    });
    expect(await codeOf(e.start({ agent: "claude", page: { url: "x" } }))).toBe("pty_unavailable");
  });
});
