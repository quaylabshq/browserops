/**
 * `browserops reset-extension-pin` — the authorized escape hatch for
 * the "first-pair-wins" pin.
 *
 * The bridge pins the first extension it sees to
 * ~/.browserops/extension_id and refuses every subsequent WS upgrade
 * whose Origin doesn't match. That's correct when the pinned
 * extension is still installed. It becomes a silent 403 trap when the
 * pinned extension is gone (uninstalled, replaced with a different
 * channel, or side-loaded as a fresh unpacked build whose
 * chrome-extension:// ID no longer matches). Reaching into
 * ~/.browserops/ and rm'ing extension_id is the current recovery
 * path; this command replaces the blind rm with:
 *   1. a scoped announcement of what's about to happen,
 *   2. a graceful stop/start cycle so the live server drops the
 *      cached pin instead of continuing to refuse the extension until
 *      the next restart,
 *   3. a follow-up hint pointing at the Chrome extension popup, which
 *      is the human side of the pair handshake.
 *
 * Trust boundary: identical to the original pair — anyone with a
 * shell on this machine can already read
 * `~/.browserops/token`, so requiring them to type
 * `browserops reset-extension-pin` doesn't lower the security floor.
 */
import { existsSync } from "node:fs";
import { ensureDaemonRunning, isDaemonAlive, stopDaemon } from "../lib/daemon.js";
import { clearPinnedExtensionId, readPinnedExtensionId, shortId } from "../lib/pin.js";
import { extensionIdPath, daemonPidPath } from "../lib/paths.js";
import { c, dim, err, header, info, ok, warn } from "../lib/ui.js";

export interface ResetExtensionPinOpts {
  /** Skip the daemon restart and leave the server stopped. */
  noRestart?: boolean;
}

export async function runResetExtensionPin(opts: ResetExtensionPinOpts = {}): Promise<void> {
  header("browserops reset-extension-pin");

  const previous = await readPinnedExtensionId().catch(() => null);
  if (previous === null) {
    info("no pinned extension id on disk — nothing to clear");
  } else {
    info(`current pin: ${dim(shortId(previous))}`);
  }

  // Stop the daemon before deleting the file so the live server drops
  // its in-memory pin. Otherwise the running process keeps refusing
  // the extension until the next restart.
  if ((await isDaemonAlive()) || existsSync(daemonPidPath())) {
    info("stopping daemon…");
    try {
      const stopped = await stopDaemon({});
      if (stopped) ok("stopped");
      else info("no PID recorded; cleared state");
    } catch (e) {
      warn(`could not stop daemon cleanly: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    const cleared = await clearPinnedExtensionId();
    if (cleared) ok(`cleared pinned extension id ${dim(`(${extensionIdPath()})`)}`);
    else info("no pin file to remove");
  } catch (e) {
    err(`could not clear pinned extension id: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (opts.noRestart) {
    info("skipping daemon restart (--no-restart)");
  } else {
    info("starting daemon…");
    try {
      await ensureDaemonRunning({});
      ok("daemon started");
    } catch (e) {
      err(`daemon failed to start: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  }

  process.stdout.write(
    `\nnext step: click ${c.cyan("Pair")} in the browserops extension popup.\n` +
      `           the next extension to complete the WebSocket hello will be the new pin.\n\n`,
  );
}
