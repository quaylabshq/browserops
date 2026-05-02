import { randomUUID } from "node:crypto";
import type { DaemonClientInfo } from "@browserops/shared";

/**
 * Tab-group color palette. Mirrors `chrome.tabGroups.ColorEnum` order so
 * the extension can pass `session.color` directly to the tabGroups API.
 * Sessions cycle through this list; on overflow the daemon emits a
 * warning and keeps cycling.
 */
export const SESSION_COLORS = [
  "blue",
  "green",
  "yellow",
  "red",
  "pink",
  "purple",
  "cyan",
  "orange",
  "grey",
] as const;

export type SessionColor = (typeof SESSION_COLORS)[number];

/**
 * State carried per connected MCP client. Tab ownership and rate-limit
 * buckets land on this object in later phases; for the daemon skeleton
 * it just tracks identity and lifecycle.
 */
export interface DaemonSession {
  id: string;
  name: string;
  color: SessionColor;
  client_info: DaemonClientInfo;
  created_at_ms: number;
}

export interface SessionRegistryListener {
  onCreate?: (session: DaemonSession) => void;
  onDestroy?: (session: DaemonSession) => void;
  onWarn?: (message: string) => void;
}

/**
 * In-process session table. Owns id/name/color allocation and emits
 * lifecycle hooks the daemon uses to broadcast extension events.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, DaemonSession>();
  private nextSeq = 1;
  private nextColorIdx = 0;
  private listener: SessionRegistryListener;

  constructor(listener: SessionRegistryListener = {}) {
    this.listener = listener;
  }

  /**
   * Allocate a fresh session. `client_info.name` (e.g. "Claude Code")
   * seeds the display name; duplicates get a `#N` suffix so multiple
   * instances of the same client are distinguishable in Chrome.
   */
  create(client_info: DaemonClientInfo | undefined): DaemonSession {
    const info: DaemonClientInfo = client_info ?? { name: "session", version: "" };
    const baseName = info.name.trim() || "session";
    const id = randomUUID();
    const name = this.uniqueName(baseName);
    const color = this.allocateColor();

    const session: DaemonSession = {
      id,
      name,
      color,
      client_info: info,
      created_at_ms: Date.now(),
    };
    this.sessions.set(id, session);
    this.listener.onCreate?.(session);
    return session;
  }

  /**
   * Look a session up by id. Returns undefined for unknown ids.
   */
  get(id: string): DaemonSession | undefined {
    return this.sessions.get(id);
  }

  list(): DaemonSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Tear a session down. Idempotent — destroying a missing session is a
   * no-op so socket-close races don't have to coordinate.
   */
  destroy(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.listener.onDestroy?.(session);
  }

  /**
   * Rename a session; updates the Chrome tab-group label via the
   * destroy/create lifecycle hook a future phase will wire up.
   * No-op when name is unchanged.
   */
  rename(id: string, name: string): DaemonSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const trimmed = name.trim();
    if (!trimmed || trimmed === session.name) return session;
    session.name = this.uniqueName(trimmed);
    return session;
  }

  private uniqueName(base: string): string {
    const taken = new Set([...this.sessions.values()].map((s) => s.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} #${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    // Pathological — fall back to a random suffix.
    return `${base} #${Math.floor(Math.random() * 1e6)}`;
  }

  private allocateColor(): SessionColor {
    const color = SESSION_COLORS[this.nextColorIdx % SESSION_COLORS.length]!;
    this.nextColorIdx += 1;
    if (this.nextSeq > SESSION_COLORS.length) {
      this.listener.onWarn?.(
        `more than ${SESSION_COLORS.length} concurrent sessions — recycling tab-group colors`,
      );
    }
    this.nextSeq += 1;
    return color;
  }
}
