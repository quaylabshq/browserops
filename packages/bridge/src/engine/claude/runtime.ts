/**
 * Run one Claude turn as a headless stream-json subprocess (the "R2" model:
 * one process per turn). Validated against claude v2.1.153:
 *
 *   claude --print --output-format stream-json --verbose
 *          --append-system-prompt <sys>
 *          (--session-id <uuid> | --resume <uuid>)
 *          [--dangerously-skip-permissions] -- <userText>
 *
 * Spawned with NO shell (argv → execve, so `$(...)` in user text is inert) and
 * stdin ignored (claude otherwise stalls 3s waiting for stdin). stdout is a
 * newline-delimited JSON event stream; each line is normalized to ChatEvents.
 * The process exits at the turn's `result` event; the next turn re-spawns with
 * `--resume` (proven to continue the same session id + transcript file).
 */
import { spawn as nodeSpawn } from "node:child_process";
import type { ChatEvent } from "@browserops/shared";
import { liveEventToEvents } from "./normalize.js";

/** Minimal child surface the runtime needs, so a fake is trivial to inject. */
export interface ChildLike {
  stdout: {
    setEncoding(enc: string): void;
    on(ev: "data", cb: (chunk: string) => void): void;
  } | null;
  stderr: {
    setEncoding(enc: string): void;
    on(ev: "data", cb: (chunk: string) => void): void;
  } | null;
  on(ev: "error", cb: (err: Error) => void): void;
  on(ev: "close", cb: (code: number | null) => void): void;
}

export interface SpawnOptionsLike {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
  signal?: AbortSignal;
}

export type SpawnLike = (cmd: string, args: readonly string[], opts: SpawnOptionsLike) => ChildLike;

export interface TurnParams {
  bin: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onEvent: (event: ChatEvent) => void;
  spawn?: SpawnLike;
  signal?: AbortSignal;
  onStderr?: (chunk: string) => void;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emitLine(line: string, onEvent: (e: ChatEvent) => void): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return; // non-JSON banner / warning lines: ignore
  }
  for (const event of liveEventToEvents(obj)) onEvent(event);
}

/** Run a single turn to completion. Resolves with the process exit code. */
export function runClaudeTurn(p: TurnParams): Promise<number> {
  const spawn = p.spawn ?? (nodeSpawn as unknown as SpawnLike);
  return new Promise<number>((resolve) => {
    let settled = false;
    const done = (code: number): void => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };

    let child: ChildLike;
    try {
      child = spawn(p.bin, p.args, {
        cwd: p.cwd,
        env: p.env,
        stdio: ["ignore", "pipe", "pipe"],
        ...(p.signal ? { signal: p.signal } : {}),
      });
    } catch (err) {
      p.onEvent({ type: "status", state: "error", detail: errMsg(err) });
      done(-1);
      return;
    }

    let buf = "";
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          emitLine(line, p.onEvent);
        }
      });
    }
    if (child.stderr && p.onStderr) {
      child.stderr.setEncoding("utf8");
      const onStderr = p.onStderr;
      child.stderr.on("data", (chunk: string) => onStderr(chunk));
    }

    child.on("error", (err) => {
      // AbortError (deliberate stop) is not a real failure; surface others.
      if (!(err instanceof Error && err.name === "AbortError")) {
        p.onEvent({ type: "status", state: "error", detail: errMsg(err) });
      }
      done(-1);
    });
    child.on("close", (code) => {
      if (buf.trim().length > 0) emitLine(buf, p.onEvent);
      done(code ?? 0);
    });
  });
}
