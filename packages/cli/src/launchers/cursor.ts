import { spawnSync, spawn } from "node:child_process";
import { ensureDaemonRunning } from "../lib/daemon.js";
import { ok, info, c } from "../lib/ui.js";

const BIN = "cursor";

function resolveBin(name: string): string | null {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const bin = result.stdout.trim();
  return bin.length > 0 ? bin : null;
}

function tryClipboard(text: string): boolean {
  const platform = process.platform;
  let clipBin: string;
  let clipArgs: string[];

  if (platform === "darwin") {
    clipBin = "pbcopy";
    clipArgs = [];
  } else if (platform === "linux") {
    // prefer Wayland, fall back to X11
    const wl = resolveBin("wl-copy");
    if (wl) {
      clipBin = wl;
      clipArgs = [];
    } else {
      const xclip = resolveBin("xclip");
      if (!xclip) return false;
      clipBin = xclip;
      clipArgs = ["-selection", "clipboard"];
    }
  } else if (platform === "win32") {
    clipBin = "clip";
    clipArgs = [];
  } else {
    return false;
  }

  const result = spawnSync(clipBin, clipArgs, {
    input: text,
    encoding: "utf8",
  });
  return result.status === 0;
}

export async function runCursorLauncher(task: string): Promise<void> {
  const result = await ensureDaemonRunning({});
  if (result.alreadyRunning) {
    info("daemon already running");
  } else {
    ok(`daemon started — pid ${result.pid}`);
  }

  const prompt = `Use the /browserops skill. Task: ${task}`;

  const bin = resolveBin(BIN);
  if (!bin) {
    process.stdout.write(
      `\n${c.bold("Open Cursor manually and paste this prompt:")}\n\n  ${c.cyan(prompt)}\n\n`,
    );
    return;
  }

  // Launch Cursor in the current working directory (non-blocking).
  const child = spawn(bin, ["."], { stdio: "ignore", detached: true });
  child.unref();

  const copied = tryClipboard(prompt);

  process.stdout.write(
    `\n${c.bold("─────────────────────────────────────────────")}\n` +
      `${c.bold("Cursor is opening. Open its chat (Ctrl/Cmd+L) and paste:")}\n\n` +
      `  ${c.cyan(prompt)}\n\n` +
      (copied
        ? `${c.green("✓")} Copied to clipboard — just paste.\n`
        : `${c.yellow("!")} Could not copy automatically — paste the line above.\n`) +
      `${c.bold("─────────────────────────────────────────────")}\n\n`,
  );
}
