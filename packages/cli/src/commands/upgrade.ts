import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { bundledAssetsDir, extensionInstallDir, STATE_DIR } from "../lib/paths.js";
import { ok, info, err, warn } from "../lib/ui.js";
import { runRestart } from "./restart.js";

export async function runUpgrade(opts: { restart?: boolean }): Promise<void> {
  const installMethod = await detectInstallMethod();

  if (installMethod === "npm") {
    info("upgrading via npm…");
    await runShell("npm", ["install", "-g", "browserops@latest"]);
  } else if (installMethod === "pnpm") {
    info("upgrading via pnpm…");
    await runShell("pnpm", ["add", "-g", "browserops@latest"]);
  } else {
    warn("could not detect npm/pnpm global install — please upgrade manually");
    warn("  npm install -g browserops@latest");
    warn("  pnpm add -g browserops@latest");
  }

  await refreshExtensionFiles();

  if (opts.restart !== false) {
    await runRestart();
  }
}

async function detectInstallMethod(): Promise<"npm" | "pnpm" | null> {
  const npmRoot = await getCommandOutput("npm", ["root", "-g"]);
  if (npmRoot && existsSync(join(npmRoot, "browserops", "package.json"))) {
    return "npm";
  }

  const pnpmRoot = await getCommandOutput("pnpm", ["root", "-g"]);
  if (pnpmRoot && existsSync(join(pnpmRoot, "browserops", "package.json"))) {
    return "pnpm";
  }

  return null;
}

function getCommandOutput(cmd: string, args: string[]): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile(cmd, args, (error, stdout) => {
      if (error) {
        resolve(null);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function runShell(cmd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

async function refreshExtensionFiles(): Promise<void> {
  const src = join(bundledAssetsDir(), "extension");
  const dest = extensionInstallDir();

  try {
    await fs.access(src);
  } catch {
    warn("bundled extension directory not found — skipping file refresh");
    return;
  }

  await fs.mkdir(dest, { recursive: true });
  await copyDir(src, dest);
  ok(`extension files refreshed at ${dest} — reload it in chrome://extensions`);
}

async function copyDir(src: string, dest: string): Promise<void> {
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(destPath, { recursive: true });
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
