/**
 * Disk-backed auto-teach session store.
 *
 * Owns the four files under each <session_id> directory:
 *   session.json    — AutoTeachSession (mutable, read/write)
 *   trace.jsonl     — append-only AutoTeachTraceRecord
 *   runs.jsonl      — append-only AutoTeachRun
 *   drafts/v<N>.yaml — written by the distiller, read by the variance gate
 *
 * Writes go through atomicWriteFile (tmp + rename) so a crash mid-flush
 * never leaves a torn meta. Trace and runs use plain fs.appendFile —
 * append is atomic for short JSONL lines on POSIX.
 */
import { promises as fs } from "node:fs";
import type {
  AutoTeachConsent,
  AutoTeachMode,
  AutoTeachOptimization,
  AutoTeachRun,
  AutoTeachSession,
  AutoTeachState,
  AutoTeachTraceRecord,
} from "@browserops/shared";
import { atomicWriteFile, CodedError } from "../procedures/store.js";
import {
  autoteachSessionsDir,
  draftPath,
  draftsDir,
  newSessionId,
  runsPath,
  sessionDir,
  sessionMetaPath,
  tracePath,
} from "./paths.js";

export interface CreateAutoTeachSessionInput {
  goal: string;
  mode: AutoTeachMode;
  consent: AutoTeachConsent;
  /** Multi-session daemon owner; empty string for legacy bridge entry. */
  owner_session_id: string;
  teach_session_id?: string;
}

export class AutoTeachStore {
  private rootEnsured = false;

  async create(input: CreateAutoTeachSessionInput): Promise<AutoTeachSession> {
    const sessionId = newSessionId();
    const session: AutoTeachSession = {
      session_id: sessionId,
      goal: input.goal,
      mode: input.mode,
      consent: input.consent,
      state: input.mode === "demo" ? "capturing_demo" : "exploring",
      ...(input.owner_session_id !== ""
        ? { owner_session_id: input.owner_session_id }
        : {}),
      ...(input.teach_session_id !== undefined
        ? { teach_session_id: input.teach_session_id }
        : {}),
      draft_version: 0,
      created_at: Date.now(),
    };
    await this.ensureSessionDir(sessionId);
    await this.writeSession(session);
    return session;
  }

