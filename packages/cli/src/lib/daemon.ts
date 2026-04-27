/**
 * Daemon lifecycle helpers. The bridge is a long-running Node process; this
 * module wraps "is it alive?" / "spawn it detached" / "tell it to stop" with
 * the conventions other commands rely on.
 *
 * Aliveness signal: a connect to the bridge's control socket at
 * ~/.browserops/control.sock. The bridge already creates this socket on
 * primary-role startup (see packages/bridge/src/index.ts), so we don't need
 * a separate PID-file health check — the socket existing AND accepting a
 * connection is the source of truth. We also write a PID file as a
 * convenience for `stop` and `status`.
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import * as fs from "node:fs/promises";
import { existsSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { controlSocketPath, daemonLogPath, pidPath, STATE_DIR } from "./paths.js";

interface BridgeInvocation {
  command: string;
  args: string[];
}

/**
 * Resolve how to invoke the bridge.
 *
 * 1. If the caller passed an explicit path, use it directly.
 * 2. Else try to resolve `@browserops/bridge/package.json` via Node's module
 *    resolution and spawn `node <pkg-dir>/<bin.browserops-bridge>`. This works
 *    in both the workspace (pnpm-linked into the CLI package's node_modules)
 *    and a global npm install (the CLI's own dep tree).
 * 3. Else fall back to `browserops-bridge` on $PATH (the global-install case
 *    when the npm bin shim is what found us in the first place).
 */
function resolveBridgeBin(explicit?: string): BridgeInvocation {
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
    else if (pkg.bin && typeof pkg.bin === "object") rel = pkg.bin["browserops-bridge"];
    if (rel) {
      const abs = isAbsolute(rel) ? rel : resolve(pkgDir, rel);
      return { command: process.execPath, args: [abs] };
    }
  } catch {
    // package not resolvable (rare); fall through to PATH
  }

  return { command: "browserops-bridge", args: [] };
}

export type DaemonStatus =
  | { running: false }
  | { running: true; pid: number | null; socket: string };

/** Probe the control socket. Returns true if a connect succeeds within 250ms. */
export async function isBridgeAlive(): Promise<boolean> {
  const sock = controlSocketPath();
  if (!existsSync(sock)) return false;
  return new Promise<boolean>((resolve) => {
    const conn = createConnection({ path: sock });
    const done = (ok: boolean): void => {
      conn.removeAllListeners();
      try { conn.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    conn.once("connect", () => done(true));
    conn.once("error", () => done(false));
    setTimeout(() => done(false), 250).unref();
  });
}

export async function readPid(): Promise<number | null> {
  try {
    const raw = await fs.readFile(pidPath(), "utf8");
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function writePid(pid: number): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(pidPath(), String(pid), "utf8");
}

export async function clearPid(): Promise<void> {
  try { await fs.unlink(pidPath()); } catch { /* ignore */ }
}

export async function status(): Promise<DaemonStatus> {
  const alive = await isBridgeAlive();
  if (!alive) return { running: false };
  return { running: true, pid: await readPid(), socket: controlSocketPath() };
}

/**
 * Spawn `browserops-bridge` detached. Returns when the control socket is
 * reachable, or rejects if it doesn't come up within `timeoutMs`.
 *
 * Logs are appended to ~/.browserops/daemon.log so the user can debug a bridge
 * that wouldn't start.
 */
export async function spawnBridge(opts: {
  bridgeBin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ pid: number }> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const { command, args } = resolveBridgeBin(opts.bridgeBin);
  const timeoutMs = opts.timeoutMs ?? 5_000;

  // Open the daemon log file directly so the spawned process can inherit
  // the fd as its stdout/stderr — this means no pipe buffer that could fill
  // up and stall the bridge.
  const logFd = openSync(daemonLogPath(), "a");

  // BROWSEROPS_DAEMON=1 tells the bridge we spawned it as a long-running
  // daemon (stdio:ignore gives it /dev/null on stdin); without it, the bridge's
  // stdin-EOF handler would fire on the first read and tear the bridge down
  // before our control-socket health probe could observe it.
  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, BROWSEROPS_DAEMON: "1", ...(opts.env ?? {}) },
  });
  child.unref();
  if (child.pid) await writePid(child.pid);

  // Poll the control socket — the bridge prints "primary — listening" to
  // stderr right after binding, but we don't watch its log; the socket is
  // the canonical signal.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isBridgeAlive()) {
      return { pid: child.pid ?? -1 };
    }
    await delay(100);
  }
  throw new Error(
    `bridge spawned (pid ${child.pid}) but control socket at ${controlSocketPath()} did not come up within ${timeoutMs}ms — see ${daemonLogPath()}`,
  );
}

/**
 * Send SIGTERM to the recorded PID and wait for it to exit. Returns true if
 * we sent a signal, false if no PID was recorded (or the process was already
 * gone).
 */
export async function stopBridge(opts?: { graceMs?: number }): Promise<boolean> {
  const pid = await readPid();
  if (pid === null) {
    await clearPid();
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
    await clearPid();
    return false;
  }

  const graceMs = opts?.graceMs ?? 4_000;
  const start = Date.now();
  while (Date.now() - start < graceMs) {
    if (!processAlive(pid)) {
      await clearPid();
      return true;
    }
    await delay(100);
  }
  // grace expired — escalate
  try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
  await clearPid();
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
 * Idempotent ensure: bring the bridge up if it isn't already.
 * Used by --claude / --cursor / --codex launchers and by `init` after first run.
 */
export async function ensureBridgeRunning(opts?: {
  bridgeBin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<{ alreadyRunning: boolean; pid?: number }> {
  if (await isBridgeAlive()) {
    return { alreadyRunning: true };
  }
  const { pid } = await spawnBridge(opts ?? {});
  return { alreadyRunning: false, pid };
}
