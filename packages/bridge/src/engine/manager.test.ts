import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent, ChatMessage, SessionRef } from "@browserops/shared";
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
import { SessionIndex } from "./sessions.js";

class FakeDriver implements AgentDriver {
  readonly id = "claude" as const;
  started: StartOpts[] = [];
  sent: { id: string; text: string }[] = [];
  stopped: string[] = [];
  historyResult: ChatMessage[] = [];
  private seq = 0;
  private readonly listeners = new Map<string, Set<ChatEventListener>>();

  async start(opts: StartOpts): Promise<SessionRef> {
    this.started.push(opts);
    const sessionId = `s${++this.seq}`;
    this.listeners.set(sessionId, new Set());
    return {
      agent: "claude",
      sessionId,
      cwd: opts.cwd ?? "/w",
      createdAt: 7,
      ...(opts.instruction !== undefined ? { title: opts.instruction } : {}),
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
  let driver: FakeDriver;
  let engine: ChatEngine;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-engine-"));
    index = new SessionIndex(dir);
    driver = new FakeDriver();
    engine = new ChatEngine({ drivers: { claude: driver }, index, now: () => 1000 });
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
    expect(ref.sessionId).toBe("s1");
    expect(driver.started).toHaveLength(1);
    const sessions = await engine.listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(sessions[0]).toMatchObject({ lastActive: 1000, title: "hi" });
  });

  it("subscribe fans driver events to the listener", async () => {
    const ref = await engine.start({ agent: "claude", page: { url: "x" } });
    const got: ChatEvent[] = [];
    await engine.subscribe(ref.sessionId, (e) => got.push(e));
    driver.emit("s1", { type: "status", state: "thinking" });
    expect(got).toEqual([{ type: "status", state: "thinking" }]);
  });

  it("send routes through and bumps lastActive", async () => {
    const ref = await engine.start({ agent: "claude", page: { url: "x" } });
    const engine2 = new ChatEngine({ drivers: { claude: driver }, index, now: () => 2000 });
    await engine2.send(ref.sessionId, "next");
    expect(driver.sent).toEqual([{ id: "s1", text: "next" }]);
    expect((await index.get("s1"))!.lastActive).toBe(2000);
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

  it("eject prefers the driver's relinquish over stop", async () => {
    const d = new RelinquishDriver();
    const e = new ChatEngine({ drivers: { claude: d }, index, now: () => 1 });
    const ref = await e.start({ agent: "claude", page: { url: "x" } });
    await e.eject(ref.sessionId);
    expect(d.relinquished).toEqual([ref.sessionId]);
    expect(d.stopped).toEqual([]); // hard stop NOT used when relinquish exists
  });

  it("eject falls back to stop for a driver without relinquish (headless)", async () => {
    const ref = await engine.start({ agent: "claude", page: { url: "x" } });
    await engine.eject(ref.sessionId);
    expect(driver.stopped).toEqual(["s1"]);
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

  it("resolves a cold session from the index after a restart", async () => {
    const ref = await engine.start({ agent: "claude", page: { url: "x" } });
    const driver2 = new FakeDriver();
    const engine2 = new ChatEngine({ drivers: { claude: driver2 }, index, now: () => 3000 });
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
      now: () => 1,
    });
    const ref = await e.start({ agent: "claude", page: { url: "x" }, instruction: "hi" });
    expect(fallback.started).toHaveLength(1);
    await e.send(ref.sessionId, "next");
    expect(fallback.sent).toEqual([{ id: ref.sessionId, text: "next" }]);
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
