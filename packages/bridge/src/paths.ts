import { homedir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_PIDFILE_FILENAME,
  DAEMON_SOCKET_FILENAME,
  EXTENSION_ID_FILENAME,
  LOG_FILENAME,
  RISKY_DOMAINS_FILENAME,
  STATE_DIR_NAME,
  TOKEN_FILENAME,
} from "@browserops/shared";

export function stateDir(): string {
  return join(homedir(), STATE_DIR_NAME);
}

export function tokenPath(): string {
  return join(stateDir(), TOKEN_FILENAME);
}

export function extensionIdPath(): string {
  return join(stateDir(), EXTENSION_ID_FILENAME);
}

export function logPath(): string {
  return join(stateDir(), LOG_FILENAME);
}

export function riskyDomainsPath(): string {
  return join(stateDir(), RISKY_DOMAINS_FILENAME);
}

export function daemonSocketPath(): string {
  return join(stateDir(), DAEMON_SOCKET_FILENAME);
}

export function daemonPidfilePath(): string {
  return join(stateDir(), DAEMON_PIDFILE_FILENAME);
}

export function configPath(): string {
  return join(stateDir(), "config.json");
}
