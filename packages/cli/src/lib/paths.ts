import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAEMON_PIDFILE_FILENAME,
  DAEMON_SOCKET_FILENAME,
  EXTENSION_ID_FILENAME,
  LOG_FILENAME,
  STATE_DIR_NAME,
  TOKEN_FILENAME,
} from "@browserops/shared";

export const STATE_DIR = join(homedir(), STATE_DIR_NAME);

export const tokenPath = (): string => join(STATE_DIR, TOKEN_FILENAME);
export const extensionIdPath = (): string => join(STATE_DIR, EXTENSION_ID_FILENAME);
export const logPath = (): string => join(STATE_DIR, LOG_FILENAME);
export const daemonLogPath = (): string => join(STATE_DIR, "daemon.log");
/**
 * Pidfile the daemon itself writes via acquirePidfile. The CLI just
 * reads it for `status` / `stop`; we no longer track our own.
 */
export const daemonPidPath = (): string => join(STATE_DIR, DAEMON_PIDFILE_FILENAME);
export const daemonSocketPath = (): string => join(STATE_DIR, DAEMON_SOCKET_FILENAME);
export const configPath = (): string => join(STATE_DIR, "config.json");

/**
 * Resolve the bundled-asset directory inside the published CLI package
 * (cli/dist/assets/). Falls back to the source repo path when running via tsx.
 *
 * BROWSEROPS_ASSETS_DIR overrides the resolved path. Used by tests to point
 * at a synthetic asset tree without going through the full tsup build, and
 * by hackers running a global install against a development fixture.
 */
export function bundledAssetsDir(): string {
  const override = process.env["BROWSEROPS_ASSETS_DIR"];
  if (override !== undefined && override !== "") return override;
  const here = fileURLToPath(import.meta.url);
  // dist build: <pkg>/dist/index.js → ../assets
  // dev build:  <pkg>/src/lib/paths.ts → ../../dist/assets
  return resolve(here, "..", "assets");
}
