import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMacScript, buildPrompt, buildSystemPrompt } from "./launch-agent.js";

// Real-shell E2E: run the generated .command against a FAKE claude that just
// records its argv. Proves the script execs claude with [danger,
// --append-system-prompt, <sys>, <visible prompt>] — where the visible prompt
// carries the page facts + the user instruction — and that page metadata /
// instruction are treated as DATA (a $(...) value reaches claude literally,
// never executed), and the script self-deletes.
const onDarwin = process.platform === "darwin" ? describe : describe.skip;

const EXEC_ARGS = '--dangerously-skip-permissions --append-system-prompt "$SYS"';

onDarwin("launch-agent bash launcher (real shell)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-e2e-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const evilTitle = (): string => "PWNED $(touch " + join(dir, "PWNED") + ") `id`";

  async function run(prompt: string): Promise<{ code: number; args: string[] }> {
    const sysPath = join(dir, "x.sys");
    const promptPath = join(dir, "x.prompt");
    const scriptPath = join(dir, "x.command");
    const argsOut = join(dir, "claude-args.txt");

    await fs.writeFile(sysPath, buildSystemPrompt(), "utf8");
    await fs.writeFile(promptPath, prompt, "utf8");
    await fs.writeFile(
      scriptPath,
      buildMacScript({ sysPath, promptPath, scriptPath, binary: "claude", execArgs: EXEC_ARGS }),
      { mode: 0o700 },
    );

    const binDir = join(dir, "bin");
    await fs.mkdir(binDir);
    // Fake claude: dump argv NUL-delimited so multi-line/space args stay intact.
    await fs.writeFile(join(binDir, "claude"), `#!/bin/bash\nprintf '%s\\0' "$@" > ${argsOut}\n`, {
      mode: 0o755,
    });

    const code = await new Promise<number>((resolve) => {
      const child = spawn("bash", [scriptPath], {
        stdio: "ignore",
        env: { ...process.env, PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
      });
      child.on("exit", (c) => resolve(c ?? -1));
    });
    let args: string[] = [];
    try {
      args = (await fs.readFile(argsOut, "utf8")).split("\0").slice(0, -1);
    } catch {
      /* claude not invoked */
    }
    return { code, args };
  }

  it("execs claude with [danger, --append-system-prompt, sys, visible prompt], no word-split", async () => {
    const prompt = buildPrompt(
      { url: "https://x.test", title: evilTitle() },
      "summarize $(whoami)",
    );
    const { code, args } = await run(prompt);
    expect(code).toBe(0);
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--append-system-prompt",
      buildSystemPrompt(),
      prompt,
    ]);
    // The visible prompt carries the page facts + instruction the user will see.
    expect(prompt).toContain("https://x.test");
    expect(prompt.endsWith("summarize $(whoami)")).toBe(true);
    // No substitution ran from the page title or the instruction.
    await expect(fs.access(join(dir, "PWNED"))).rejects.toThrow();
    await expect(fs.access(join(dir, "x.sys"))).rejects.toThrow(); // self-deleted
    await expect(fs.access(join(dir, "x.prompt"))).rejects.toThrow();
  });

  it("still passes a prompt of just page facts when there is no instruction", async () => {
    const prompt = buildPrompt({ url: "https://x.test", title: "Plain" });
    const { code, args } = await run(prompt);
    expect(code).toBe(0);
    expect(args).toHaveLength(4);
    expect(args[3]).toBe(prompt);
    expect(args[3]).toContain("Current page when I launched you:");
  });

  it("prints a staying error and exits 1 when claude is not on PATH", async () => {
    const sysPath = join(dir, "y.sys");
    const promptPath = join(dir, "y.prompt");
    const scriptPath = join(dir, "y.command");
    await fs.writeFile(sysPath, "sys", "utf8");
    await fs.writeFile(promptPath, "prompt", "utf8");
    await fs.writeFile(
      scriptPath,
      buildMacScript({ sysPath, promptPath, scriptPath, binary: "claude", execArgs: EXEC_ARGS }),
      { mode: 0o700 },
    );

    const code = await new Promise<number>((resolve) => {
      const child = spawn("bash", [scriptPath], {
        stdio: ["ignore", "ignore", "ignore"],
        env: { PATH: "/usr/bin:/bin" },
      });
      child.on("exit", (c) => resolve(c ?? -1));
    });
    expect(code).toBe(1);
  });
});
