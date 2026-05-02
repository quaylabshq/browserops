import { installClaudeSkill, type SkillScope } from "../installers/skill.js";
import { c, dim, err, info, ok } from "../lib/ui.js";

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

  try {
    const result = await installClaudeSkill({
      scope,
      force: opts.force,
      dryRun: opts.dryRun,
    });
    if (result.changed) {
      const tail = result.backupPath ? ` ${dim(`(backup: ${result.backupPath})`)}` : "";
      ok(`${result.message}${tail}`);
    } else {
      info(result.message);
    }
    process.stdout.write(
      `\n${dim(`Tip: invoke in Claude Code via ${c.cyan("/browserops")} (skill auto-loads on browser tasks).`)}\n`,
    );
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
