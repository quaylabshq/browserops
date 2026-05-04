/**
 * Daemon lifecycle helpers. The browserops daemon is a long-running Node
 * process that hosts the WebSocket bridge to the extension and accepts
 * shim connections over a Unix socket so multiple MCP clients can share
 * one Chrome profile.
 *
 * Aliveness signal: a connect to the daemon's socket at
 * ~/.browserops/daemon.sock. The daemon also writes its PID to
 * ~/.browserops/daemon.pid via acquirePidfile, so the CLI just reads
 * that for `status` / `stop` instead of maintaining its own.
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, openSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { daemonLogPath, daemonPidPath, daemonSocketPath, STATE_DIR } from "./paths.js";

export interface DaemonInvocation {
  command: string;
  args: string[];
}

/**
 * Resolve how to invoke the daemon binary.
 *
 * 1. If the caller passed an explicit path, use it directly.
 * 2. Else try to resolve `@browserops/bridge/package.json` via Node's
 *    module resolution and spawn `node <pkg-dir>/<bin.browserops-daemon>`.
 *    Works in both the workspace (pnpm-linked) and a global install.
 * 3. Else fall back to `browserops-daemon` on $PATH.
 */
export function resolveDaemonBin(explicit?: string): DaemonInvocation {
  if (explicit) {
    return { command: explicit, args: [] };
  }

  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve("@browserops/bridge/package.json");
    const pkgDir = dirname(pkgJsonPath);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      bin?: Record<string, string> | string;
    };
    let rel: string | undefined;
    if (typeof pkg.bin === "string") rel = pkg.bin;
    else if (pkg.bin && typeof pkg.bin === "object") rel = pkg.bin["browserops-daemon"];
    if (rel) {
      const abs = isAbsolute(rel) ? rel : resolve(pkgDir, rel);
      return { command: process.execPath, args: [abs] };
    }
  } catch {
    // package not resolvable (rare); fall through to PATH
  }

  return { command: "browserops-daemon", args: [] };
}

/**
 * Resolve how to invoke the shim binary. Used by `init` when writing
 * MCP-client config snippets (claude/cursor/codex/etc.).
 */
export function resolveShimBin(explicit?: string): DaemonInvocation {
  if (explicit) {
    return { command: explicit, args: [] };
  }

  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve("@browserops/bridge/package.json");
    const pkgDir = dirname(pkgJsonPath);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      bin?: Record<string, string> | string;
    };
    let rel: string | undefined;
    if (pkg.bin && typeof pkg.bin === "object") rel = pkg.bin["browserops-shim"];
    if (rel) {
      const abs = isAbsolute(rel) ? rel : resolve(pkgDir, rel);
      return { command: process.execPath, args: [abs] };
    }
  } catch {
    /* fall through */
  }

  return { command: "browserops-shim", args: [] };
}

export type DaemonStatus =
  | { running: false }
  | { running: true; pid: number | null; socket: string };

/** Probe the daemon socket. Returns true if a connect succeeds within 250ms. */
export async function isDaemonAlive(): Promise<boolean> {
  const sock = daemonSocketPath();
  if (!existsSync(sock)) return false;
  return new Promise<boolean>((resolveProbe) => {
    const conn = createConnection({ path: sock });
    const done = (ok: boolean): void => {
      conn.removeAllListeners();
      try { conn.destroy(); } catch { /* ignore */ }
      resolveProbe(ok);
    };
    conn.once("connect", () => done(true));
    conn.once("error", () => done(false));
    setTimeout(() => done(false), 250).unref();
  });
}

export async function readDaemonPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(daemonPidPath(), "utf8");
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function status(): Promise<DaemonStatus> {
  const alive = await isDaemonAlive();
  if (!alive) return { running: false };
  return { running: true, pid: await readDaemonPid(), socket: daemonSocketPath() };
}

/**
 * Spawn `browserops-daemon` detached. Returns when the daemon socket
 * is reachable, or rejects if it doesn't come up within `timeoutMs`.
 *
 * Logs are appended to ~/.browserops/daemon.log so the user can debug
 * a daemon that wouldn't start.
 */
export async function spawnDaemon(opts: {
  daemonBin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ pid: number }> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const { command, args } = resolveDaemonBin(opts.daemonBin);
  const timeoutMs = opts.timeoutMs ?? 5_000;

  // Open the daemon log file directly so the spawned process can inherit
  // the fd as its stdout/stderr — no pipe buffer that could fill up.
  const logFd = openSync(daemonLogPath(), "a");

  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  child.unref();

  // Poll the socket — the daemon prints "listening" to stderr right
  // after binding, but the socket existing AND accepting is the
  // canonical signal.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isDaemonAlive()) {
      return { pid: child.pid ?? -1 };
    }
    await delay(100);
  }
  throw new Error(
    `daemon spawned (pid ${child.pid}) but socket at ${daemonSocketPath()} did not come up within ${timeoutMs}ms — see ${daemonLogPath()}`,
  );
}

/**
 * Send SIGTERM to the daemon's recorded PID and wait for it to exit.
 * Returns true if we sent a signal, false if no PID was recorded (or
 * the process was already gone).
 */
export async function stopDaemon(opts?: { graceMs?: number }): Promise<boolean> {
  const pid = await readDaemonPid();
  if (pid === null) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  const graceMs = opts?.graceMs ?? 4_000;
  const start = Date.now();
  while (Date.now() - start < graceMs) {
    if (!processAlive(pid)) return true;
    await delay(100);
  }
  // grace expired — escalate
  try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  return true;
}

/** Best-effort liveness check via signal 0. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent ensure: bring the daemon up if it isn't already.
 * Used by `start` and by `init` after first run.
 */
export async function ensureDaemonRunning(opts?: {
  daemonBin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ alreadyRunning: boolean; pid?: number }> {
  if (await isDaemonAlive()) {
    return { alreadyRunning: true };
  }
  const { pid } = await spawnDaemon(opts ?? {});
  return { alreadyRunning: false, pid };
}
