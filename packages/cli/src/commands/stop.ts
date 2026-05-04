import { existsSync } from "node:fs";
import { isDaemonAlive, stopDaemon } from "../lib/daemon.js";
import { daemonPidPath } from "../lib/paths.js";
import { ok, info } from "../lib/ui.js";

export async function runStop(): Promise<void> {
  if (!(await isDaemonAlive()) && !existsSync(daemonPidPath())) {
    info("daemon not running");
    return;
  }
  const stopped = await stopDaemon({});
  if (stopped) {
    ok("stopped");
  } else {
    info("no PID recorded; cleared state");
  }
}
