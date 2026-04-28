import { spawnSync, spawn } from "node:child_process";
import { ensureDaemonRunning } from "../lib/daemon.js";
import { getSafeMode } from "../lib/config.js";
import { ok, info, err } from "../lib/ui.js";

const BIN = "claude";

function resolveBin(name: string): string | null {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const bin = result.stdout.trim();
  return bin.length > 0 ? bin : null;
}

export async function runClaudeLauncher(task: string): Promise<void> {
  const result = await ensureDaemonRunning({});
  if (result.alreadyRunning) {
    info("daemon already running");
  } else {
    ok(`daemon started — pid ${result.pid}`);
  }

  const bin = resolveBin(BIN);
  if (!bin) {
    err("claude not found on PATH");
    process.exit(1);
  }

  const prompt = `Use the /browserops skill. Task: ${task}`;
  const safeMode = await getSafeMode();
  const argv = safeMode ? [prompt] : ["--dangerously-skip-permissions", prompt];
  const child = spawn(bin, argv, { stdio: "inherit" });

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}
