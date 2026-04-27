import * as fs from "node:fs/promises";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import prompts from "prompts";
import { DEFAULT_WS_PORT, ENV } from "@browserops/shared";
import { ensureBridgeRunning, isBridgeAlive } from "../lib/daemon.js";
import {
  STATE_DIR,
  bundledAssetsDir,
  daemonLogPath,
  extensionInstallDir,
} from "../lib/paths.js";
import { ok, info, warn, err, header, c, dim } from "../lib/ui.js";
import {
  detectClients,
  INSTALLERS,
  type ClientId,
  type ClientInfo,
} from "../installers/index.js";
import { readConfig, setConfigValue } from "../lib/config.js";
import { installClaudeSkill } from "../installers/skill.js";

export interface InitOpts {
  yes?: boolean;
  /** cac maps `--no-mcp` to `mcp: false`. */
  mcp?: boolean;
  /** cac maps `--no-skill` to `skill: false`. */
  skill?: boolean;
  client?: string;
  dryRun?: boolean;
}

const ALL_CLIENT_IDS: ClientId[] = [
  "claude-code",
  "cursor",
  "zed",
  "continue",
  "windsurf",
  "codex",
];

export async function runInit(opts: InitOpts = {}): Promise<void> {
  header("browserops init");

  await fs.mkdir(STATE_DIR, { recursive: true });
  ok(`state directory: ${STATE_DIR}`);

  const port = Number.parseInt(
    process.env[ENV.PORT] ?? String(DEFAULT_WS_PORT),
    10,
  );

  if (!opts.dryRun) {
    if (await isBridgeAlive()) {
      ok("bridge already running");
    } else {
      info("starting bridge daemon (mints token, seeds procedures)…");
      try {
        await ensureBridgeRunning({});
        ok(`bridge running on port ${port}`);
      } catch (e) {
        err(
          `bridge failed to start: ${e instanceof Error ? e.message : String(e)}`,
        );
        process.exit(1);
      }
    }
  } else {
    info("(dry-run) skipping bridge start");
  }

  await copyExtensionFiles(opts.dryRun ?? false);
  await seedDefaultLauncher(opts.dryRun ?? false);

  if (opts.mcp === false) {
    info("skipping MCP-client install (--no-mcp)");
  } else {
    await runMcpInstaller(opts);
  }

  if (opts.skill === false) {
    info("skipping Claude skill install (--no-skill)");
  } else {
    await runSkillInstaller(opts.dryRun ?? false);
  }

  printNextSteps(port);
}

async function runSkillInstaller(dryRun: boolean): Promise<void> {
  // Only Claude Code has a first-class skills directory today. Detect via the
  // claude-code installer's signal (claude on PATH) — if missing, skip silently
  // and rely on install-rules + the bridge MCP prompt for that client.
  const all = await detectClients();
  const claudeCode = all.find((c) => c.id === "claude-code");
  if (!claudeCode || !claudeCode.detected) {
    info(
      `skill install skipped — Claude Code not detected. Other clients pick up the skill via the bridge's ${c.cyan("/browserops")} MCP prompt or via ${c.cyan("browserops install-rules")}.`,
    );
    return;
  }

  try {
    const result = await installClaudeSkill({ scope: "user", dryRun });
    if (result.changed) {
      const tail = result.backupPath ? ` ${dim(`(backup: ${result.backupPath})`)}` : "";
      ok(`Claude skill: ${result.message}${tail}`);
    } else {
      info(`Claude skill: ${result.message}`);
    }
    process.stdout.write(
      `  ${dim(`→ invoke in Claude Code via ${c.cyan("/browserops")}; run ${c.cyan("browserops install-skill --scope project")} to also install per-project.`)}\n`,
    );
  } catch (e) {
    warn(`Claude skill install failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function seedDefaultLauncher(dryRun: boolean): Promise<void> {
  const cfg = await readConfig();
  if (cfg.default_launcher) {
    info(`default_launcher: ${cfg.default_launcher} (already set)`);
    return;
  }
  if (dryRun) {
    info("would set default_launcher = claude");
    return;
  }
  await setConfigValue("default_launcher", "claude");
  ok(`default_launcher: claude  ${dim('(change with: browserops config set default_launcher cursor)')}`);
}

// ---------------------------------------------------------------------------

async function copyExtensionFiles(dryRun: boolean): Promise<void> {
  const source = join(bundledAssetsDir(), "extension");
  const target = extensionInstallDir();
  if (!existsSync(source)) {
    warn(
      "extension files not bundled in this build — load packages/extension/dist/ from the repo, or rebuild",
    );
    return;
  }
  if (dryRun) {
    info(`would copy extension files to ${target}`);
    return;
  }
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true });
  ok(`extension files at ${target}`);
}

// ---------------------------------------------------------------------------

async function runMcpInstaller(opts: InitOpts): Promise<void> {
  const all = await detectClients();

  let chosen: ClientId[];
  if (opts.client) {
    chosen = parseClientList(opts.client, all);
  } else if (opts.yes) {
    chosen = all
      .filter((c) => c.detected && !c.alreadyInstalled)
      .map((c) => c.id);
    if (chosen.length === 0) {
      info("no detected clients need install");
      return;
    }
  } else {
    chosen = await promptForClients(all);
  }

  if (chosen.length === 0) {
    info("skipping MCP-client install");
    return;
  }

  const spec = { command: "browserops-bridge", args: [] as string[] };

  for (const id of chosen) {
    const inst = INSTALLERS[id];
    try {
      const result = await inst.install(spec, { dryRun: opts.dryRun });
      if (result.changed) {
        const tail = result.backupPath ? ` ${dim(`(backup: ${result.backupPath})`)}` : "";
        ok(`${inst.label}: ${result.message}${tail}`);
      } else {
        info(`${inst.label}: ${result.message}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      err(`${inst.label}: ${msg}`);
    }
  }
}

