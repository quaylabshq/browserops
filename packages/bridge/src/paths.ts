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

/**
 * Directory for transient launcher artifacts written by `launch-claude.ts`
 * (the per-launch context file + shell/PowerShell launcher script). Lives
 * under the already-0700 state dir rather than a world-readable temp dir so
 * the seeded page metadata stays private. Created on demand at launch time.
 */
export function launchDir(): string {
  return join(stateDir(), "launch");
}

/**
 * Per-session chat-engine artifacts: the human-readable mirror logs the
 * "Show in terminal" affordance tails. Under the 0700 state dir.
 */
export function chatDir(): string {
  return join(stateDir(), "chat");
}

/** The session index (sessions the chat engine has started) lives here. */
export function sessionsDir(): string {
  return join(stateDir(), "sessions");
}

/**
 * Neutral working directory the chat engine runs agents in, so a danger-mode
 * session has a bounded filesystem blast radius and its transcripts live at a
 * predictable cwd. Override with BROWSEROPS_WORKSPACE_DIR.
 */
export function workspaceDir(): string {
  return process.env["BROWSEROPS_WORKSPACE_DIR"] || join(stateDir(), "workspace");
}
