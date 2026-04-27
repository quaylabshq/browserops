import { homedir } from "node:os";
import { join } from "node:path";
import {
  LOG_FILENAME,
  RISKY_DOMAINS_FILENAME,
  STATE_DIR_NAME,
  TOKEN_FILENAME,
} from "@browserops/shared";
import { CONTROL_SOCKET_FILENAME } from "./control-protocol.js";

export function stateDir(): string {
  return join(homedir(), STATE_DIR_NAME);
}

export function tokenPath(): string {
  return join(stateDir(), TOKEN_FILENAME);
}

export function logPath(): string {
  return join(stateDir(), LOG_FILENAME);
}

export function riskyDomainsPath(): string {
  return join(stateDir(), RISKY_DOMAINS_FILENAME);
}

export function controlSocketPath(): string {
  return join(stateDir(), CONTROL_SOCKET_FILENAME);
}

export function configPath(): string {
  return join(stateDir(), "config.json");
}
