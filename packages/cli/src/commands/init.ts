import * as fs from "node:fs/promises";
import prompts from "prompts";
import { DEFAULT_WS_PORT, ENV } from "@browserops/shared";
import { ensureDaemonRunning, isDaemonAlive, resolveShimBin } from "../lib/daemon.js";
import { STATE_DIR, extensionIdPath } from "../lib/paths.js";
import { ok, info, warn, err, header, c, dim } from "../lib/ui.js";
import { detectClients, INSTALLERS, type ClientId, type ClientInfo } from "../installers/index.js";
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
import { FEATURES, isFeatureName, type FeatureName } from "@browserops/shared";
import {
  CHROME_DOWNLOAD_URL,
  CHROME_WEB_STORE_URL,
  detectChrome,
  openInChrome,
} from "../lib/chrome.js";
import { waitForExtensionPair, fetchBridgeStatus } from "../lib/bridge-status.js";

const WELCOME_URL = "https://browserops.ai/welcome";

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
  /**
   * Clear the persisted extension_id pin before pairing, so a fresh
   * Chrome install / reinstalled extension can pair against a previously
   * configured bridge. Combined with `--skip-extension` is a no-op.
   */
  repair?: boolean;
  /**
   * Don't open the Chrome Web Store and don't wait for the extension
   * to pair. Used by CI, by re-runs that only want to rewrite MCP
   * client configs, and by the install script's BROWSEROPS_SKIP_INIT
   * fallback.
   */
  skipExtension?: boolean;
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

  // If stdin isn't a TTY we can't run interactive prompts. This is the
  // common `curl -fsSL https://browserops.ai/install | bash` shape: the
  // install script execs us with the curl *pipe* as stdin (the install.sh
  // tries to reconnect /dev/tty, but a missing/unreadable tty falls through
  // to here). Without this guard the feature multiselect auto-cancels and
  // askForEmail's onCancel calls process.exit(130) — killing init *before*
  // it opens Chrome to pair the extension. Coercing --yes routes every
  // prompt through its non-interactive default while still running the
  // extension-pairing step, so onboarding finishes instead of dying silently.
  if (!opts.yes && process.stdin.isTTY !== true) {
    warn(
      "non-interactive stdin — skipping prompts and using defaults. " +
        `Re-run ${c.cyan("browserops init")} in a terminal to choose features or set your email.`,
    );
    opts = { ...opts, yes: true };
  }

  await fs.mkdir(STATE_DIR, { recursive: true });
  ok(`state directory: ${STATE_DIR}`);

  // --repair: clear the persisted extension-ID pin before bridge boot
  // so the next /pair from a fresh extension is accepted instead of
  // refused with "extension_pinned".
  if (opts.repair && !opts.dryRun) {
    try {
      await fs.unlink(extensionIdPath());
      ok(`cleared pinned extension id (${extensionIdPath()})`);
    } catch (e) {
      // ENOENT = no pin existed; that's the normal first-run state.
      if (!(e instanceof Error) || (e as NodeJS.ErrnoException).code !== "ENOENT") {
        warn(`could not clear pinned extension id: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const port = Number.parseInt(process.env[ENV.PORT] ?? String(DEFAULT_WS_PORT), 10);

  if (!opts.dryRun) {
    if (await isDaemonAlive()) {
      ok("bridge already running");
    } else {
      info("starting bridge daemon (mints token, seeds procedures)…");
      try {
        await ensureDaemonRunning({});
        ok(`bridge running on port ${port}`);
      } catch (e) {
        err(`bridge failed to start: ${e instanceof Error ? e.message : String(e)}`);
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

  const extResult = await runExtensionPairing(opts, port);

  printNextSteps(port);

  getCliTelemetry()?.capture("cli.init_completed", {
    interactive: !opts.yes,
    email_provided: emailProvided,
    extension_paired: extResult === "paired",
    extension_skipped: extResult === "skipped",
    extension_timeout: extResult === "timeout",
  });
}

/**
 * Drive the post-config "install the Chrome extension and pair" step.
 *
 *   1. If --skip-extension or --dry-run: no-op.
 *   2. If the bridge already has a paired extension (`/status` reports
 *      extension_connected=true or a non-null extension_id): no-op —
 *      treat the install as already complete.
 *   3. Else: force-open Chrome at the Web Store listing, then poll
 *      `/status` for `extension_connected=true`. On success, open the
 *      welcome page. On timeout, print a fallback so the user can
 *      finish installing later.
 */
async function runExtensionPairing(
  opts: InitOpts,
  port: number,
): Promise<"paired" | "skipped" | "timeout" | "already" | "no_chrome"> {
  if (opts.skipExtension || opts.dryRun) {
    info("skipping Chrome extension pairing");
    return "skipped";
  }

  // Quick read of /status — if the extension is already paired we
  // don't need to bug the user with the Web Store tab.
  const initial = await fetchBridgeStatus(port);
  if (initial?.extension_connected) {
    ok(
      `extension already paired ${dim(`(${initial.extension_id ?? "id unknown"})`)} — opening welcome page.`,
    );
    openInChrome(WELCOME_URL);
    return "already";
  }

  const chrome = detectChrome();
  if (chrome === null) {
    warn("Google Chrome is not installed.");
    process.stdout.write(`    Install Chrome: ${c.cyan(CHROME_DOWNLOAD_URL)}\n`);
    process.stdout.write(`    Then re-run:    ${c.cyan("browserops init")}\n`);
    openInChrome(CHROME_DOWNLOAD_URL); // best-effort (will be a no-op here)
    return "no_chrome";
  }

  process.stdout.write("\n");
  header("Pair the Chrome extension");
  process.stdout.write(
    `  Opening the Chrome Web Store. Click ${c.bold("Add to Chrome")} when it loads —\n` +
      `  the extension auto-pairs with the bridge as soon as it installs.\n\n` +
      `  Web Store: ${c.cyan(CHROME_WEB_STORE_URL)}\n`,
  );
  const opened = openInChrome(CHROME_WEB_STORE_URL);
  if (!opened) {
    warn("Couldn't auto-open Chrome. Paste the URL above into a Chrome tab manually.");
  }

  const start = Date.now();
  let lastTickPrintedAt = 0;
  const result = await waitForExtensionPair({
    port,
    timeoutMs: 5 * 60_000,
    intervalMs: 750,
    onPairConsumed: () => {
      process.stdout.write(
        `  ${c.cyan("→")} extension picked up the token; finishing handshake…\n`,
      );
    },
    onTick: (elapsedMs) => {
      // Print a heartbeat every ~10s so the user knows it's alive but
      // we don't spam the terminal.
      if (elapsedMs - lastTickPrintedAt < 10_000) return;
      lastTickPrintedAt = elapsedMs;
      const sec = Math.floor(elapsedMs / 1000);
      process.stdout.write(`  ${dim(`waiting for extension… (${sec}s)`)}\n`);
    },
  });

  if (result.ok) {
    const sec = Math.floor((Date.now() - start) / 1000);
    ok(
      `extension paired ${dim(`(${result.status.extension_id ?? "id unknown"}, ${sec}s)`)} — opening welcome page.`,
    );
    openInChrome(WELCOME_URL);
    return "paired";
  }

  // Pair didn't complete in time. Don't fail the whole init — the bridge
  // is still running and the next time the user opens the extension it
  // will auto-pair. Print a fallback so they know what to do.
  if (result.reason === "timeout") {
    warn("Timed out waiting for the extension to pair.");
  } else {
    warn("Lost contact with the bridge while waiting for the extension.");
  }
  process.stdout.write(
    `    1. Install the extension if you haven't:\n` +
      `       ${c.cyan(CHROME_WEB_STORE_URL)}\n` +
      `    2. The extension auto-pairs on install — no further action needed.\n` +
      `    3. If it still won't pair, run: ${c.cyan("browserops init --repair")}\n`,
  );
  return "timeout";
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
  ok(`saved email: ${raw}  ${dim("(change with: browserops identify --email <new>)")}`);
  const t = getCliTelemetry();
  if (t) {
    t.identify({ email: raw, identified_via: "init", identified_at: new Date().toISOString() });
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
  ok(
    `default_launcher: claude  ${dim("(change with: browserops config set default_launcher codex)")}`,
  );
}

function printSafeModePolicy(): void {
  process.stdout.write(
    `\n${c.bold("Safe mode")} ${dim("(off by default)")}\n` +
      `  browserops invokes ${c.cyan("claude --dangerously-skip-permissions")} and ${c.cyan("codex exec --full-auto")}\n` +
      `  so the agent runs without per-action approval prompts. Browser-side risky\n` +
      `  actions (executing JS, sensitive domains, procedures marked ${c.cyan("risky")}) are\n` +
      `  still gated by browserops' own approval system, regardless of safe mode.\n\n` +
      `  Turn it on:  ${c.cyan("browserops config set safe_mode true")}\n` +
      `  ${dim('Cursor has no CLI flag for this — set Settings → Agent → Auto-Run to "Allow".')}\n\n`,
  );
}

// ---------------------------------------------------------------------------

async function runMcpInstaller(opts: InitOpts): Promise<void> {
  const all = await detectClients();

  let chosen: ClientId[];
  if (opts.client) {
    chosen = parseClientList(opts.client, all);
  } else if (opts.yes) {
    chosen = all.filter((c) => c.detected && !c.alreadyInstalled).map((c) => c.id);
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
  for (const tok of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
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
    ((result["ids"] as string[] | undefined) ?? []).filter(isFeatureName),
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
  for (const tok of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (isFeatureName(tok)) out.add(tok);
    else warn(`unknown feature "${tok}" (valid: ${FEATURES.join(", ")})`);
  }
  return out;
}

// ---------------------------------------------------------------------------

function printNextSteps(port: number): void {
  process.stdout.write("\n");
  header("Next steps");
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
