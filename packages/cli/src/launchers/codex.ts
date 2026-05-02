import { spawnSync, spawn } from "node:child_process";
import { ensureBridgeRunning } from "../lib/daemon.js";
import { getSafeMode } from "../lib/config.js";
import { ok, info, err } from "../lib/ui.js";

const BIN = "codex";

function resolveBin(name: string): string | null {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const bin = result.stdout.trim();
  return bin.length > 0 ? bin : null;
}

export async function runCodexLauncher(task: string): Promise<void> {
  const result = await ensureBridgeRunning({});
  if (result.alreadyRunning) {
    info("bridge already running");
  } else {
    ok(`bridge started — pid ${result.pid}`);
  }

  const bin = resolveBin(BIN);
  if (!bin) {
    err("codex not found on PATH");
    process.exit(1);
  }

  const prompt = `Use the /browserops skill. Task: ${task}`;
  const safeMode = await getSafeMode();
  // `codex exec` is the non-interactive one-shot form. --full-auto skips
  // approval prompts but keeps the codex sandbox on; browser actions tunnel
  // through the bridge WebSocket and aren't affected by the sandbox.
  const argv = safeMode ? ["exec", prompt] : ["exec", "--full-auto", prompt];
  const child = spawn(bin, argv, { stdio: "inherit" });

  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}
