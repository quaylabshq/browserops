#!/usr/bin/env node
/**
 * `browserops` — CLI orchestrator on top of @browserops/bridge.
 *
 * Subcommands:
 *   init           first-run wizard (token, procedures, daemon, MCP-client install)
 *   start/stop/restart/status/logs      daemon lifecycle
 *   doctor         diagnose install
 *   upgrade        bump CLI + bridge globally and refresh installed assets
 *   install-rules  per-project rules-slot installer (Cursor/Windsurf/Copilot)
 *   config         get/set persisted preferences (e.g. default_launcher)
 *
 * Top-level launchers:
 *   browserops --claude "task"          force-route to claude
 *   browserops --cursor "task"          force-route to cursor
 *   browserops --codex  "task"          force-route to codex
 *   browserops "task"                   route via configured default_launcher
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
import { runInstallSkill } from "./commands/install-skill.js";
import { runConfig } from "./commands/config.js";
import { runFeature } from "./commands/feature.js";
import { runIdentify } from "./commands/identify.js";
import { runSyncCommand } from "./commands/sync.js";
import { runClaudeLauncher } from "./launchers/claude.js";
import { runCursorLauncher } from "./launchers/cursor.js";
import { runCodexLauncher } from "./launchers/codex.js";
import { dispatchLauncher } from "./launchers/dispatch.js";
import { getDefaultLauncher } from "./lib/config.js";
import { initCliTelemetry, getCliTelemetry } from "./lib/telemetry.js";
import { err, info, dim } from "./lib/ui.js";

const KNOWN_SUBCOMMANDS = new Set([
  "init",
  "start",
  "stop",
  "restart",
  "status",
  "logs",
  "doctor",
  "upgrade",
  "install-rules",
  "install-skill",
  "config",
  "feature",
  "sync",
  "identify",
]);

const cli = cac("browserops");

cli
  .command("init", "First-run wizard: token, daemon, MCP-client install, Claude skill")
  .option("--yes", "Non-interactive: accept all defaults")
  .option("--no-mcp", "Skip MCP-client install")
  .option("--no-skill", "Skip Claude skill install")
  .option("--client <list>", "Comma-separated client list (claude-code,cursor,zed,continue,windsurf,codex)")
  .option("--features <list>", "Comma-separated experimental features to enable (procedures,lore)")
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
  .command("doctor", "Diagnose install (Node, port, token, client binaries)")
  .action(() => runDoctor());

cli
  .command("upgrade", "Upgrade browserops globally and refresh skills + MCP-client config")
  .option("--no-restart", "Skip restarting the daemon after upgrade")
  .action((opts) => runUpgrade(opts));

cli
  .command("install-rules", "Write per-project AGENTS.md rules slots (run inside a project)")
  .option("--client <list>", "Comma-separated: cursor,windsurf,copilot,continue,codex,zed")
  .option("--dry-run", "Print what would change without writing")
  .action((opts) => runInstallRules(opts));

cli
  .command("install-skill", "Install canonical browserops skill into Claude Code's skills dir")
  .option("--scope <scope>", "user (~/.claude/skills/, default) or project (<cwd>/.claude/skills/)")
  .option("--force", "Overwrite without checking for drift")
  .option("--dry-run", "Print what would change without writing")
  .action((opts) => runInstallSkill(opts));

cli
  .command("config [action] [key] [value]", "Read/write persisted CLI config (~/.browserops/config.json)")
  .action((action: string | undefined, key: string | undefined, value: string | undefined) =>
    runConfig(action, key, value),
  );

cli
  .command(
    "feature [action] [name]",
    "List, enable, or disable gated experimental features (procedures, lore)",
  )
  .action((action: string | undefined, name: string | undefined) => runFeature(action, name));

cli
  .command(
    "sync [target]",
    "Refresh installed assets to match the bundled package (target: all, skills, mcp)",
  )
  .option("--force", "Skip drift detection on skills; overwrite unconditionally")
  .option("--dry-run", "Print what would change without writing")
  .action((target: string | undefined, opts: { force?: boolean; dryRun?: boolean }) =>
    runSyncCommand(target, opts),
  );

cli
  .command(
    "identify",
    "Set or clear the email associated with this install for product updates",
  )
  .option("--email <addr>", "Email to associate with this install")
  .option("--clear", "Remove the previously set email")
  .action((opts: { email?: string; clear?: boolean }) => runIdentify(opts));

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
  // Use the raw first arg (process.argv[2]) — once cac matches a subcommand
  // it strips the command name from parsed.args, so inspecting parsed.args[0]
  // would see the next positional ("set" / "get") instead.
  const rawFirst = process.argv[2];
  const isSubcommand = typeof rawFirst === "string" && KNOWN_SUBCOMMANDS.has(rawFirst);

  const startMs = Date.now();
  await initCliTelemetry(CLI_VERSION).catch(() => null);
  let exitCode = 0;
  /**
   * Map argv[2] (raw subcommand) → cli.* event name. Subcommands that
   * have richer events emitted from inside their handlers (init,
   * upgrade, feature enable/disable, identify, config set/unset) are
   * NOT in this map — recordSubcommand skips them so we don't
   * double-emit.
   */
  const SUBCOMMAND_EVENT_MAP: Record<string, string> = {
    start: "cli.start_invoked",
    stop: "cli.stop_invoked",
    restart: "cli.restart_invoked",
    status: "cli.status_checked",
    doctor: "cli.doctor_ran",
    logs: "cli.logs_tailed",
    sync: "cli.sync_ran",
    "install-rules": "cli.install_rules_ran",
    "install-skill": "cli.install_skill_ran",
  };
  const HANDLER_EMITTED = new Set([
    "init",
    "upgrade",
    "feature",
    "config",
    "identify",
  ]);

  const recordSubcommand = (): void => {
    const t = getCliTelemetry();
    if (!t) return;
    const props = { exit_code: exitCode, duration_ms: Date.now() - startMs };
    if (isSubcommand && SUBCOMMAND_EVENT_MAP[rawFirst!]) {
      t.capture(SUBCOMMAND_EVENT_MAP[rawFirst!]!, props);
    } else if (isSubcommand && HANDLER_EMITTED.has(rawFirst!)) {
      // The handler emits a richer event itself; nothing to do here.
    } else if (!isSubcommand) {
      // Launcher / help / unknown — handled outside this helper.
    }
  };
  const flushTelemetry = async (): Promise<void> => {
    try { await getCliTelemetry()?.flush(1500); } catch { /* swallow */ }
  };
  const recordLauncher = (launcherId: string): void => {
    getCliTelemetry()?.capture("cli.launcher_invoked", {
      launcher_id: launcherId,
      exit_code: exitCode,
      duration_ms: Date.now() - startMs,
    });
  };
  const recordHelp = (): void => {
    getCliTelemetry()?.capture("cli.help_shown", {
      exit_code: exitCode,
      duration_ms: Date.now() - startMs,
    });
  };

  // --claude/--cursor/--codex force-route, regardless of whether a positional
  // is also present. They take precedence over default-launcher routing.
  if (!isSubcommand) {
    if (typeof opts["claude"] === "string") {
      await runClaudeLauncher(opts["claude"] as string);
      recordLauncher("claude");
      await flushTelemetry();
      return;
    }
    if (typeof opts["cursor"] === "string") {
      await runCursorLauncher(opts["cursor"] as string);
      recordLauncher("cursor");
      await flushTelemetry();
      return;
    }
    if (typeof opts["codex"] === "string") {
      await runCodexLauncher(opts["codex"] as string);
      recordLauncher("codex");
      await flushTelemetry();
      return;
    }
  }

  if (isSubcommand) {
    await cli.runMatchedCommand();
    recordSubcommand();
    await flushTelemetry();
    return;
  }

  // No subcommand, no launcher flag: if the user passed positional text,
  // treat it as a task and route via the configured default launcher.
  const task = parsed.args.map(String).join(" ").trim();
  if (task) {
    const { id, configured } = await getDefaultLauncher();
    if (configured) {
      info(dim(`routing to ${id}`));
    } else {
      info(
        dim(
          `routing to ${id} (default — set with: browserops config set default_launcher cursor)`,
        ),
      );
    }
    await dispatchLauncher(id, task);
    recordLauncher(id);
    await flushTelemetry();
    return;
  }

  // Bare invocation: show help.
  cli.outputHelp();
  recordHelp();
  await flushTelemetry();
}

main().catch(async (e: unknown) => {
  const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
  err(`browserops: ${msg}`);
  try { await getCliTelemetry()?.flush(1000); } catch { /* swallow */ }
  process.exit(1);
});
