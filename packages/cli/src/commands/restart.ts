import { runStop } from "./stop.js";
import { runStart } from "./start.js";
import { header } from "../lib/ui.js";

export async function runRestart(): Promise<void> {
  header("restarting browserops…");
  await runStop();
  await runStart();
}
