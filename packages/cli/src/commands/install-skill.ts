import { installAllClaudeSkills, type SkillScope } from "../installers/skill.js";
import { c, dim, err, info, ok, warn } from "../lib/ui.js";

export interface InstallSkillOpts {
  scope?: string;
  force?: boolean;
  dryRun?: boolean;
}

export async function runInstallSkill(opts: InstallSkillOpts = {}): Promise<void> {
  const scope: SkillScope = opts.scope === "project" ? "project" : "user";

  if (opts.scope && opts.scope !== "user" && opts.scope !== "project") {
    err(`unknown scope "${opts.scope}" — must be "user" or "project"`);
    process.exit(1);
  }

  const { results, failed } = await installAllClaudeSkills({
    scope,
    force: opts.force,
    dryRun: opts.dryRun,
  });

  if (results.length === 0 && failed.length === 0) {
    err(
      "no bundled skills found — rebuild the CLI package (`pnpm -F browserops build`).",
    );
    process.exit(1);
  }

  for (const result of results) {
    if (result.changed) {
      const tail = result.backupPath ? ` ${dim(`(backup: ${result.backupPath})`)}` : "";
      ok(`${result.skillName}: ${result.message}${tail}`);
    } else {
      info(`${result.skillName}: ${result.message}`);
    }
  }
  for (const f of failed) {
    warn(`${f.skillName}: ${f.error.message}`);
  }

  process.stdout.write(
    `\n${dim(`Tip: invoke in Claude Code via ${c.cyan("/browserops")} (skill auto-loads on browser tasks).`)}\n`,
  );

  if (failed.length > 0) process.exit(1);
}
