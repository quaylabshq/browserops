import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { CLI_VERSION } from "../lib/version.js";
import { getCliTelemetry } from "../lib/telemetry.js";
import { c, dim, info, ok, warn } from "../lib/ui.js";
import { runRestart } from "./restart.js";
import { runSync } from "./sync.js";

export async function runUpgrade(opts: { restart?: boolean }): Promise<void> {
  const fromVersion = CLI_VERSION;
  const installMethod = await detectInstallMethod();

  if (installMethod === "npm" || installMethod === "pnpm") {
    info(`upgrading via ${installMethod}…`);
    try {
      const args = installMethod === "npm"
        ? ["install", "-g", "browserops@latest"]
        : ["add", "-g", "browserops@latest"];
      await runShell(installMethod, args);
      getCliTelemetry()?.capture("cli.upgrade_completed", {
        from_version: fromVersion,
        install_method: installMethod,
      });
    } catch (err) {
      getCliTelemetry()?.capture("cli.upgrade_failed", {
        from_version: fromVersion,
        install_method: installMethod,
        stage: "shell",
      });
      throw err;
    }
  } else {
    warn("could not detect npm/pnpm global install — please upgrade manually");
    warn("  npm install -g browserops@latest");
    warn("  pnpm add -g browserops@latest");
    getCliTelemetry()?.capture("cli.upgrade_failed", {
      from_version: fromVersion,
      install_method: "unknown",
      stage: "shell",
    });
  }

  // Refresh skills and any installed MCP-client config in one pass. Project
  // rules (.cursor/rules/, .windsurfrules, …) deliberately stay opt-in via
  // `browserops install-rules` — upgrade may run from any cwd.
  await runUpgradeSync();

  if (opts.restart !== false) {
    await runRestart();
  }
}

async function runUpgradeSync(): Promise<void> {
  const report = await runSync({ targets: ["skills", "mcp"] });

  for (const r of report.skills?.results ?? []) {
    if (r.changed) {
      const tail = r.backupPath ? ` ${dim(`(backup: ${r.backupPath})`)}` : "";
      ok(`skill ${r.skillName}: ${r.message}${tail}`);
    } else {
      info(`skill ${r.skillName}: ${r.message}`);
    }
  }
  for (const f of report.skills?.failed ?? []) {
    warn(`skill ${f.skillName}: ${f.error.message}`);
  }

  for (const { id, result } of report.mcp ?? []) {
    if (result.changed) {
      const tail = result.backupPath ? ` ${dim(`(backup: ${result.backupPath})`)}` : "";
      ok(`mcp ${id}: ${result.message}${tail}`);
    } else {
      info(`mcp ${id}: ${result.message}`);
    }
  }

  process.stdout.write(
    `\n${dim(`Per-project rules don't auto-sync — run ${c.cyan("browserops install-rules")} from inside a project to refresh those.`)}\n`,
  );
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

