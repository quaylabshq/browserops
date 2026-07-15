import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, SessionRef } from "@browserops/shared";
import {
  InteractivePtyDriver,
  type InteractivePtyBuildInput,
  type InteractivePtyTailerContext,
} from "./interactive-pty-driver.js";
import type { ProviderTranscriptTailer } from "./pty-transcript.js";
import type { PtyProcess, PtySpawner } from "./claude/pty.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakePty implements PtyProcess {
  pid = 1;
  writes: string[] = [];
  killed = false;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  write(data: string): void {
    this.writes.push(data);
  }
  resize(): void {}
  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }
  kill(): void {
    this.killed = true;
  }
  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

class HarnessTailer implements ProviderTranscriptTailer {
  constructor(private readonly context: InteractivePtyTailerContext) {}
  start(): void {
    this.context.onNativeSession("native-session");
  }
  stop(): void {}
  markThinking(): void {
    this.context.emit({ type: "status", state: "thinking" });
  }
  markIdle(): void {
    this.context.emit({ type: "status", state: "idle" });
  }
  history(): Promise<ChatMessage[]> {
    return Promise.resolve([]);
  }
}

class HarnessDriver extends InteractivePtyDriver {
  override readonly id = "codex" as const;
  args: InteractivePtyBuildInput[] = [];

  constructor(spawner: PtySpawner, chatDir: string) {
    super("codex", "codex", {
      bin: "/bin/codex",
      env: {},
      spawner,
      chatDir,
      randomUUID: () => "driver-session",
      now: () => 1,
      buildSystemPrompt: () => "SYSTEM",
      buildPrompt: (_page, instruction) => `SEED:${instruction ?? ""}`,
      ready: { quietMs: 1, timeoutMs: 50 },
      submit: { settleMs: 0, sleep: () => Promise.resolve() },
    });
  }

  protected buildInteractiveArgs(input: InteractivePtyBuildInput): string[] {
    this.args.push(input);
    return input.resume ? ["resume", input.ref.nativeSessionId ?? ""] : ["interactive"];
  }
  protected createTranscriptTailer(context: InteractivePtyTailerContext): ProviderTranscriptTailer {
    return new HarnessTailer(context);
  }
  protected loadNativeHistory(): Promise<ChatMessage[]> {
    return Promise.resolve([]);
  }
}

describe("InteractivePtyDriver", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "browserops-interactive-pty-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("drives one persistent terminal, persists the discovered native id, and cancels in place", async () => {
    const pty = new FakePty();
    const driver = new HarnessDriver(() => pty, join(tmp, "chat"));
    const ref = await driver.start({
      page: { url: "https://example.test" },
      instruction: "hello",
      cwd: tmp,
    });
    pty.emitData("TUI ready");
    await sleep(15);

    expect(ref.nativeSessionId).toBe("native-session");
    expect(driver.args).toHaveLength(1);
    expect(driver.args[0]).toMatchObject({ resume: false });
    expect(pty.writes).toEqual(["SYSTEM SEED:hello", "\r"]);

    await driver.send(ref, "follow up");
    expect(pty.writes.slice(-2)).toEqual(["follow up", "\r"]);
    await driver.cancel(ref);
    expect(pty.writes).toContain("\u0003");
    expect(driver.terminalLive(ref)).toBe(true);
  });

  it("recreates a hidden terminal with the provider's native session after restart", async () => {
    const pty = new FakePty();
    const driver = new HarnessDriver(() => pty, join(tmp, "chat"));
    const ref: SessionRef = {
      agent: "codex",
      sessionId: "driver-session",
      nativeSessionId: "native-session",
      cwd: tmp,
      createdAt: 1,
    };
    const send = driver.send(ref, "after restart");
    await sleep(10);
    pty.emitData("TUI ready");
    await send;
    expect(driver.args).toHaveLength(1);
    expect(driver.args[0]).toMatchObject({
      resume: true,
      ref: { nativeSessionId: "native-session" },
    });
    expect(pty.writes.slice(-2)).toEqual(["after restart", "\r"]);
  });
});
