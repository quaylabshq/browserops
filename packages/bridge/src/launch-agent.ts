/**
 * Spawn an interactive coding-agent session in a brand-new terminal window, on
 * request from the extension's side-panel launcher (via POST /launch).
 *
 * Why a new terminal at all: the daemon runs detached with `stdio: "ignore"`
 * and has no controlling TTY, so it cannot `stdio: "inherit"` the way the CLI
 * launcher (`packages/cli/src/launchers/claude.ts`) does. Instead it writes a
 * tiny launcher script + a context file + an instruction file under the 0700
 * state dir, then asks the OS to open a terminal that runs the script.
 *
 * Agent-agnostic: each agent has a small launch spec in AGENT_LAUNCHERS keyed
 * by the shared agent registry. Only enabled agents (currently just `claude`)
 * are launchable; others are refused with `agent_disabled`.
 *
 * Injection safety (the load-bearing invariant): page metadata AND the user's
 * typed instruction only ever cross into the shell as the *content of a file*
 * read into a variable (`cat` / `Get-Content -Raw`). They are NEVER
 * interpolated into the launcher script source or a command line. Only
 * repo-controlled values (our random temp paths, the agent binary name, fixed
 * flags) are interpolated. A page `<title>` or instruction of `$(rm -rf ~)` is
 * therefore inert.
 *
 * The agent binary is invoked by bare name *inside the new terminal*, which
 * inherits the user's interactive PATH — not the daemon's minimal one.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { type AgentId, isLaunchableAgent } from "@browserops/shared";
import { loadSafeMode } from "./config.js";
import { launchDir } from "./paths.js";
import type { Logger } from "./logger.js";

export interface PageContext {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
}

export interface LaunchRequest {
  /** Agent id from the wire; validated against the registry here. */
  agent: string;
  /** Optional first instruction the user typed in the composer. */
  instruction?: string;
  page: PageContext;
}

export type LaunchResult = { ok: true } | { ok: false; error: LaunchError };

export type LaunchError =
  | "agent_disabled"
  | "unsupported_platform"
  | "write_failed"
  | "no_terminal";

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
// Per-agent launch specs
// ---------------------------------------------------------------------------

/**
 * How to invoke a given agent's CLI. `macArgs`/`winArgs` return the argv
 * BETWEEN the binary and the optional instruction positional, as a shell
 * template that may reference the `$CTX` (bash) / `$ctx` (PowerShell) vars
 * the launcher script populates from the context file.
 */
interface AgentLauncher {
  binary: string;
  macArgs(opts: { safeMode: boolean }): string;
  winArgs(opts: { safeMode: boolean }): string;
}

const AGENT_LAUNCHERS: Partial<Record<AgentId, AgentLauncher>> = {
  claude: {
    binary: "claude",
    macArgs: ({ safeMode }) =>
      `${safeMode ? "" : "--dangerously-skip-permissions "}--append-system-prompt "$CTX"`,
    winArgs: ({ safeMode }) =>
      `${safeMode ? "" : "--dangerously-skip-permissions "}--append-system-prompt $ctx`,
  },
};

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
    "This page is background context only. The user's request follows (if any).",
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
  instrPath: string;
  scriptPath: string;
  binary: string;
  /** Agent argv between the binary and the optional instruction positional. */
  execArgs: string;
}

/** macOS / bash launcher. Reads ctx + instruction, self-deletes, execs the agent. */
export function buildMacScript({
  ctxPath,
  instrPath,
  scriptPath,
  binary,
  execArgs,
}: ScriptParams): string {
  return [
    "#!/bin/bash",
    `echo "BrowserOps -> launching ${binary}..."`,
    `CTX="$(cat ${shSingleQuote(ctxPath)} 2>/dev/null)"`,
    `INSTR="$(cat ${shSingleQuote(instrPath)} 2>/dev/null)"`,
    `rm -f ${shSingleQuote(ctxPath)} ${shSingleQuote(instrPath)} ${shSingleQuote(scriptPath)}`,
    `if ! command -v ${binary} >/dev/null 2>&1; then`,
    `  echo "${binary} CLI not found on PATH. Install it, then relaunch."`,
    '  read -r -p "Press Enter to close..."',
    "  exit 1",
    "fi",
    `if [ -n "$INSTR" ]; then`,
    `  exec ${binary} ${execArgs} "$INSTR"`,
    "else",
    `  exec ${binary} ${execArgs}`,
    "fi",
    "",
  ].join("\n");
}

/** Windows / PowerShell launcher. Reads ctx + instruction, self-deletes, runs the agent. */
export function buildWindowsScript({
  ctxPath,
  instrPath,
  scriptPath,
  binary,
  execArgs,
}: ScriptParams): string {
  return [
    `Write-Host "BrowserOps -> launching ${binary}..."`,
    `$ctx = Get-Content -Raw -Path ${psSingleQuote(ctxPath)}`,
    `$instr = Get-Content -Raw -Path ${psSingleQuote(instrPath)}`,
    `Remove-Item -Force -Path ${psSingleQuote(ctxPath)}, ${psSingleQuote(instrPath)}, ${psSingleQuote(scriptPath)}`,
    `if (-not (Get-Command ${binary} -ErrorAction SilentlyContinue)) {`,
    `  Write-Host "${binary} CLI not found on PATH. Install it, then relaunch."`,
    '  Read-Host "Press Enter to close"',
    "  exit 1",
    "}",
    "if (-not [string]::IsNullOrWhiteSpace($instr)) {",
    `  ${binary} ${execArgs} $instr`,
    "} else {",
    `  ${binary} ${execArgs}`,
    "}",
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

export async function launchAgent(
  req: LaunchRequest,
  logger: Logger,
  deps: LaunchDeps = {},
): Promise<LaunchResult> {
  const launcher = isLaunchableAgent(req.agent) ? AGENT_LAUNCHERS[req.agent] : undefined;
  if (launcher === undefined) {
    await logger.write({ dir: "system", event: "launch_agent_disabled", agent: req.agent });
    return { ok: false, error: "agent_disabled" };
  }

  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") {
    await logger.write({ dir: "system", event: "launch_unsupported_platform", platform });
    return { ok: false, error: "unsupported_platform" };
  }

  const dir = deps.dir ?? launchDir();
  const safeMode = await (deps.safeMode ?? loadSafeMode)();
  const id = (deps.randomId ?? defaultRandomId)();
  const ctxPath = join(dir, `${id}.ctx`);
  const instrPath = join(dir, `${id}.instr`);
  const scriptPath = join(dir, platform === "darwin" ? `${id}.command` : `${id}.ps1`);
  const execArgs =
    platform === "darwin" ? launcher.macArgs({ safeMode }) : launcher.winArgs({ safeMode });

  const scriptBody =
    platform === "darwin"
      ? buildMacScript({ ctxPath, instrPath, scriptPath, binary: launcher.binary, execArgs })
      : buildWindowsScript({ ctxPath, instrPath, scriptPath, binary: launcher.binary, execArgs });

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
    await fs.writeFile(ctxPath, buildContext(req.page), { encoding: "utf8", mode: 0o600 });
    await fs.writeFile(instrPath, req.instruction ?? "", { encoding: "utf8", mode: 0o600 });
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
    await safeUnlink(instrPath);
    await safeUnlink(scriptPath);
    return { ok: false, error: "no_terminal" };
  }

  await logger.write({
    dir: "system",
    event: "launch_dispatched",
    agent: req.agent,
    platform,
    opener: opener.cmd,
  });
  return { ok: true };
}
