import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent, SessionRef } from "@browserops/shared";
import {
  HeadlessProcessDriver,
  type BuildArgsInput,
  type ChildLike,
  type NormalizeContext,
  type NormalizedLine,
  type SpawnLike,
} from "./process-driver.js";

class StreamingHarness extends HeadlessProcessDriver {
  constructor(deps: { chatDir: string; spawn: SpawnLike }) {
    super("cursor", "agent", {
      bin: "agent",
      chatDir: deps.chatDir,
      spawn: deps.spawn,
      buildSystemPrompt: () => "",
      buildPrompt: () => "",
    });
  }

  protected buildArgs(_input: BuildArgsInput): string[] {
    return [];
  }

  protected normalizeLine(raw: unknown, _context: NormalizeContext): NormalizedLine {
    const kind = (raw as { kind?: string }).kind;
    if (kind === "first") {
      return {
        events: [
          {
            type: "message",
            message: {
              id: "first-stream",
              role: "assistant",
              blocks: [{ kind: "text", text: "Before tool" }],
              partial: true,
            },
          },
        ],
      };
    }
    if (kind === "tool") {
      return {
        events: [
          {
            type: "message",
            message: {
              id: "tool-1",
              role: "assistant",
              blocks: [{ kind: "tool_use", id: "tool-1", name: "browser_health_check", input: {} }],
            },
          },
        ],
      };
    }
    if (kind === "second") {
      return {
        events: [
          {
            type: "message",
            message: {
              id: "second-stream",
              role: "assistant",
              blocks: [{ kind: "text", text: "After tool" }],
              partial: true,
            },
          },
        ],
      };
    }
    return { events: [{ type: "status", state: "idle" }] };
  }
}

function streamSpawn(lines: readonly string[]): SpawnLike {
  return (): ChildLike => {
    let write: ((chunk: string) => void) | undefined;
    let close: ((code: number | null) => void) | undefined;
    queueMicrotask(() => {
      write?.(lines.map((line) => `${line}\n`).join(""));
      close?.(0);
    });
    return {
      stdout: {
        setEncoding: () => {},
        on: (_event, handler) => {
          write = handler;
        },
      },
      stderr: null,
      on: (event, handler) => {
        if (event === "close") close = handler as (code: number | null) => void;
      },
    };
  };
}

async function waitForIdle(driver: StreamingHarness, ref: SessionRef): Promise<ChatEvent[]> {
  return new Promise<ChatEvent[]>((resolve) => {
    const events: ChatEvent[] = [];
    let done = false;
    let unsubscribe: () => void = () => {};
    const listener = (event: ChatEvent): void => {
      events.push(event);
      if (event.type === "status" && event.state === "idle") {
        done = true;
        resolve(events);
      }
    };
    unsubscribe = driver.subscribe(ref, listener);
    if (done) unsubscribe();
  });
}

describe("HeadlessProcessDriver partial streams", () => {
  let chatDir: string;

  afterEach(async () => {
    if (chatDir) {
      // Transcript writes intentionally continue after listener fan-out.
      await fs.rm(chatDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("finalizes a paused stream before its tool call and the resumed stream at turn end", async () => {
    chatDir = await fs.mkdtemp(join(tmpdir(), "browserops-process-stream-"));
    const driver = new StreamingHarness({
      chatDir,
      spawn: streamSpawn([
        JSON.stringify({ kind: "first" }),
        JSON.stringify({ kind: "tool" }),
        JSON.stringify({ kind: "second" }),
        JSON.stringify({ kind: "result" }),
      ]),
    });
    const ref = await driver.start({
      sessionId: randomUUID(),
      cwd: chatDir,
      page: { url: "https://example.test" },
      instruction: "test",
    });
    const events = await waitForIdle(driver, ref);
    const messages = events.filter(
      (event): event is Extract<ChatEvent, { type: "message" }> => event.type === "message",
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({ id: "first-stream", partial: true }),
        }),
        expect.objectContaining({
          message: expect.objectContaining({ id: "first-stream", partial: undefined }),
        }),
        expect.objectContaining({ message: expect.objectContaining({ id: "tool-1" }) }),
        expect.objectContaining({
          message: expect.objectContaining({ id: "second-stream", partial: true }),
        }),
        expect.objectContaining({
          message: expect.objectContaining({ id: "second-stream", partial: undefined }),
        }),
      ]),
    );
    expect(
      messages.findIndex((event) => event.message.id === "first-stream" && !event.message.partial),
    ).toBeLessThan(messages.findIndex((event) => event.message.id === "tool-1"));
  });
});
