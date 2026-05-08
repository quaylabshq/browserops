import * as fs from "node:fs/promises";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import prompts from "prompts";
import { DEFAULT_WS_PORT, ENV } from "@browserops/shared";
import { ensureDaemonRunning, isDaemonAlive, resolveShimBin } from "../lib/daemon.js";
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
import {
  readConfig,
  setConfigValue,
  applyFeaturePartial,
  getFeatureStates,
} from "../lib/config.js";
import { installClaudeSkill } from "../installers/skill.js";
import {
  FEATURES,
  FEATURE_METADATA,
  isFeatureName,
  type FeatureName,
} from "@browserops/shared";

export interface InitOpts {
  yes?: boolean;
  /** cac maps `--no-mcp` to `mcp: false`. */
  mcp?: boolean;
  /** cac maps `--no-skill` to `skill: false`. */
  skill?: boolean;
  client?: string;
  dryRun?: boolean;
  /** Comma-separated feature names to enable non-interactively. */
  features?: string;
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
    if (await isDaemonAlive()) {
      ok("bridge already running");
    } else {
      info("starting bridge daemon (mints token, seeds procedures)…");
      try {
        await ensureDaemonRunning({});
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
  await configureFeatures(opts);
  printSafeModePolicy();

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
  ok(`default_launcher: claude  ${dim('(change with: browserops config set default_launcher codex)')}`);
}

function printSafeModePolicy(): void {
  process.stdout.write(
    `\n${c.bold("Safe mode")} ${dim("(off by default)")}\n` +
    `  browserops invokes ${c.cyan("claude --dangerously-skip-permissions")} and ${c.cyan("codex exec --full-auto")}\n` +
    `  so the agent runs without per-action approval prompts. Browser-side risky\n` +
    `  actions (executing JS, sensitive domains, procedures marked ${c.cyan("risky")}) are\n` +
    `  still gated by browserops' own approval system, regardless of safe mode.\n\n` +
    `  Turn it on:  ${c.cyan("browserops config set safe_mode true")}\n` +
    `  ${dim("Cursor has no CLI flag for this — set Settings → Agent → Auto-Run to \"Allow\".")}\n\n`,
  );
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

  // Resolve the shim to an absolute `node <bridge-dist>/shim.js` invocation
  // when possible. Bare `browserops-shim` only works if the binary is on
  // $PATH, but a global `npm i -g browserops` does NOT expose the transitive
  // `@browserops/bridge` bin — only the top-level package's bins get linked.
  // Writing the resolved path makes the MCP entry work without further setup.
  const invocation = resolveShimBin();
  if (invocation.command === "browserops-shim") {
    warn(
      "could not resolve @browserops/bridge — writing bare `browserops-shim`. " +
      "If your MCP client cannot find it, install browserops globally or pass --client.",
    );
  }
  const spec = { command: invocation.command, args: invocation.args };

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
// Feature configuration — `procedures` defaults OFF and is surfaced as an
// opt-in prompt. --features=procedures forces non-interactive enable;
// --yes accepts the default (no features enabled).
// ---------------------------------------------------------------------------

async function configureFeatures(opts: InitOpts): Promise<void> {
  // Explicit --features list wins over interactive prompts.
  if (opts.features !== undefined) {
    const explicit = parseFeatureList(opts.features);
    const partial: Partial<Record<FeatureName, boolean>> = {};
    for (const name of FEATURES) partial[name] = explicit.has(name);
    const { changed } = await applyFeaturePartial(partial);
    if (changed) {
      const enabledList = [...explicit].join(", ") || "(none)";
      ok(`features: ${enabledList}`);
    } else {
      info(`features: unchanged`);
    }
    return;
  }

  if (opts.yes) {
    info(
      `features: keeping defaults (off). Enable later with ${c.cyan("browserops feature enable <name>")}.`,
    );
    return;
  }

  process.stdout.write("\n");
  process.stdout.write(c.bold("Optional experimental features\n"));
  process.stdout.write(
    `  ${dim("Both ship off by default — opt in only if you need them. You can flip these any time with `browserops feature enable/disable <name>`.")}\n`,
  );

  const states = await getFeatureStates();
  const choices = states.map((s) => ({
    title: `${s.name} ${dim("— " + s.description)}`,
    value: s.name,
    selected: s.enabled,
  }));

  const result = await prompts(
    {
      type: "multiselect",
      name: "ids",
      message: "Enable any?",
      choices,
      hint: "space to toggle · return to confirm",
      instructions: false,
    },
    {
      onCancel: () => {
        info("feature setup cancelled — keeping current state");
      },
    },
  );

  const chosen = new Set<FeatureName>(
    (result["ids"] as string[] | undefined ?? []).filter(isFeatureName),
  );
  const partial: Partial<Record<FeatureName, boolean>> = {};
  for (const name of FEATURES) partial[name] = chosen.has(name);
  await applyFeaturePartial(partial);
  if (chosen.size === 0) {
    info(`features: none enabled (default)`);
  } else {
    ok(`features: ${[...chosen].join(", ")}`);
  }
}

function parseFeatureList(raw: string): Set<FeatureName> {
  const out = new Set<FeatureName>();
  for (const tok of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (isFeatureName(tok)) out.add(tok);
    else warn(`unknown feature "${tok}" (valid: ${FEATURES.join(", ")})`);
  }
  return out;
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
    `Try first:    ${c.cyan(`browserops "open hacker news and read me the top story"`)}\n`,
  );
  process.stdout.write(
    `Then this:    ${c.cyan(`browserops "check my gmail and summarize my last 3 emails"`)}\n`,
  );
  process.stdout.write(
    `\nBridge listening on ws://127.0.0.1:${port}. Logs: ${dim("~/.browserops/log.jsonl")}\n\n`,
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
