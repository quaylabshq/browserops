import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_SOCKET_FILENAME,
  LOG_FILENAME,
  STATE_DIR_NAME,
  TOKEN_FILENAME,
} from "@browserops/shared";

export const STATE_DIR = join(homedir(), STATE_DIR_NAME);

export const tokenPath = (): string => join(STATE_DIR, TOKEN_FILENAME);
export const logPath = (): string => join(STATE_DIR, LOG_FILENAME);
export const daemonLogPath = (): string => join(STATE_DIR, "daemon.log");
export const pidPath = (): string => join(STATE_DIR, "bridge.pid");
export const controlSocketPath = (): string => join(STATE_DIR, CONTROL_SOCKET_FILENAME);
export const configPath = (): string => join(STATE_DIR, "config.json");
export const extensionInstallDir = (): string => join(STATE_DIR, "extension");

/**
 * Resolve the bundled-asset directory inside the published CLI package
 * (cli/dist/assets/). Falls back to the source repo path when running via tsx.
 */
export function bundledAssetsDir(): string {
  const here = fileURLToPath(import.meta.url);
  // dist build: <pkg>/dist/index.js → ../assets
  // dev build:  <pkg>/src/lib/paths.ts → ../../dist/assets
  return resolve(here, "..", "assets");
}
