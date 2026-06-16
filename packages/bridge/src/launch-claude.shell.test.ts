import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContext, buildMacScript } from "./launch-claude.js";

// Real-shell E2E: run the generated .command against a FAKE claude that just
// records its argv. Proves (a) the script execs claude with the danger flag
// and the exact context, (b) the page metadata is treated as DATA (a $(...)
// title reaches claude literally, never executed), (c) the script self-deletes.
const onDarwin = process.platform === "darwin" ? describe : describe.skip;

onDarwin("launch-claude bash launcher (real shell)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-e2e-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("execs claude with the danger flag + exact context, never executing page metadata", async () => {
    const evilTitle = "PWNED $(touch " + join(dir, "PWNED") + ") `id`";
    const ctxPath = join(dir, "x.ctx");
    const scriptPath = join(dir, "x.command");
    const argsOut = join(dir, "claude-args.txt");

    const context = buildContext({ url: "https://x.test", title: evilTitle });
    await fs.writeFile(ctxPath, context, "utf8");
    await fs.writeFile(
      scriptPath,
      buildMacScript({ ctxPath, scriptPath, dangerFlag: "--dangerously-skip-permissions" }),
      { mode: 0o700 },
    );

    // Fake claude: dump argv NUL-delimited so multi-line/space args stay intact.
    const binDir = join(dir, "bin");
    await fs.mkdir(binDir);
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
    expect(code).toBe(0);

    const recorded = await fs.readFile(argsOut, "utf8");
    const args = recorded.split("\0").slice(0, -1); // drop trailing empty
    // Exactly 3 argv entries → the quoted "$CTX" was NOT word-split.
    expect(args).toEqual(["--dangerously-skip-permissions", "--append-system-prompt", context]);
    // The context carries the malicious title verbatim as data.
    expect(context).toContain(evilTitle);

    // The $(touch PWNED) substitution must NOT have run.
    await expect(fs.access(join(dir, "PWNED"))).rejects.toThrow();
    // The launcher self-deleted its ctx + script files.
    await expect(fs.access(ctxPath)).rejects.toThrow();
    await expect(fs.access(scriptPath)).rejects.toThrow();
  });

  it("prints a staying error and exits 1 when claude is not on PATH", async () => {
    const ctxPath = join(dir, "y.ctx");
    const scriptPath = join(dir, "y.command");
    await fs.writeFile(ctxPath, "ctx", "utf8");
    await fs.writeFile(scriptPath, buildMacScript({ ctxPath, scriptPath, dangerFlag: null }), {
      mode: 0o700,
    });

    const code = await new Promise<number>((resolve) => {
      // Empty PATH → claude not found. stdin from /dev/null so `read` returns.
      const child = spawn("bash", [scriptPath], {
        stdio: ["ignore", "ignore", "ignore"],
        env: { PATH: "/usr/bin:/bin" },
      });
      child.on("exit", (c) => resolve(c ?? -1));
    });
    expect(code).toBe(1);
  });
});