function parseClientList(raw: string, all: ClientInfo[]): ClientId[] {
  const known = new Set(ALL_CLIENT_IDS);
  const ids: ClientId[] = [];
  for (const tok of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!known.has(tok as ClientId)) {
      warn(`unknown client "${tok}" (valid: ${ALL_CLIENT_IDS.join(", ")})`);
      continue;
    }
    ids.push(tok as ClientId);
  }
  // Warn about unknown vs not-detected separately; --client is explicit so we
  // honour it even if the client isn't currently detected.
  for (const id of ids) {
    const meta = all.find((c) => c.id === id);
    if (meta && !meta.detected) info(`${meta.label}: not detected, installing anyway (--client)`);
  }
  return ids;
}

async function promptForClients(all: ClientInfo[]): Promise<ClientId[]> {
  process.stdout.write("\n");
  const choices = all.map((cl) => ({
    title: cl.label,
    description: describe(cl),
    value: cl.id,
    selected: cl.detected && !cl.alreadyInstalled,
    disabled: !cl.detected,
  }));

  const result = await prompts(
    {
      type: "multiselect",
      name: "ids",
      message: "Configure these MCP clients?",
      choices,
      hint: "space to toggle · return to confirm · esc to skip",
      instructions: false,
    },
    {
      onCancel: () => {
        info("install cancelled");
        process.exit(0);
      },
    },
  );

  return (result["ids"] as ClientId[] | undefined) ?? [];
}

function describe(cl: ClientInfo): string {
  if (!cl.detected) return "not detected";
  if (cl.alreadyInstalled) return `already installed → ${cl.configPath}`;
  return cl.configPath;
}

// ---------------------------------------------------------------------------

function printNextSteps(port: number): void {
  const ext = extensionInstallDir();
  const pair = readPairCodeFromLog();

  process.stdout.write("\n");
  header("Next steps");
  process.stdout.write(
    `  1. Open ${c.cyan("chrome://extensions")} and enable Developer mode (top-right).\n`,
  );
  process.stdout.write(
    `  2. Click "Load unpacked" and select:\n     ${c.bold(ext)}\n`,
  );
  if (pair) {
    process.stdout.write(
      `  3. The onboarding tab opens automatically. Confirm pair code ${c.bold(pair)}.\n`,
    );
  } else {
    process.stdout.write(
      `  3. The onboarding tab opens automatically — click "Confirm & connect".\n`,
    );
  }
  process.stdout.write("\n");
  process.stdout.write(
    `Then try: ${c.cyan(`browserops --claude "summarize my open tabs"`)}\n`,
  );
  process.stdout.write(
    `Bridge listening on ws://127.0.0.1:${port}. Logs: ${dim("~/.browserops/log.jsonl")}\n\n`,
  );

  copyToClipboardBestEffort(ext);
}

function readPairCodeFromLog(): string | undefined {
  // The bridge prints "pair code XXX-XXX" to its stderr right after binding;
  // our daemon spawn pipes stderr into ~/.browserops/daemon.log. Grep the tail.
  try {
    if (!existsSync(daemonLogPath())) return undefined;
    const fd = openSync(daemonLogPath(), "r");
    try {
      const stat = fstatSync(fd);
      const len = Math.min(stat.size, 16 * 1024);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, stat.size - len);
      const text = buf.toString("utf8");
      const matches = [...text.matchAll(/pair code (\d{3}-\d{3})/g)];
      const last = matches[matches.length - 1];
      return last ? last[1] : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function copyToClipboardBestEffort(text: string): void {
  const platform = process.platform;
  const tools: Array<[string, string[]]> =
    platform === "darwin"
      ? [["pbcopy", []]]
      : platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
          ];
  for (const [bin, args] of tools) {
    try {
      const child = spawn(bin, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => { /* ignore */ });
      child.stdin.write(text);
      child.stdin.end();
      info(`(extension path copied to clipboard via ${bin})`);
      return;
    } catch {
      // try next tool
    }
  }
}
