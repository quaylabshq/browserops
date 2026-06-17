/**
 * node-pty wrapper for the interactive-terminal transport.
 *
 * Why a wrapper:
 *  - **Lazy + isolated.** node-pty is a native module; we `import()` it only when
 *    the terminal transport actually starts, so a missing/incompatible binary
 *    surfaces as {@link PtyUnavailableError} (the engine then falls back to the
 *    headless driver) instead of crashing the daemon at boot.
 *  - **spawn-helper +x guard.** On macOS/Linux node-pty exec's a `spawn-helper`
 *    binary; its execute bit is frequently lost when the prebuild is extracted by
 *    a package manager that skips build scripts (pnpm's `onlyBuiltDependencies`),
 *    which makes `pty.spawn` fail with `posix_spawnp failed`. We re-`chmod +x` it
 *    before the first spawn. (Verified necessary against node-pty 1.1.0 here.)
 *  - **Submit semantics.** Claude's Ink TUI swallows a single `text\r` write as a
 *    paste; the text and the Enter must be SEPARATE writes with a settle gap
 *    (verified). {@link submitText} encodes that, bracketed-pasting multi-line
 *    input so embedded newlines don't submit early.
 *  - **Fan-out + replay.** One pty feeds two consumers — the transcript-tailer is
 *    independent, but the embedded xterm pane attaches/detaches over a WebSocket
 *    and needs the scrollback replayed so it renders the current screen.
 */
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

export class PtyUnavailableError extends Error {
  constructor(reason: string) {
    super(`pty transport unavailable: ${reason}`);
    this.name = "PtyUnavailableError";
  }
}

/** The minimal slice of node-pty's IPty we depend on (keeps node-pty's types out of the rest of the bridge). */
export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
}

export interface SpawnPtyOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  name?: string;
}

export type PtySpawner = (opts: SpawnPtyOptions) => PtyProcess;

export interface PtyLoaderDeps {
  /** Override the dynamic import (tests). */
  importModule?: () => Promise<unknown>;
  /** Override node-pty module-dir resolution (tests). */
  resolveDir?: () => string;
  /** Override fs ops for the spawn-helper chmod guard (tests). */
  fsOps?: {
    stat: (p: string) => Promise<{ mode: number }>;
    chmod: (p: string, mode: number) => Promise<void>;
  };
}

function defaultResolveDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("node-pty/package.json"));
}

/** Re-assert the execute bit on node-pty's spawn-helper for the running platform. */
async function ensureSpawnHelperExecutable(
  dir: string,
  fsOps: NonNullable<PtyLoaderDeps["fsOps"]>,
): Promise<void> {
  const platformDir = `${process.platform}-${process.arch}`;
  const candidates = [
    join(dir, "build", "Release", "spawn-helper"),
    join(dir, "prebuilds", platformDir, "spawn-helper"),
  ];
  for (const p of candidates) {
    try {
      const st = await fsOps.stat(p);
      if ((st.mode & 0o111) === 0) await fsOps.chmod(p, st.mode | 0o755);
    } catch {
      // Absent on this platform/build (e.g. Windows uses conpty) — nothing to fix.
    }
  }
}

let cachedSpawner: PtySpawner | undefined;

/**
 * Lazily load node-pty into a {@link PtySpawner}, repairing the spawn-helper
 * exec bit first. Throws {@link PtyUnavailableError} if the native module can't
 * be loaded. The real (non-injected) result is cached for the daemon's lifetime.
 */
export async function loadPtySpawner(deps: PtyLoaderDeps = {}): Promise<PtySpawner> {
  const injected =
    deps.importModule !== undefined || deps.resolveDir !== undefined || deps.fsOps !== undefined;
  if (cachedSpawner && !injected) return cachedSpawner;

  const fsOps =
    deps.fsOps ??
    ({
      stat: (p: string) => fs.stat(p).then((s) => ({ mode: s.mode })),
      chmod: (p: string, mode: number) => fs.chmod(p, mode),
    } satisfies NonNullable<PtyLoaderDeps["fsOps"]>);

  try {
    const dir = (deps.resolveDir ?? defaultResolveDir)();
    await ensureSpawnHelperExecutable(dir, fsOps);
    const mod = await (deps.importModule ?? (() => import("node-pty")))();
    const spawn = (mod as { spawn?: unknown }).spawn;
    if (typeof spawn !== "function") throw new Error("node-pty has no spawn export");
    const spawnFn = spawn as (
      file: string,
      args: string[],
      opts: Record<string, unknown>,
    ) => unknown;
    const spawner: PtySpawner = (o) =>
      spawnFn(o.file, o.args, {
        name: o.name ?? "xterm-256color",
        cols: o.cols ?? 120,
        rows: o.rows ?? 30,
        cwd: o.cwd,
        env: o.env,
      }) as PtyProcess;
    if (!injected) cachedSpawner = spawner;
    return spawner;
  } catch (err) {
    throw new PtyUnavailableError(err instanceof Error ? err.message : String(err));
  }
}

