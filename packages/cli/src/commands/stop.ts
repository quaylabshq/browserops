import { existsSync } from "node:fs";
import { isBridgeAlive, stopBridge } from "../lib/daemon.js";
import { pidPath } from "../lib/paths.js";
import { ok, info } from "../lib/ui.js";

export async function runStop(): Promise<void> {
  if (!(await isBridgeAlive()) && !existsSync(pidPath())) {
    info("bridge not running");
    return;
  }
  const stopped = await stopBridge({});
  if (stopped) {
    ok("stopped");
  } else {
    info("no PID recorded; cleared state");
  }
}
