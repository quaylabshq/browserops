import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicWrite, backup } from "../lib/fs.js";
import { bundledAssetsDir } from "../lib/paths.js";

export type SkillScope = "user" | "project";

export interface SkillInstallOpts {
  scope: SkillScope;
  /** When set, overwrite without checking content drift. */
  force?: boolean;
  dryRun?: boolean;
  /** Override target dir (project scope) — defaults to process.cwd(). */
  cwd?: string;
  /**
   * Skill name to install. Defaults to "browserops" so existing callers stay
   * one-skill-aware; multi-skill callers should iterate via
   * discoverBundledSkills() and pass each name.
   */
  skillName?: string;
}

export interface SkillInstallResult {
  /** Skill name that was installed (e.g. "browserops", "browserops-teach"). */
  skillName: string;
  changed: boolean;
  /** Where the skill was (or would be) written. */
  targetPath: string;
  /** Path of the .bak file if drift was overwritten. */
  backupPath?: string;
  message: string;
}

const SKILLS_ASSET_SUBDIR = "skills";

/**
 * Bundled skill: <cli-pkg>/dist/assets/skills/<skillName>/SKILL.md.
 * Resolved at runtime via bundledAssetsDir().
 */
function bundledSkillPath(skillName: string): string {
  return resolve(bundledAssetsDir(), SKILLS_ASSET_SUBDIR, skillName, "SKILL.md");
}

function targetDir(scope: SkillScope, cwd: string, skillName: string): string {
  if (scope === "user") {
    return join(homedir(), ".claude", "skills", skillName);
  }
  return join(cwd, ".claude", "skills", skillName);
}

function targetSkillPath(scope: SkillScope, cwd: string, skillName: string): string {
  return join(targetDir(scope, cwd, skillName), "SKILL.md");
}

/**
 * Enumerate every skill bundled into the CLI package at build time.
 * Returns an empty array when the assets dir is missing (e.g. running from
 * source via tsx with no prior build). Used by the upgrade/sync paths to
 * refresh every shipped skill without naming them individually.
 */
export async function discoverBundledSkills(): Promise<string[]> {
  const root = resolve(bundledAssetsDir(), SKILLS_ASSET_SUBDIR);
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && existsSync(resolve(root, e.name, "SKILL.md")))
    .map((e) => e.name)
    .sort();
}

/**
 * Install (or refresh) one Claude skill into a Claude Code skills directory.
 * Idempotent — same content → no-op. Drift → atomic overwrite with
 * timestamped backup.
 *
 * Currently only Claude Code has a first-class skills directory convention.
 * Other clients receive their guidance via `browserops install-rules`
 * (per-project slots) and the bridge's MCP `browserops` prompt.
 */
export async function installClaudeSkill(
  opts: SkillInstallOpts,
): Promise<SkillInstallResult> {
  const skillName = opts.skillName ?? "browserops";
  const cwd = opts.cwd ?? process.cwd();
  const target = targetSkillPath(opts.scope, cwd, skillName);

  const source = bundledSkillPath(skillName);
  if (!existsSync(source)) {
    throw new Error(
      `bundled skill "${skillName}" not found at ${source} — rebuild the CLI package (\`pnpm -F browserops build\`)`,
    );
  }
  const sourceText = await readFile(source, "utf8");

  let existingText: string | null = null;
  if (existsSync(target)) {
    existingText = await readFile(target, "utf8");
  }

  if (existingText === sourceText && !opts.force) {
    return {
      skillName,
      changed: false,
      targetPath: target,
      message: `${target} already up-to-date`,
    };
  }

  if (opts.dryRun) {
    if (existingText === null) {
      return {
        skillName,
        changed: true,
        targetPath: target,
        message: `would create ${target}`,
      };
    }
    return {
      skillName,
      changed: true,
      targetPath: target,
      message: `would overwrite ${target} (drift detected)`,
    };
  }

  await mkdir(targetDir(opts.scope, cwd, skillName), { recursive: true });
  const backupPath = existingText !== null ? await backup(target) : undefined;
  await atomicWrite(target, sourceText);

  if (existingText === null) {
    return {
      skillName,
      changed: true,
      targetPath: target,
      message: `installed ${target}`,
    };
  }
  return {
    skillName,
    changed: true,
    targetPath: target,
    backupPath,
    message: `refreshed ${target}`,
  };
}

/**
 * Install every bundled skill in one pass. Skills are independent — a
 * failure on one does not abort the rest. Per-skill errors are surfaced
 * as a `failed` array in the return so callers can render them after the
 * successful install lines.
 */
export async function installAllClaudeSkills(
  opts: Omit<SkillInstallOpts, "skillName">,
): Promise<{
  results: SkillInstallResult[];
  failed: Array<{ skillName: string; error: Error }>;
}> {
  const skills = await discoverBundledSkills();
  const results: SkillInstallResult[] = [];
  const failed: Array<{ skillName: string; error: Error }> = [];

  for (const skillName of skills) {
    try {
      results.push(await installClaudeSkill({ ...opts, skillName }));
    } catch (e) {
      failed.push({
        skillName,
        error: e instanceof Error ? e : new Error(String(e)),
      });
    }
  }

  return { results, failed };
}
