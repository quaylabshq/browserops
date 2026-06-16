/**
 * Spawn an interactive `claude` session in a brand-new terminal window, on
 * request from the extension popup (via the bridge's POST /launch endpoint).
 *
 * Why a new terminal at all: the daemon runs detached with `stdio: "ignore"`
 * and has no controlling TTY, so it cannot `stdio: "inherit"` the way the CLI
 * launcher (`packages/cli/src/launchers/claude.ts`) does. Instead it writes a
 * tiny launcher script + a context file under the 0700 state dir, then asks
 * the OS to open a terminal that runs the script.
 *
 * Injection safety (the load-bearing invariant): the page metadata seeded into
 * Claude's system prompt only ever crosses into the shell as the *content of a
 * file* read into a variable (`cat` / `Get-Content -Raw`). It is NEVER
 * interpolated into the launcher script source or a command line. Only
 * repo-controlled values (our own random temp paths, the fixed danger flag)
 * are interpolated. A page `<title>` of `$(rm -rf ~)` is therefore inert.
 *
 * `claude` is invoked by bare name *inside the new terminal*, which inherits
 * the user's interactive PATH — not the daemon's possibly-minimal PATH. The
 * launcher guards with `command -v claude` / `Get-Command claude` and prints a
 * window-staying error when it's missing.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadSafeMode } from "./config.js";
import { launchDir } from "./paths.js";
import type { Logger } from "./logger.js";

export interface PageContext {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
}

export type LaunchResult = { ok: true } | { ok: false; error: LaunchError };

export type LaunchError = "unsupported_platform" | "write_failed" | "no_terminal";

/** Minimal child-process surface we depend on, so tests can inject a fake. */
interface SpawnedChild {
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "exit", cb: (code: number | null) => void): void;
}
type SpawnFn = (command: string, args: readonly string[]) => SpawnedChild;

/** Injection seams; production callers pass nothing and get the real deps. */
export interface LaunchDeps {
  platform?: NodeJS.Platform;
  dir?: string;
  safeMode?: () => Promise<boolean>;
  spawn?: SpawnFn;
  iTermInstalled?: () => Promise<boolean>;
  windowsTerminalAvailable?: () => Promise<boolean>;
  randomId?: () => string;
}

// ---------------------------------------------------------------------------
// Pure builders (heavily unit-tested)
// ---------------------------------------------------------------------------

/** Build the system-prompt context text written to the `.ctx` file. */
export function buildContext(page: PageContext): string {
  const lines: string[] = [
    "You were launched from the BrowserOps Chrome extension into the user's live Chrome session.",
    "The browserops MCP tools (browser_*) are available; use the /browserops skill for any browser action.",
    "",
    "When the user launched you, their active browser tab was:",
    `- URL: ${page.url || "(unknown)"}`,
  ];
  if (page.title) lines.push(`- Title: ${page.title}`);
  if (page.description) lines.push(`- Description: ${page.description}`);
  if (page.siteName) lines.push(`- Site: ${page.siteName}`);
  lines.push(
    "",
    "This page is background context only. The user will type their actual request next.",
    "Decide from their request whether it concerns this page: if so, operate on it with the " +
      "browser_* tools (call browser_list_tabs to find its tab_id); if not, ignore it.",
  );
  return lines.join("\n");
}

/** POSIX single-quote a string so it is safe to embed in a bash script. */
export function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quote a string (double any embedded single quotes). */
export function psSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export interface ScriptParams {
  ctxPath: string;
  scriptPath: string;
  /** The danger flag, or null in safe mode. */
  dangerFlag: string | null;
}

/** macOS / bash launcher. Reads the ctx file, self-deletes, execs claude. */
export function buildMacScript({ ctxPath, scriptPath, dangerFlag }: ScriptParams): string {
  const flag = dangerFlag ? `${dangerFlag} ` : "";
  return [
    "#!/bin/bash",
    'echo "BrowserOps -> launching Claude..."',
    `CTX="$(cat ${shSingleQuote(ctxPath)} 2>/dev/null)"`,
    `rm -f ${shSingleQuote(ctxPath)} ${shSingleQuote(scriptPath)}`,
    "if ! command -v claude >/dev/null 2>&1; then",
    '  echo "claude CLI not found on PATH. Install it, then relaunch."',
    '  read -r -p "Press Enter to close..."',
    "  exit 1",
    "fi",
    `exec claude ${flag}--append-system-prompt "$CTX"`,
    "",
  ].join("\n");
}

