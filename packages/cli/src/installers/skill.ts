import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
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
}

export interface SkillInstallResult {
  changed: boolean;
  /** Where the skill was (or would be) written. */
  targetPath: string;
  /** Path of the .bak file if drift was overwritten. */
  backupPath?: string;
  message: string;
}

/**
 * Bundled canonical skill: <cli-pkg>/dist/assets/skills/browserops/SKILL.md.
 * Resolved at runtime via bundledAssetsDir().
 */
function bundledSkillPath(): string {
  return resolve(bundledAssetsDir(), "skills", "browserops", "SKILL.md");
}

function targetDir(scope: SkillScope, cwd: string): string {
  if (scope === "user") {
    return join(homedir(), ".claude", "skills", "browserops");
  }
  return join(cwd, ".claude", "skills", "browserops");
}

function targetSkillPath(scope: SkillScope, cwd: string): string {
  return join(targetDir(scope, cwd), "SKILL.md");
}

/**
 * Install (or refresh) the canonical browserops skill into a Claude Code
 * skills directory. Idempotent — same content → no-op. Drift → atomic
 * overwrite with timestamped backup.
 *
 * Currently only Claude Code has a first-class skills directory convention.
 * Other clients receive their guidance via `browserops install-rules`
 * (per-project slots) and the bridge's MCP `browserops` prompt.
 */
export async function installClaudeSkill(
  opts: SkillInstallOpts,
): Promise<SkillInstallResult> {
  const cwd = opts.cwd ?? process.cwd();
  const target = targetSkillPath(opts.scope, cwd);

  const source = bundledSkillPath();
  if (!existsSync(source)) {
    throw new Error(
      `bundled skill not found at ${source} — rebuild the CLI package (\`pnpm -F browserops build\`)`,
    );
  }
  const sourceText = await readFile(source, "utf8");

  let existingText: string | null = null;
  if (existsSync(target)) {
    existingText = await readFile(target, "utf8");
  }

  if (existingText === sourceText && !opts.force) {
    return {
      changed: false,
      targetPath: target,
      message: `${target} already up-to-date`,
    };
  }

  if (opts.dryRun) {
    if (existingText === null) {
      return {
        changed: true,
        targetPath: target,
        message: `would create ${target}`,
      };
    }
    return {
      changed: true,
      targetPath: target,
      message: `would overwrite ${target} (drift detected)`,
    };
  }

  await mkdir(targetDir(opts.scope, cwd), { recursive: true });
  const backupPath = existingText !== null ? await backup(target) : undefined;
  await atomicWrite(target, sourceText);

  if (existingText === null) {
    return { changed: true, targetPath: target, message: `installed ${target}` };
  }
  return {
    changed: true,
    targetPath: target,
    backupPath,
    message: `refreshed ${target}`,
  };
}
