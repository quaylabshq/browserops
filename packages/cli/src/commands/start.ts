import { isDaemonAlive, spawnDaemon } from "../lib/daemon.js";
import { daemonSocketPath } from "../lib/paths.js";
import { ok, info, err } from "../lib/ui.js";

export async function runStart(): Promise<void> {
  if (await isDaemonAlive()) {
    info("daemon already running");
    return;
  }
  try {
    const { pid } = await spawnDaemon({});
    ok(`daemon started — pid ${pid}  socket ${daemonSocketPath()}`);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