  async get(sessionId: string): Promise<AutoTeachSession | null> {
    try {
      const raw = await fs.readFile(sessionMetaPath(sessionId), "utf8");
      return JSON.parse(raw) as AutoTeachSession;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async require(sessionId: string): Promise<AutoTeachSession> {
    const s = await this.get(sessionId);
    if (s === null) {
      throw new CodedError(
        "PROC_NOT_FOUND",
        `auto-teach session not found: ${sessionId}`,
        { session_id: sessionId },
      );
    }
    return s;
  }

  async update(
    sessionId: string,
    patch: Partial<Omit<AutoTeachSession, "session_id" | "created_at">>,
  ): Promise<AutoTeachSession> {
    const current = await this.require(sessionId);
    const next: AutoTeachSession = { ...current, ...patch };
    await this.writeSession(next);
    return next;
  }

  async setState(sessionId: string, state: AutoTeachState): Promise<void> {
    await this.update(sessionId, { state });
  }

  async list(ownerSessionId?: string): Promise<AutoTeachSession[]> {
    await this.ensureRoot();
    let entries: string[];
    try {
      entries = await fs.readdir(autoteachSessionsDir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: AutoTeachSession[] = [];
    for (const name of entries) {
      const meta = await this.get(name);
      if (meta === null) continue;
      if (
        ownerSessionId !== undefined &&
        ownerSessionId !== "" &&
        meta.owner_session_id !== ownerSessionId
      ) {
        continue;
      }
      out.push(meta);
    }
    out.sort((a, b) => b.created_at - a.created_at);
    return out;
  }

  // ----- Trace records ---------------------------------------------------

  async appendTrace(
    sessionId: string,
    record: AutoTeachTraceRecord,
  ): Promise<void> {
    await this.ensureSessionDir(sessionId);
    await fs.appendFile(tracePath(sessionId), JSON.stringify(record) + "\n", "utf8");
  }

  async readTrace(
    sessionId: string,
    runIndex?: number,
  ): Promise<AutoTeachTraceRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(tracePath(sessionId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: AutoTeachTraceRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      try {
        const rec = JSON.parse(line) as AutoTeachTraceRecord;
        if (runIndex !== undefined && rec.run_index !== runIndex) continue;
        out.push(rec);
      } catch {
        // Tolerate a partial trailing line.
      }
    }
    return out;
  }

  async traceCount(sessionId: string, runIndex: number): Promise<number> {
    const recs = await this.readTrace(sessionId, runIndex);
    return recs.length;
  }

  // ----- Run records -----------------------------------------------------

  async appendRun(sessionId: string, run: AutoTeachRun): Promise<void> {
    await this.ensureSessionDir(sessionId);
    await fs.appendFile(runsPath(sessionId), JSON.stringify(run) + "\n", "utf8");
    await this.update(sessionId, { last_run_at: run.started_at });
  }

  async readRuns(sessionId: string): Promise<AutoTeachRun[]> {
    let raw: string;
    try {
      raw = await fs.readFile(runsPath(sessionId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: AutoTeachRun[] = [];
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      try {
        out.push(JSON.parse(line) as AutoTeachRun);
      } catch {
        // skip
      }
    }
    return out.sort((a, b) => a.run_index - b.run_index);
  }

  /** Best (lowest tool_count, then lowest wall_clock) succeeded run. */
  async bestRun(sessionId: string): Promise<AutoTeachRun | null> {
    const runs = await this.readRuns(sessionId);
    let best: AutoTeachRun | null = null;
    for (const r of runs) {
      if (r.outcome === "failed") continue;
      if (
        best === null ||
        r.tool_count < best.tool_count ||
        (r.tool_count === best.tool_count && r.wall_clock_ms < best.wall_clock_ms)
      ) {
        best = r;
      }
    }
    return best;
  }

  // ----- Drafts ----------------------------------------------------------

  async writeDraft(sessionId: string, yaml: string): Promise<number> {
    const session = await this.require(sessionId);
    const nextVersion = session.draft_version + 1;
    await fs.mkdir(draftsDir(sessionId), { recursive: true });
    await atomicWriteFile(draftPath(sessionId, nextVersion), yaml);
    await this.update(sessionId, { draft_version: nextVersion });
    return nextVersion;
  }

  async readDraft(sessionId: string, version?: number): Promise<string | null> {
    const session = await this.require(sessionId);
    const v = version ?? session.draft_version;
    if (v === 0) return null;
    try {
      return await fs.readFile(draftPath(sessionId, v), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  // ----- internal --------------------------------------------------------

  private async ensureRoot(): Promise<void> {
    if (this.rootEnsured) return;
    await fs.mkdir(autoteachSessionsDir(), { recursive: true });
    this.rootEnsured = true;
  }

  private async ensureSessionDir(sessionId: string): Promise<void> {
    await this.ensureRoot();
    await fs.mkdir(sessionDir(sessionId), { recursive: true });
  }

  private async writeSession(session: AutoTeachSession): Promise<void> {
    await this.ensureSessionDir(session.session_id);
    await atomicWriteFile(
      sessionMetaPath(session.session_id),
      JSON.stringify(session, null, 2) + "\n",
    );
  }
}

/** Helper used by both record_run and convergence — typed echoing. */
export interface RunDelta {
  tool_count: number;
  wall_clock_ms: number;
}

export function computeOutcome(
  current: { tool_count: number; wall_clock_ms: number; succeeded: boolean },
  best: { tool_count: number; wall_clock_ms: number } | null,
): { outcome: AutoTeachRun["outcome"]; delta: RunDelta } {
  if (!current.succeeded) {
    return {
      outcome: "failed",
      delta: { tool_count: 0, wall_clock_ms: 0 },
    };
  }
  if (best === null) {
    return {
      outcome: "improved",
      delta: { tool_count: 0, wall_clock_ms: 0 },
    };
  }
  const dTool = current.tool_count - best.tool_count;
  const dWall = current.wall_clock_ms - best.wall_clock_ms;
  // Noise floor: ≤5% wall-clock variance with no tool-count change is a noop.
  const wallNoiseFloor = Math.max(50, Math.floor(best.wall_clock_ms * 0.05));
  if (dTool === 0 && Math.abs(dWall) <= wallNoiseFloor) {
    return { outcome: "noop", delta: { tool_count: dTool, wall_clock_ms: dWall } };
  }
  if (dTool < 0 || (dTool === 0 && dWall < -wallNoiseFloor)) {
    return { outcome: "improved", delta: { tool_count: dTool, wall_clock_ms: dWall } };
  }
  return { outcome: "regressed", delta: { tool_count: dTool, wall_clock_ms: dWall } };
}

// Re-export for callers that don't want to import from autoteach/* and
// procedures/* both.
export { CodedError } from "../procedures/store.js";

/** Imported for use in callers that need the optimization shape. */
export type { AutoTeachOptimization };
