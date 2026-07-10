/**
 * The BrowserOps conversation index. Canonical history lives in the per-session
 * event journals; this file is the small manifest used to list/reopen sessions
 * and reconstruct their provider bindings after a daemon restart. One JSON
 * file, newest-first, capped. Distinct from the unrelated `DaemonSession`
 * (tab-group) concept elsewhere in the bridge.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ChatProviderBinding, SessionRef } from "@browserops/shared";
import { sessionsDir } from "../paths.js";

export interface SessionMeta extends SessionRef {
  /** Epoch ms of the last user activity (start / send / stop). */
  lastActive: number;
  /** Version 2 records BrowserOps-owned conversations and provider bindings. */
  schemaVersion?: 2;
  bindings?: ChatProviderBinding[];
  lastEventSequence?: number;
}

const MAX_SESSIONS = 200;

function isMeta(value: unknown): value is SessionMeta {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["sessionId"] === "string" &&
    typeof v["agent"] === "string" &&
    typeof v["cwd"] === "string" &&
    typeof v["createdAt"] === "number" &&
    typeof v["lastActive"] === "number"
  );
}

export class SessionIndex {
  constructor(private readonly dir: string = sessionsDir()) {}

  private file(): string {
    return join(this.dir, "index.json");
  }

  /** All known sessions, newest activity first. Tolerates a missing/corrupt file. */
  async load(): Promise<SessionMeta[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file(), "utf8");
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isMeta).sort((a, b) => b.lastActive - a.lastActive);
    } catch {
      return [];
    }
  }

  async get(sessionId: string): Promise<SessionMeta | undefined> {
    return (await this.load()).find((m) => m.sessionId === sessionId);
  }

  /** Insert or replace a session, keeping the list newest-first and capped. */
  async upsert(meta: SessionMeta): Promise<void> {
    const all = (await this.load()).filter((m) => m.sessionId !== meta.sessionId);
    all.unshift(meta);
    all.sort((a, b) => b.lastActive - a.lastActive);
    await this.write(all.slice(0, MAX_SESSIONS));
  }

  /** Bump lastActive (no-op if the session isn't indexed). */
  async touch(sessionId: string, lastActive: number): Promise<void> {
    const all = await this.load();
    const found = all.find((m) => m.sessionId === sessionId);
    if (!found) return;
    found.lastActive = lastActive;
    all.sort((a, b) => b.lastActive - a.lastActive);
    await this.write(all);
  }

  async remove(sessionId: string): Promise<void> {
    const all = (await this.load()).filter((m) => m.sessionId !== sessionId);
    await this.write(all);
  }

  private async write(all: SessionMeta[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file()}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, this.file());
  }
}
