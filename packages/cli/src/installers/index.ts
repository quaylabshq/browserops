export * from "./types.js";
export { detectClients } from "./detect.js";
import { claudeCodeInstaller } from "./claude-code.js";
import { cursorInstaller } from "./cursor.js";
import { zedInstaller } from "./zed.js";
import { continueInstaller } from "./continue.js";
import { windsurfInstaller } from "./windsurf.js";
import { codexInstaller } from "./codex.js";
import type { ClientId, ClientInstaller } from "./types.js";

export const INSTALLERS: Record<ClientId, ClientInstaller> = {
  "claude-code": claudeCodeInstaller,
  "cursor": cursorInstaller,
  "zed": zedInstaller,
  "continue": continueInstaller,
  "windsurf": windsurfInstaller,
  "codex": codexInstaller,
};
