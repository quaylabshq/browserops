import { isBridgeAlive, spawnBridge } from "../lib/daemon.js";
import { controlSocketPath } from "../lib/paths.js";
import { ok, info, err } from "../lib/ui.js";

export async function runStart(): Promise<void> {
  if (await isBridgeAlive()) {
    info("bridge already running");
    return;
  }
  try {
    const { pid } = await spawnBridge({});
    ok(`bridge started — pid ${pid}  socket ${controlSocketPath()}`);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
