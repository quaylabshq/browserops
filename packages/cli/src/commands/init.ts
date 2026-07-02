import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_WS_PORT, ENV } from "@browserops/shared";
import { ensureDaemonRunning, isDaemonAlive, resolveShimBin } from "../lib/daemon.js";
import { STATE_DIR } from "../lib/paths.js";
import { clearPinnedExtensionId } from "../lib/pin.js";
import { ok, warn, err, arrow, wait, c } from "../lib/ui.js";
import { detectClients, INSTALLERS, type ClientId, type ClientInfo } from "../installers/index.js";
import {
  readConfig,
  setConfigValue,
  applyFeaturePartial,
  getEnabledFeatureSet,
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
const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 10;

export interface InitOpts {
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
  if (!checkNodeVersion()) {
    process.exit(1);
  }
  ok(`Node ${MIN_NODE_MAJOR} detected`);

  if (opts.repair && !opts.dryRun) {
    try {
      await clearPinnedExtensionId();
    } catch (e) {
      warn(`could not clear pinned extension id: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await fs.mkdir(STATE_DIR, { recursive: true });
  await seedDefaultLauncher(opts.dryRun ?? false);
  await applyExplicitFeatures(opts);
  ok("Installed browserops");

  if (opts.mcp !== false) {
    await runMcpInstaller(opts);
  }

  if (opts.skill !== false) {
    await runSkillInstaller(opts.dryRun ?? false);
  }

  await printLoreReady();

  const port = Number.parseInt(process.env[ENV.PORT] ?? String(DEFAULT_WS_PORT), 10);
  if (!opts.dryRun) {
    if (!(await isDaemonAlive())) {
      try {
        await ensureDaemonRunning({});
      } catch (e) {
        err(`bridge failed to start: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
    }
    ok(`Bridge running on :${port}`);
  }

  const extResult = await runExtensionPairing(opts, port);

  ok("Done. Pin a tab and start.");

  getCliTelemetry()?.capture("cli.init_completed", {
    interactive: false,
    email_provided: false,
    extension_paired: extResult === "paired",
    extension_skipped: extResult === "skipped",
    extension_timeout: extResult === "timeout",
  });
}

function checkNodeVersion(): boolean {
  const [majStr = "0", minStr = "0"] = process.versions.node.split(".");
  const maj = Number.parseInt(majStr, 10);
  const min = Number.parseInt(minStr, 10);
  if (maj > MIN_NODE_MAJOR) return true;
  if (maj === MIN_NODE_MAJOR && min >= MIN_NODE_MINOR) return true;
  err(
    `Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ required — detected ${process.versions.node}. Upgrade Node and re-run.`,
  );
  return false;
}

/**
 * Drive the post-config "install the Chrome extension and pair" step.
 *
 *   1. If --skip-extension or --dry-run: no-op.
 *   2. If the bridge already has a paired extension: no-op —
 *      treat the install as already complete.
 *   3. Else: open Chrome at the Web Store listing, then poll
 *      `/status` for `extension_connected=true`. On success, open the
 *      welcome page. On timeout, warn with a repair hint.
 */
async function runExtensionPairing(
  opts: InitOpts,
  port: number,
): Promise<"paired" | "skipped" | "timeout" | "already" | "no_chrome"> {
  if (opts.skipExtension || opts.dryRun) {
    return "skipped";
  }

  const initial = await fetchBridgeStatus(port);
  if (initial?.extension_connected) {
    openInChrome(WELCOME_URL);
    return "already";
  }

  const chrome = detectChrome();
  if (chrome === null) {
    warn("Google Chrome is not installed.");
    process.stdout.write(`    Install Chrome: ${c.cyan(CHROME_DOWNLOAD_URL)}\n`);
    process.stdout.write(`    Then re-run:    ${c.cyan("browserops init")}\n`);
    return "no_chrome";
  }

  arrow("Opening Chrome Web Store…");
  const opened = openInChrome(CHROME_WEB_STORE_URL);
  if (!opened) {
    warn("Couldn't auto-open Chrome. Paste this URL into a Chrome tab:");
    process.stdout.write(`    ${c.cyan(CHROME_WEB_STORE_URL)}\n`);
  }

  process.stdout.write("\n");
  wait("Waiting for extension…");

  const result = await waitForExtensionPair({
    port,
    timeoutMs: 5 * 60_000,
    intervalMs: 750,
  });

  if (result.ok) {
    ok("Extension paired");
    openInChrome(WELCOME_URL);
    return "paired";
  }

  // Pair didn't complete in time. Don't fail init — the bridge is still
  // running and the next time the user opens the extension it will
  // auto-pair. Print a fallback so they know what to do.
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

async function runSkillInstaller(dryRun: boolean): Promise<void> {
  // Only Claude Code has a first-class skills directory today. Detect via the
  // claude-code installer's signal (claude on PATH) — if missing, skip silently
  // and rely on install-rules + the bridge MCP prompt for that client.
  const all = await detectClients();
  const claudeCode = all.find((c) => c.id === "claude-code");
  if (!claudeCode || !claudeCode.detected) return;

  const { failed } = await installAllClaudeSkills({ scope: "user", dryRun });
  for (const f of failed) {
    warn(`Claude skill ${f.skillName} install failed: ${f.error.message}`);
  }
}

async function seedDefaultLauncher(dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const cfg = await readConfig();
  if (cfg.default_launcher) return;
  await setConfigValue("default_launcher", "claude");
}

async function applyExplicitFeatures(opts: InitOpts): Promise<void> {
  // Only used when a user explicitly passes --features. Otherwise defaults
  // in FEATURE_METADATA are authoritative (lore on, procedures off).
  if (opts.features === undefined) return;
  const explicit = parseFeatureList(opts.features);
  const partial: Partial<Record<FeatureName, boolean>> = {};
  for (const name of FEATURES) partial[name] = explicit.has(name);
  await applyFeaturePartial(partial);
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

async function printLoreReady(): Promise<void> {
  const enabled = await getEnabledFeatureSet();
  if (!enabled.has("lore")) return;
  const dir = process.env["BROWSEROPS_LORE_DIR"] ?? path.join(os.homedir(), "browserops", "lore");
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  let count = 0;
  try {
    const entries = await fs.readdir(dir);
    count = entries.filter((n) => n.endsWith(".md")).length;
  } catch {
    count = 0;
  }
  const label = "Lore ready".padEnd(24);
  ok(`${label}(${count} ${count === 1 ? "entry" : "entries"})`);
}

// ---------------------------------------------------------------------------

async function runMcpInstaller(opts: InitOpts): Promise<void> {
  const all = await detectClients();

  const chosen: ClientId[] = opts.client
    ? parseClientList(opts.client, all)
    : all.filter((c) => c.detected && !c.alreadyInstalled).map((c) => c.id);

  if (chosen.length === 0) return;

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

  const configuredLabels: string[] = [];
  for (const id of chosen) {
    const inst = INSTALLERS[id];
    try {
      await inst.install(spec, { dryRun: opts.dryRun });
      configuredLabels.push(inst.label);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      err(`${inst.label}: ${msg}`);
    }
  }

  if (configuredLabels.length > 0) {
    ok(`Configured ${configuredLabels.join(", ")}`);
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
  // --client is explicit so we honour it even if the client isn't currently
  // detected. `all` is only used for validation of known ids above.
  void all;
  return ids;
}
