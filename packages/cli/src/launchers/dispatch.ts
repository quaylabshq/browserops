import type { LauncherId } from "../lib/config.js";
import { runClaudeLauncher } from "./claude.js";
import { runCursorLauncher } from "./cursor.js";
import { runCodexLauncher } from "./codex.js";

export async function dispatchLauncher(id: LauncherId, task: string): Promise<void> {
  switch (id) {
    case "claude":
      return runClaudeLauncher(task);
    case "cursor":
      return runCursorLauncher(task);
    case "codex":
      return runCodexLauncher(task);
  }
}
