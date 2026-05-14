/**
 * `browserops sync [target]` — refresh installed assets in line with the
 * currently installed package version. Used after `npm i -g browserops@latest`
 * (and called from runUpgrade) so skills and MCP-client config snippets don't
 * drift away from what the CLI now ships.
 *
 * Targets:
 *   all        — skills + mcp (default)
 *   skills     — refresh ~/.claude/skills/<name>/SKILL.md for every bundled skill
 *   mcp        — re-run the per-client MCP installer; idempotent — installers
 *                report changed:false when the existing config already points at
 *                the resolved shim invocation.
 *
 * The Chrome extension is no longer bundled with the CLI — users install it
 * from the Chrome Web Store, so there's nothing for `sync` to refresh on disk.
 *
 * Per-project rules (.cursor/rules/browserops.mdc, .windsurfrules, etc.) are
 * intentionally NOT auto-synced. `runSync` may execute from any cwd; silently
 * editing rule files in a random project is surprising. The trailing hint
 * surfaces `browserops install-rules` as the explicit path.
 */
import { resolveShimBin } from "../lib/daemon.js";
import { c, dim, err, info, ok, warn } from "../lib/ui.js";
import {
  detectClients,
  INSTALLERS,
  type ClientId,
  type InstallResult,
} from "../installers/index.js";
import {
  installAllClaudeSkills,
  type SkillInstallResult,
} from "../installers/skill.js";

export const SYNC_TARGETS = ["all", "skills", "mcp"] as const;
export type SyncTarget = (typeof SYNC_TARGETS)[number];

export interface SyncOpts {
  /** Targets to refresh; defaults to ["all"]. */
  targets?: SyncTarget[];
  /** When true, skill drift detection is bypassed and overwrites are unconditional. */
  force?: boolean;
  /** When true, report what would change without writing. */
  dryRun?: boolean;
}

export interface SyncReport {
  skills?: { results: SkillInstallResult[]; failed: Array<{ skillName: string; error: Error }> };
  mcp?: Array<{ id: ClientId; result: InstallResult }>;
}

/**
 * Programmatic entry. Returns a structured report so other commands
 * (most notably runUpgrade) can adapt their output.
 */
export async function runSync(opts: SyncOpts = {}): Promise<SyncReport> {
  const targets = resolveTargets(opts.targets);
  const dryRun = opts.dryRun ?? false;
  const force = opts.force ?? false;

  const report: SyncReport = {};

  if (targets.has("skills")) {
    report.skills = await syncSkills({ force, dryRun });
  }
  if (targets.has("mcp")) {
    report.mcp = await syncMcpClients({ dryRun });
  }

  return report;
}

/**
 * CLI entry. Parses the optional [target] arg, runs the sync, and renders
 * one line per target plus the project-rules hint.
 */
export async function runSyncCommand(
  target: string | undefined,
  opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<void> {
  const requested = parseTargetArg(target);
  if (requested === null) {
    err(
      `unknown sync target "${target}". Expected one of: ${SYNC_TARGETS.join(", ")}.`,
    );
    process.exit(1);
  }

  const report = await runSync({
    targets: [requested],
    force: opts.force,
    dryRun: opts.dryRun,
  });

  printSkillReport(report.skills);
  printMcpReport(report.mcp);

  process.stdout.write(
    `\n${dim(`Per-project rules don't auto-sync — run ${c.cyan("browserops install-rules")} from inside a project to refresh those.`)}\n`,
  );

  // Surface a non-zero exit when any sub-step failed so CI can detect it.
  const skillFailed = (report.skills?.failed.length ?? 0) > 0;
  if (skillFailed) process.exit(1);
}

// ---------------------------------------------------------------------------
// syncSkills
// ---------------------------------------------------------------------------

async function syncSkills(opts: {
  force?: boolean;
  dryRun?: boolean;
}): Promise<NonNullable<SyncReport["skills"]>> {
  return await installAllClaudeSkills({
    scope: "user",
    force: opts.force,
    dryRun: opts.dryRun,
  });
}

// ---------------------------------------------------------------------------
// syncMcpClients
// ---------------------------------------------------------------------------

async function syncMcpClients(opts: {
  dryRun?: boolean;
}): Promise<NonNullable<SyncReport["mcp"]>> {
  const all = await detectClients();
  const targets = all.filter((cl) => cl.alreadyInstalled);
  if (targets.length === 0) return [];

  const invocation = resolveShimBin();
  const spec = { command: invocation.command, args: invocation.args };

  const out: NonNullable<SyncReport["mcp"]> = [];
  for (const cl of targets) {
    const installer = INSTALLERS[cl.id];
    try {
      // Each installer is already idempotent: install() rewrites only when the
      // saved command/args differ from `spec`. That is the drift check — no
      // extra comparison needed up here.
      const result = await installer.install(spec, { dryRun: opts.dryRun });
      out.push({ id: cl.id, result });
    } catch (e) {
      out.push({
        id: cl.id,
        result: {
          changed: false,
          configPath: cl.configPath,
          message: `install failed: ${e instanceof Error ? e.message : String(e)}`,
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

function printSkillReport(report: SyncReport["skills"]): void {
  if (!report) return;
  const { results, failed } = report;
  if (results.length === 0 && failed.length === 0) {
    warn("skills: no bundled skills found — rebuild the CLI package (`pnpm -F browserops build`)");
    return;
  }
  for (const r of results) {
    if (r.changed) {
      const tail = r.backupPath ? ` ${dim(`(backup: ${r.backupPath})`)}` : "";
      ok(`skill ${r.skillName}: ${r.message}${tail}`);
    } else {
      info(`skill ${r.skillName}: ${r.message}`);
    }
  }
  for (const f of failed) {
    warn(`skill ${f.skillName}: ${f.error.message}`);
  }
}

function printMcpReport(report: SyncReport["mcp"]): void {
  if (!report) return;
  if (report.length === 0) {
    info("mcp: no installed clients to refresh");
    return;
  }
  for (const { id, result } of report) {
    if (result.changed) {
      const tail = result.backupPath ? ` ${dim(`(backup: ${result.backupPath})`)}` : "";
      ok(`mcp ${id}: ${result.message}${tail}`);
    } else {
      info(`mcp ${id}: ${result.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTargets(targets: SyncTarget[] | undefined): Set<SyncTarget> {
  const list = targets && targets.length > 0 ? targets : (["all"] as SyncTarget[]);
  const out = new Set<SyncTarget>();
  for (const t of list) {
    if (t === "all") {
      out.add("skills");
      out.add("mcp");
    } else {
      out.add(t);
    }
  }
  return out;
}

function parseTargetArg(arg: string | undefined): SyncTarget | null {
  if (arg === undefined || arg === "") return "all";
  if ((SYNC_TARGETS as readonly string[]).includes(arg)) return arg as SyncTarget;
  return null;
}
