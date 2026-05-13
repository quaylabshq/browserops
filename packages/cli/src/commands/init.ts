import * as fs from "node:fs/promises";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import prompts from "prompts";
import { DEFAULT_WS_PORT, ENV } from "@browserops/shared";
import { ensureDaemonRunning, isDaemonAlive, resolveShimBin } from "../lib/daemon.js";
import { STATE_DIR, daemonLogPath } from "../lib/paths.js";
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
  setIdentityEmail,
  isValidEmail,
} from "../lib/config.js";
import { getCliTelemetry } from "../lib/telemetry.js";
import { installAllClaudeSkills } from "../installers/skill.js";
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

  await seedDefaultLauncher(opts.dryRun ?? false);
  await configureFeatures(opts);
  const emailProvided = await askForEmail(opts);
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

  getCliTelemetry()?.capture("cli.init_completed", {
    interactive: !opts.yes,
    email_provided: emailProvided,
  });
}

/**
 * Mid-flow email prompt. Skipped under --yes (non-interactive) and
 * --dry-run. Persists to ~/.browserops/config.json under identity.email
 * and fires $identify + $create_alias so the install becomes addressable
 * by email (for cross-machine merging and product follow-up).
 */
async function askForEmail(opts: InitOpts): Promise<boolean> {
  if (opts.yes || opts.dryRun) return false;

  const result = await prompts(
    {
      type: "text",
      name: "email",
      message: "Email (for product updates and issue follow-up — press Enter to skip)",
      validate: (v: string) =>
        v.trim().length === 0 || isValidEmail(v.trim()) || "doesn't look like an email",
    },
    { onCancel: () => process.exit(130) },
  );
  const raw = typeof result.email === "string" ? result.email.trim() : "";
  if (raw.length === 0) return false;

  await setIdentityEmail(raw);
  ok(`saved email: ${raw}  ${dim('(change with: browserops identify --email <new>)')}`);
  const t = getCliTelemetry();
  if (t) {
    t.identify(
      { email: raw, identified_via: "init", identified_at: new Date().toISOString() },
    );
    t.alias(raw);
    t.capture("cli.identify_set", { via: "init" });
  }
  return true;
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

  const { results, failed } = await installAllClaudeSkills({
    scope: "user",
    dryRun,
  });

  if (results.length === 0 && failed.length === 0) {
    warn("no bundled skills found — rebuild the CLI package (`pnpm -F browserops build`).");
    return;
  }

  for (const result of results) {
    if (result.changed) {
      const tail = result.backupPath ? ` ${dim(`(backup: ${result.backupPath})`)}` : "";
      ok(`Claude skill ${result.skillName}: ${result.message}${tail}`);
    } else {
      info(`Claude skill ${result.skillName}: ${result.message}`);
    }
  }
  for (const f of failed) {
    warn(`Claude skill ${f.skillName} install failed: ${f.error.message}`);
  }

  process.stdout.write(
    `  ${dim(`→ invoke in Claude Code via ${c.cyan("/browserops")}; run ${c.cyan("browserops install-skill --scope project")} to also install per-project.`)}\n`,
  );
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

const CHROME_WEB_STORE_URL =
  "https://chromewebstore.google.com/detail/browserops/fcjcldlmaoincljnghkbhhalnjfmbhnp";

function printNextSteps(port: number): void {
  const pair = readPairCodeFromLog();

  process.stdout.write("\n");
  header("Next steps");
  process.stdout.write(
    `  1. Install the browserops Chrome extension from the Chrome Web Store:\n     ${c.cyan(CHROME_WEB_STORE_URL)}\n`,
  );
  if (pair) {
    process.stdout.write(
      `  2. The onboarding tab opens automatically. Confirm pair code ${c.bold(pair)}.\n`,
    );
  } else {
    process.stdout.write(
      `  2. The onboarding tab opens automatically — click "Confirm & connect".\n`,
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

