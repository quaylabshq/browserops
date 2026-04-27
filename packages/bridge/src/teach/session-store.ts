import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { TeachEvent, TeachSessionMeta, TeachScope } from "@browserops/shared";
import { eventsPath, metaPath, teachSessionsDir } from "./paths.js";

/**
 * Disk-backed teach-session store.
 *
 * Layout (under teachSessionsDir()):
 *   <session_id>.jsonl       — one TeachEvent per line, append-only
 *   <session_id>.meta.json   — TeachSessionMeta sidecar
 *
 * Two responsibilities:
 *   1. Append events as they arrive over the WS Event channel.
 *   2. Serve agent-facing reads via observe() with optional long-poll —
 *      blocks up to wait_ms for new events, useful for streaming a teach
 *      session into the agent's context as the user demonstrates.
 *
 * All writes are append-or-overwrite of small files. No truncation, no
 * compaction — sessions are ephemeral (the user starts and stops them
 * within a single working session) and capped indirectly by event_count.
 */
export class TeachSessionStore {
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly metaCache = new Map<string, TeachSessionMeta>();
  private rootEnsured = false;

  /** Append a TeachEvent and wake any in-flight observe() waiters. */
  async appendEvent(ev: TeachEvent): Promise<void> {
    await this.ensureRoot();
    const line = JSON.stringify(ev) + "\n";
    await fs.appendFile(eventsPath(ev.session_id), line, "utf8");
    const meta = await this.getOrCreateMeta(ev);
    if (ev.seq > meta.event_count) meta.event_count = ev.seq;
    await this.writeMeta(meta);
    this.notifyWaiters(ev.session_id);
  }

  /**
   * Mark a session stopped. Called by procedures_teach_stop (Step 5) after
   * the extension confirms shutdown. Idempotent — second call is a no-op.
   */
  async finalize(
    sessionId: string,
    stoppedAt: number,
    eventCount: number,
  ): Promise<TeachSessionMeta | null> {
    const meta = await this.getMeta(sessionId);
    if (meta === null) return null;
    if (meta.stopped_at === undefined) meta.stopped_at = stoppedAt;
    if (eventCount > meta.event_count) meta.event_count = eventCount;
    await this.writeMeta(meta);
    this.notifyWaiters(sessionId);
    return meta;
  }

  /** List all known sessions, newest first. */
  async list(): Promise<TeachSessionMeta[]> {
    await this.ensureRoot();
    let files: string[];
    try {
      files = await fs.readdir(teachSessionsDir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: TeachSessionMeta[] = [];
    for (const f of files) {
      if (!f.endsWith(".meta.json")) continue;
      const sessionId = f.slice(0, -".meta.json".length);
      const meta = await this.getMeta(sessionId);
      if (meta !== null) out.push(meta);
    }
    return out.sort((a, b) => b.started_at - a.started_at);
  }

  async getMeta(sessionId: string): Promise<TeachSessionMeta | null> {
    const cached = this.metaCache.get(sessionId);
    if (cached !== undefined) return cached;
    try {
      const raw = await fs.readFile(metaPath(sessionId), "utf8");
      const parsed = JSON.parse(raw) as TeachSessionMeta;
      this.metaCache.set(sessionId, parsed);
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Read all events with seq > sinceSeq, capped at maxBatch. If no new
   * events are available and waitMs > 0 and the session is still active,
   * block up to waitMs for the next append.
   */
  async observe(
    sessionId: string,
    sinceSeq: number,
    waitMs: number,
    maxBatch: number,
  ): Promise<{ events: TeachEvent[]; next_seq: number; finished: boolean }> {
    let events = await this.readSince(sessionId, sinceSeq, maxBatch);
    if (events.length === 0 && waitMs > 0) {
      const meta = await this.getMeta(sessionId);
      if (meta !== null && meta.stopped_at === undefined) {
        await this.waitForUpdate(sessionId, waitMs);
        events = await this.readSince(sessionId, sinceSeq, maxBatch);
      }
    }
    const meta = await this.getMeta(sessionId);
    const finished =
      meta !== null &&
      meta.stopped_at !== undefined &&
      (events.length === 0 || lastSeq(events) >= meta.event_count);
    const nextSeq = events.length > 0 ? lastSeq(events) : sinceSeq;
    return { events, next_seq: nextSeq, finished };
  }

  // -----------------------------------------------------------------------

  private async ensureRoot(): Promise<void> {
    if (this.rootEnsured) return;
    await fs.mkdir(teachSessionsDir(), { recursive: true });
    this.rootEnsured = true;
  }

  private async getOrCreateMeta(ev: TeachEvent): Promise<TeachSessionMeta> {
    const existing = await this.getMeta(ev.session_id);
    if (existing !== null) return existing;
    // Backfill: the extension started a session and sent its first event
    // before any meta was written by the bridge. Infer meta from event 1.
    const meta: TeachSessionMeta = {
      session_id: ev.session_id,
      started_at: ev.ts,
      scope: "all_tabs" as TeachScope,
      event_count: 0,
    };
    return meta;
  }

  private async writeMeta(meta: TeachSessionMeta): Promise<void> {
    await this.ensureRoot();
    const path = metaPath(meta.session_id);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(meta, null, 2) + "\n", "utf8");
    this.metaCache.set(meta.session_id, meta);
  }

  private async readSince(
    sessionId: string,
    sinceSeq: number,
    maxBatch: number,
  ): Promise<TeachEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(eventsPath(sessionId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: TeachEvent[] = [];
    let cursor = 0;
    while (cursor < raw.length && out.length < maxBatch) {
      const nl = raw.indexOf("\n", cursor);
      const slice = nl === -1 ? raw.slice(cursor) : raw.slice(cursor, nl);
      cursor = nl === -1 ? raw.length : nl + 1;
      if (slice === "") continue;
      try {
        const ev = JSON.parse(slice) as TeachEvent;
        if (ev.seq > sinceSeq) out.push(ev);
      } catch {
        // Tolerate a partial trailing line — appendFile is atomic per call
        // but a crash mid-write could in theory leave one. Skip and move on.
      }
    }
    return out;
  }

  private waitForUpdate(sessionId: string, waitMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        const list = this.waiters.get(sessionId);
        if (list !== undefined) {
          const idx = list.indexOf(notify);
          if (idx >= 0) list.splice(idx, 1);
        }
        clearTimeout(timer);
        resolve();
      };
      const notify = (): void => settle();
      const timer = setTimeout(settle, waitMs);
      if (typeof timer === "object" && "unref" in timer) timer.unref();
      const list = this.waiters.get(sessionId);
      if (list === undefined) this.waiters.set(sessionId, [notify]);
      else list.push(notify);
    });
  }

  private notifyWaiters(sessionId: string): void {
    const list = this.waiters.get(sessionId);
    if (list === undefined) return;
    // Copy and clear before invoking — handlers will splice on settle.
    const copy = list.slice();
    for (const fn of copy) fn();
  }
}

function lastSeq(events: TeachEvent[]): number {
  return events.length > 0 ? (events[events.length - 1] as TeachEvent).seq : 0;
}
