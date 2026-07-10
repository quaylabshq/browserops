/**
 * Canonical BrowserOps conversation history.
 *
 * Providers are intentionally not consulted here: their streams and native
 * transcripts are inputs which the engine normalizes into this append-only
 * journal. A compact snapshot is rewritten atomically after each append so a
 * daemon restart can render history without Claude, Codex, or Cursor present.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ChatEvent, ChatMessage } from "@browserops/shared";
import { chatDir as defaultChatDir } from "../paths.js";

interface StoredEvent {
  version: 2;
  sequence: number;
  eventId: string;
  ts: number;
  origin: string;
  event: ChatEvent;
}

interface SessionSnapshot {
  version: 2;
  lastSequence: number;
  messages: ChatMessage[];
}

const queues = new Map<string, Promise<void>>();

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function isStoredEvent(value: unknown): value is StoredEvent {
  const v = asObject(value);
  return (
    !!v &&
    v["version"] === 2 &&
    typeof v["sequence"] === "number" &&
    typeof v["eventId"] === "string" &&
    typeof v["ts"] === "number" &&
    typeof v["origin"] === "string" &&
    asObject(v["event"]) !== null
  );
}

function materialize(records: readonly StoredEvent[]): ChatMessage[] {
  const messages = new Map<string, ChatMessage>();
  for (const record of records) {
    if (record.event.type !== "message") continue;
    // Partial deltas and the final message intentionally share an id. The
    // latest snapshot is the renderable state of that message.
    messages.set(record.event.message.id, record.event.message);
  }
  return [...messages.values()];
}

/** Versioned, per-conversation event journal. */
export class SessionStore {
  constructor(
    private readonly dir: string = defaultChatDir(),
    private readonly now: () => number = () => Date.now(),
    private readonly newId: () => string = () => randomUUID(),
  ) {}

  private sessionDir(sessionId: string): string {
    return join(this.dir, "sessions", sessionId);
  }

  private eventPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "events.jsonl");
  }

  private snapshotPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "snapshot.json");
  }

  async append(sessionId: string, event: ChatEvent, origin: string): Promise<ChatEvent> {
    let stored: ChatEvent | undefined;
    await this.serial(sessionId, async () => {
      const records = await this.records(sessionId);
      const sequence = (records.at(-1)?.sequence ?? 0) + 1;
      const eventId = event.eventId ?? this.newId();
      const normalized: ChatEvent = { ...event, sequence, eventId } as ChatEvent;
      const record: StoredEvent = {
        version: 2,
        sequence,
        eventId,
        ts: this.now(),
        origin,
        event: normalized,
      };
      const sessionDir = this.sessionDir(sessionId);
      await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
      await fs.appendFile(this.eventPath(sessionId), JSON.stringify(record) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      records.push(record);
      await this.writeSnapshot(sessionId, {
        version: 2,
        lastSequence: sequence,
        messages: materialize(records),
      });
      stored = normalized;
    });
    return stored!;
  }

  async events(sessionId: string, after = 0): Promise<ChatEvent[]> {
    const records = await this.records(sessionId);
    return records.filter((record) => record.sequence > after).map((record) => record.event);
  }

  async history(sessionId: string): Promise<ChatMessage[]> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.snapshotPath(sessionId), "utf8"));
      const snapshot = asObject(parsed);
      if (snapshot?.["version"] === 2 && Array.isArray(snapshot["messages"])) {
        return snapshot["messages"] as ChatMessage[];
      }
    } catch {
      // A missing/torn snapshot is recovered from the append-only journal.
    }
    return materialize(await this.records(sessionId));
  }

  async lastSequence(sessionId: string): Promise<number> {
    return (await this.records(sessionId)).at(-1)?.sequence ?? 0;
  }

  private async records(sessionId: string): Promise<StoredEvent[]> {
    let text: string;
    try {
      text = await fs.readFile(this.eventPath(sessionId), "utf8");
    } catch {
      return [];
    }
    const out: StoredEvent[] = [];
    const seen = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as unknown;
        if (!isStoredEvent(record) || seen.has(record.eventId)) continue;
        seen.add(record.eventId);
        out.push(record);
      } catch {
        // Append journals can end in a torn record after a crash; preserve all
        // preceding durable events.
      }
    }
    return out.sort((a, b) => a.sequence - b.sequence);
  }

  private async writeSnapshot(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    const path = this.snapshotPath(sessionId);
    const tmp = `${path}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, path);
  }

  private async serial(sessionId: string, work: () => Promise<void>): Promise<void> {
    const key = this.eventPath(sessionId);
    const prior = queues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    queues.set(
      key,
      next.catch(() => {}),
    );
    await next;
  }
}
