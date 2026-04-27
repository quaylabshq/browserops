#!/usr/bin/env node
/**
 * `browserops` — CLI orchestrator on top of @browserops/bridge.
 *
 * Subcommands:
 *   init           first-run wizard (token, procedures, daemon, MCP-client install)
 *   start/stop/restart/status/logs      daemon lifecycle
 *   doctor         diagnose install
 *   upgrade        bump CLI + bridge + extension files, prompt to reload extension
 *   install-rules  per-project rules-slot installer (Cursor/Windsurf/Copilot)
 *
 * Top-level launchers (no subcommand):
 *   browserops --claude "task"   ensure-running + exec claude
 *   browserops --cursor "task"   ensure-running + exec cursor
 *   browserops --codex  "task"   ensure-running + exec codex
 */
import cac from "cac";
import { CLI_VERSION } from "./lib/version.js";
import { runInit } from "./commands/init.js";
import { runStart } from "./commands/start.js";
import { runStop } from "./commands/stop.js";
import { runRestart } from "./commands/restart.js";
import { runStatus } from "./commands/status.js";
import { runLogs } from "./commands/logs.js";
import { runDoctor } from "./commands/doctor.js";
import { runUpgrade } from "./commands/upgrade.js";
import { runInstallRules } from "./commands/install-rules.js";
import { runClaudeLauncher } from "./launchers/claude.js";
import { runCursorLauncher } from "./launchers/cursor.js";
import { runCodexLauncher } from "./launchers/codex.js";
import { err } from "./lib/ui.js";

const cli = cac("browserops");

cli
  .command("init", "First-run wizard: token, daemon, MCP-client install")
  .option("--yes", "Non-interactive: accept all defaults")
  .option("--no-mcp", "Skip MCP-client install")
  .option("--client <list>", "Comma-separated client list (claude,cursor,zed,continue,windsurf,codex)")
  .option("--dry-run", "Print what would change without writing")
  .action((opts) => runInit(opts));

cli
  .command("start", "Start the bridge daemon (no-op if already running)")
  .action(() => runStart());

cli
  .command("stop", "Stop the bridge daemon")
  .action(() => runStop());

cli
  .command("restart", "Restart the bridge daemon")
  .action(() => runRestart());

cli
  .command("status", "Show bridge daemon status")
  .action(() => runStatus());

cli
  .command("logs", "Tail the bridge log")
  .option("-f, --follow", "Follow new entries (like `tail -f`)")
  .option("-n, --lines <n>", "Number of past lines to show", { default: 50 })
  .action((opts) => runLogs(opts));

cli
  .command("doctor", "Diagnose install (Node, port, token, extension, client binaries)")
  .action(() => runDoctor());

cli
  .command("upgrade", "Upgrade browserops globally and refresh extension files")
  .option("--no-restart", "Skip restarting the daemon after upgrade")
  .action((opts) => runUpgrade(opts));

cli
  .command("install-rules", "Write per-project AGENTS.md rules slots (run inside a project)")
  .option("--client <list>", "Comma-separated: cursor,windsurf,copilot,continue,zed")
  .option("--dry-run", "Print what would change without writing")
  .action((opts) => runInstallRules(opts));

// Top-level launcher flags. cac surfaces these as --claude, --cursor, --codex
// on the root command (i.e. `browserops --claude "task"`).
cli
  .option("--claude <task>", "Ensure bridge running, then exec `claude` with this task")
  .option("--cursor <task>", "Ensure bridge running, then open Cursor with this task")
  .option("--codex <task>",  "Ensure bridge running, then exec `codex` with this task");

cli.help();
cli.version(CLI_VERSION);

async function main(): Promise<void> {
  const parsed = cli.parse(process.argv, { run: false });
  const opts = parsed.options as Record<string, unknown>;

  // Top-level launcher flags take precedence over the help screen but only
  // when there's no subcommand on the line.
  const sub = parsed.args[0];
  if (!sub) {
    if (typeof opts["claude"] === "string") {
      await runClaudeLauncher(opts["claude"] as string);
      return;
    }
    if (typeof opts["cursor"] === "string") {
      await runCursorLauncher(opts["cursor"] as string);
      return;
    }
    if (typeof opts["codex"] === "string") {
      await runCodexLauncher(opts["codex"] as string);
      return;
    }
  }

  // Otherwise: dispatch to subcommand action via cac.
  await cli.runMatchedCommand();
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
  err(`browserops: ${msg}`);
  process.exit(1);
});