/** Test seam: drop the memoised spawner. */
export function resetPtyCache(): void {
  cachedSpawner = undefined;
}

const BRACKET_PASTE_START = "\x1b[200~";
const BRACKET_PASTE_END = "\x1b[201~";

export interface SubmitOptions {
  /** Gap between writing the text and pressing Enter. */
  settleMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Submit a turn to an interactive TUI on a pty. The text and the Enter are
 * SEPARATE writes with a settle gap — a single `text\r` write is swallowed as a
 * paste. Multi-line text is bracketed-pasted so embedded newlines don't submit
 * early; one discrete Enter then sends it.
 */
export async function submitText(
  write: (data: string) => void,
  text: string,
  opts: SubmitOptions = {},
): Promise<void> {
  const settleMs = opts.settleMs ?? 140;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (text.includes("\n")) write(`${BRACKET_PASTE_START}${text}${BRACKET_PASTE_END}`);
  else write(text);
  await sleep(settleMs);
  write("\r");
}

export type Unsubscribe = () => void;

const REPLAY_CAP = 256 * 1024;

export interface PtySessionStartOptions extends SpawnPtyOptions {
  /** Inject a spawner (tests) or skip the lazy load. */
  spawner?: PtySpawner;
  loaderDeps?: PtyLoaderDeps;
}

/**
 * A live pty: write/submit/resize, fan-out raw output to many listeners (with
 * bounded scrollback replay for late attachers), and a readiness gate.
 */
export class PtySession {
  private readonly listeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();
  private replay: string[] = [];
  private replayBytes = 0;
  private exited = false;

  private constructor(private readonly pty: PtyProcess) {
    pty.onData((d) => this.handleData(d));
    pty.onExit((e) => {
      this.exited = true;
      for (const l of [...this.exitListeners]) l(e);
    });
  }

  static async start(opts: PtySessionStartOptions): Promise<PtySession> {
    const spawner = opts.spawner ?? (await loadPtySpawner(opts.loaderDeps ?? {}));
    const pty = spawner({
      file: opts.file,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      ...(opts.cols !== undefined ? { cols: opts.cols } : {}),
      ...(opts.rows !== undefined ? { rows: opts.rows } : {}),
      ...(opts.name !== undefined ? { name: opts.name } : {}),
    });
    return new PtySession(pty);
  }

  get pid(): number {
    return this.pty.pid;
  }
  get hasExited(): boolean {
    return this.exited;
  }

  write(data: string): void {
    this.pty.write(data);
  }

  submit(text: string, opts?: SubmitOptions): Promise<void> {
    return submitText((d) => this.pty.write(d), text, opts);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  /** Subscribe to raw output; replays bounded scrollback first so a late attacher renders the screen. */
  onData(listener: (data: string) => void): Unsubscribe {
    if (this.replay.length > 0) listener(this.replay.join(""));
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (e: { exitCode: number; signal?: number }) => void): Unsubscribe {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Resolve once output has been quiet for `quietMs`, or after `timeoutMs` (hard cap). */
  waitUntilReady(opts: { quietMs?: number; timeoutMs?: number } = {}): Promise<void> {
    const quietMs = opts.quietMs ?? 600;
    const timeoutMs = opts.timeoutMs ?? 15000;
    return new Promise<void>((resolve) => {
      let settled = false;
      let quiet: ReturnType<typeof setTimeout> | undefined;
      let hard: ReturnType<typeof setTimeout> | undefined;
      let unsub: Unsubscribe = () => {};
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (quiet) clearTimeout(quiet);
        if (hard) clearTimeout(hard);
        unsub();
        resolve();
      };
      const bump = (): void => {
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(finish, quietMs);
      };
      hard = setTimeout(finish, timeoutMs);
      unsub = this.onData(() => bump());
      bump();
    });
  }

  kill(signal?: string): void {
    try {
      this.pty.kill(signal);
    } catch {
      // already gone
    }
    this.listeners.clear();
  }

  private handleData(data: string): void {
    this.replay.push(data);
    this.replayBytes += data.length;
    while (this.replayBytes > REPLAY_CAP && this.replay.length > 1) {
      this.replayBytes -= this.replay.shift()!.length;
    }
    for (const l of [...this.listeners]) l(data);
  }
}
