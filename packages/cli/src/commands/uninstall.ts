import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import prompts from "prompts";
import { STATE_DIR } from "../lib/paths.js";
import { runStop } from "./stop.js";
import { c, dim, info, ok } from "../lib/ui.js";
import { getCliTelemetry } from "../lib/telemetry.js";

export interface UninstallOpts {
  /**
   * Remove ~/.browserops/ entirely (token, extension_id, logs, config,
   * procedures, lore). Without --purge we only stop the daemon and
   * tell the user how to remove the package — state survives.
   */
  purge?: boolean;
  /** Skip the confirmation prompt. */
  yes?: boolean;
}

export async function runUninstall(opts: UninstallOpts = {}): Promise<void> {
  // Stop the daemon first so we're not holding the WS port + state files
  // open while we try to remove them.
  await runStop().catch(() => {
    // Already stopped or never started — fine.
  });

  if (opts.purge) {
    if (!opts.yes) {
      const result = await prompts({
        type: "confirm",
        name: "ok",
        message: `Delete ${STATE_DIR} (token, extension pin, logs, procedures, lore)?`,
        initial: false,
      });
      if (result["ok"] !== true) {
        info("aborting purge");
        return;
      }
    }
    if (existsSync(STATE_DIR)) {
      await fs.rm(STATE_DIR, { recursive: true, force: true });
      ok(`removed ${STATE_DIR}`);
    } else {
      info(`${STATE_DIR} already gone`);
    }
  } else {
    info(`state directory preserved at ${STATE_DIR} — use --purge to delete it.`);
  }

  process.stdout.write(
    `\n${c.bold("To remove the package itself, run:")}\n` +
      `  ${c.cyan("npm uninstall -g browserops")}\n\n` +
      `${dim("(The CLI can't remove its own bin while it's still running.)")}\n`,
  );

  getCliTelemetry()?.capture("cli.uninstall_ran", {
    purged: opts.purge === true,
  });
}
