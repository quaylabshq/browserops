import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext, buildMacScript } from "./launch-agent.js";

// Real-shell E2E: run the generated .command against a FAKE claude that just
// records its argv. Proves the script execs claude with the danger flag, the
// exact context, AND the typed instruction as a separate quoted positional —
// and that page metadata / instruction are treated as DATA (a $(...) value
// reaches claude literally, never executed), and the script self-deletes.
const onDarwin = process.platform === "darwin" ? describe : describe.skip;

const EXEC_ARGS = '--dangerously-skip-permissions --append-system-prompt "$CTX"';

onDarwin("launch-agent bash launcher (real shell)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-e2e-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function run(instruction: string): Promise<{ code: number; args: string[] }> {
    const evilTitle = "PWNED $(touch " + join(dir, "PWNED") + ") `id`";
    const ctxPath = join(dir, "x.ctx");
    const instrPath = join(dir, "x.instr");
    const scriptPath = join(dir, "x.command");
    const argsOut = join(dir, "claude-args.txt");

    await fs.writeFile(ctxPath, buildContext({ url: "https://x.test", title: evilTitle }), "utf8");
    await fs.writeFile(instrPath, instruction, "utf8");
    await fs.writeFile(
      scriptPath,
      buildMacScript({ ctxPath, instrPath, scriptPath, binary: "claude", execArgs: EXEC_ARGS }),
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

  it("passes the instruction as a separate quoted positional after the context", async () => {
    const { code, args } = await run("summarize $(whoami) this page");
    expect(code).toBe(0);
    const ctx = buildContext({
      url: "https://x.test",
      title: "PWNED $(touch " + join(dir, "PWNED") + ") `id`",
    });
    // 4 args, none word-split: [danger, --append-system-prompt, <ctx>, <instruction>]
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--append-system-prompt",
      ctx,
      "summarize $(whoami) this page",
    ]);
    // No substitution ran from the page title or the instruction.
    await expect(fs.access(join(dir, "PWNED"))).rejects.toThrow();
    await expect(fs.access(join(dir, "x.ctx"))).rejects.toThrow(); // self-deleted
    await expect(fs.access(join(dir, "x.instr"))).rejects.toThrow();
  });

  it("omits the positional entirely when the instruction is empty", async () => {
    const { code, args } = await run("");
    expect(code).toBe(0);
    expect(args).toHaveLength(3); // no instruction positional
    expect(args[args.length - 1]).toContain("You were launched from the BrowserOps");
  });

  it("prints a staying error and exits 1 when claude is not on PATH", async () => {
    const ctxPath = join(dir, "y.ctx");
    const instrPath = join(dir, "y.instr");
    const scriptPath = join(dir, "y.command");
    await fs.writeFile(ctxPath, "ctx", "utf8");
    await fs.writeFile(instrPath, "", "utf8");
    await fs.writeFile(
      scriptPath,
      buildMacScript({ ctxPath, instrPath, scriptPath, binary: "claude", execArgs: EXEC_ARGS }),
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