/** Windows / PowerShell launcher. Reads the ctx file, self-deletes, runs claude. */
export function buildWindowsScript({ ctxPath, scriptPath, dangerFlag }: ScriptParams): string {
  const flag = dangerFlag ? `${dangerFlag} ` : "";
  return [
    'Write-Host "BrowserOps -> launching Claude..."',
    `$ctx = Get-Content -Raw -Path ${psSingleQuote(ctxPath)}`,
    `Remove-Item -Force -Path ${psSingleQuote(ctxPath)}, ${psSingleQuote(scriptPath)}`,
    "if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {",
    '  Write-Host "claude CLI not found on PATH. Install it, then relaunch."',
    '  Read-Host "Press Enter to close"',
    "  exit 1",
    "}",
    `claude ${flag}--append-system-prompt $ctx`,
    "",
  ].join("\r\n");
}

/** Pick the terminal-opening command for a platform. Pure. */
export function terminalCommand(
  platform: NodeJS.Platform,
  scriptPath: string,
  opts: { iTerm?: boolean; windowsTerminal?: boolean },
): { cmd: string; args: string[] } | null {
  if (platform === "darwin") {
    return { cmd: "open", args: ["-a", opts.iTerm ? "iTerm" : "Terminal", scriptPath] };
  }
  if (platform === "win32") {
    return opts.windowsTerminal
      ? {
          cmd: "wt.exe",
          args: ["powershell", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        }
      : {
          cmd: "cmd.exe",
          args: [
            "/c",
            "start",
            "",
            "powershell.exe",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
          ],
        };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Default deps
// ---------------------------------------------------------------------------

function defaultRandomId(): string {
  return randomBytes(8).toString("hex");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function defaultITermInstalled(): Promise<boolean> {
  return (
    (await pathExists("/Applications/iTerm.app")) ||
    (await pathExists(join(homedir(), "Applications", "iTerm.app")))
  );
}

async function defaultWindowsTerminalAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    try {
      const child = spawn("where", ["wt.exe"]) as unknown as SpawnedChild;
      child.on("error", () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      });
      child.on("exit", (code) => {
        if (!settled) {
          settled = true;
          resolve(code === 0);
        }
      });
    } catch {
      resolve(false);
    }
  });
}

/** Spawn the opener and resolve to ok/err based on how it exits. */
function runOpener(
  spawnFn: SpawnFn,
  cmd: string,
  args: readonly string[],
): Promise<{ ok: boolean; detail?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { ok: boolean; detail?: string }): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const child = spawnFn(cmd, args);
      child.on("error", (err) => done({ ok: false, detail: err.message }));
      child.on("exit", (code) =>
        code === 0 || code === null
          ? done({ ok: true })
          : done({ ok: false, detail: `exit_${code}` }),
      );
    } catch (err) {
      done({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  });
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    /* ignore */
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function launchClaude(
  page: PageContext,
  logger: Logger,
  deps: LaunchDeps = {},
): Promise<LaunchResult> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") {
    await logger.write({ dir: "system", event: "launch_unsupported_platform", platform });
    return { ok: false, error: "unsupported_platform" };
  }

  const dir = deps.dir ?? launchDir();
  const safeMode = await (deps.safeMode ?? loadSafeMode)();
  const dangerFlag = safeMode ? null : "--dangerously-skip-permissions";
  const id = (deps.randomId ?? defaultRandomId)();
  const ctxPath = join(dir, `${id}.ctx`);
  const scriptPath = join(dir, platform === "darwin" ? `${id}.command` : `${id}.ps1`);

  const scriptBody =
    platform === "darwin"
      ? buildMacScript({ ctxPath, scriptPath, dangerFlag })
      : buildWindowsScript({ ctxPath, scriptPath, dangerFlag });

  const opener = terminalCommand(platform, scriptPath, {
    iTerm: platform === "darwin" && (await (deps.iTermInstalled ?? defaultITermInstalled)()),
    windowsTerminal:
      platform === "win32" &&
      (await (deps.windowsTerminalAvailable ?? defaultWindowsTerminalAvailable)()),
  });
  if (opener === null) {
    return { ok: false, error: "unsupported_platform" };
  }

  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(ctxPath, buildContext(page), { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(scriptPath, scriptBody, { encoding: "utf8", mode: 0o700 });
  } catch (err) {
    await logger.write({ dir: "system", event: "launch_write_failed", error: errMsg(err) });
    return { ok: false, error: "write_failed" };
  }

  const spawnFn = deps.spawn ?? (spawn as unknown as SpawnFn);
  const result = await runOpener(spawnFn, opener.cmd, opener.args);
  if (!result.ok) {
    await logger.write({
      dir: "system",
      event: "launch_opener_failed",
      opener: opener.cmd,
      detail: result.detail ?? "",
    });
    // The launcher script never ran, so it didn't self-delete. Clean up.
    await safeUnlink(ctxPath);
    await safeUnlink(scriptPath);
    return { ok: false, error: "no_terminal" };
  }

  await logger.write({ dir: "system", event: "launch_dispatched", platform, opener: opener.cmd });
  return { ok: true };
}
