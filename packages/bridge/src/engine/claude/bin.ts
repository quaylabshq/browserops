/**
 * Resolve the `claude` binary and a usable PATH for the chat engine.
 *
 * The catch: the engine spawns claude from the daemon, which runs detached and
 * may have a minimal PATH (GUI-launched on macOS). The terminal launcher dodges
 * this because the terminal inherits the user's login PATH; a headless spawn
 * does not. So we resolve against the login shell (which sources ~/.zprofile
 * etc.), and pass that PATH through to the spawned agent so it can find node,
 * git, and the browserops MCP shim. Both lookups are cached for the daemon's
 * lifetime.
 */
import { spawnSync } from "node:child_process";

/** First line that looks like an absolute path (for `command -v` output). */
export function firstPathLine(stdout: string | undefined): string | null {
  if (!stdout) return null;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("/") || /^[A-Za-z]:\\/.test(t)) return t;
  }
  return null;
}

function loginShell(): string {
  return process.env["SHELL"] || "/bin/zsh";
}

let cachedBin: string | null | undefined;
let cachedEnv: NodeJS.ProcessEnv | undefined;

/**
 * Absolute path to `claude`, or null if it can't be found. Tries the daemon's
 * own PATH first, then a login shell.
 */
export function resolveClaudeBin(override?: string): string | null {
  if (override) return override;
  if (cachedBin !== undefined) return cachedBin;

  const whichCmd = process.platform === "win32" ? "where" : "which";
  let found: string | null = null;
  try {
    const r = spawnSync(whichCmd, ["claude"], { encoding: "utf8" });
    if (r.status === 0) found = firstPathLine(r.stdout);
  } catch {
    /* ignore */
  }

  if (!found && process.platform !== "win32") {
    try {
      const r = spawnSync(loginShell(), ["-lic", "command -v claude"], { encoding: "utf8" });
      if (r.status === 0) found = firstPathLine(r.stdout);
    } catch {
      /* ignore */
    }
  }

  cachedBin = found;
  return found;
}

/**
 * An env whose PATH is the user's interactive PATH (so spawned claude finds its
 * own tools). Falls back to the daemon's PATH if the login shell can't be read.
 */
export function resolveLoginEnv(): NodeJS.ProcessEnv {
  if (cachedEnv !== undefined) return cachedEnv;
  let path = process.env["PATH"] ?? "";
  if (process.platform !== "win32") {
    try {
      const r = spawnSync(loginShell(), ["-lic", 'printf %s "$PATH"'], { encoding: "utf8" });
      if (r.status === 0 && r.stdout && r.stdout.includes("/")) path = r.stdout.trim();
    } catch {
      /* ignore */
    }
  }
  cachedEnv = { ...process.env, PATH: path };
  return cachedEnv;
}

/** Test seam: drop the memoised lookups. */
export function resetBinCache(): void {
  cachedBin = undefined;
  cachedEnv = undefined;
}
