import type { AgentId } from "@browserops/shared";
import type { Logger } from "../logger.js";
import type { ChatTransport } from "../config.js";
import type { AgentDriver } from "./driver.js";
import { ClaudeDriver } from "./claude/driver.js";
import { ClaudePtyDriver } from "./claude/terminal-driver.js";
import { CodexDriver } from "./codex/driver.js";
import { CodexPtyDriver } from "./codex/terminal-driver.js";
import { CursorDriver } from "./cursor/driver.js";
import { CursorPtyDriver } from "./cursor/terminal-driver.js";

export interface ChatEngineDriverSet {
  drivers: Partial<Record<AgentId, AgentDriver>>;
  fallbacks: Partial<Record<AgentId, AgentDriver>>;
}

export interface CreateChatEngineDriversOptions {
  chatTransport: ChatTransport;
  logger?: Logger;
}

export function createChatEngineDrivers(opts: CreateChatEngineDriversOptions): ChatEngineDriverSet {
  const headlessClaude = new ClaudeDriver(opts.logger ? { logger: opts.logger } : {});
  const headlessCodex = new CodexDriver(opts.logger ? { logger: opts.logger } : {});
  const headlessCursor = new CursorDriver(opts.logger ? { logger: opts.logger } : {});
  const terminal = opts.chatTransport === "terminal";
  const drivers: Partial<Record<AgentId, AgentDriver>> = {
    claude: terminal
      ? new ClaudePtyDriver(opts.logger ? { logger: opts.logger } : {})
      : headlessClaude,
    codex: terminal
      ? new CodexPtyDriver(opts.logger ? { logger: opts.logger } : {})
      : headlessCodex,
    cursor: terminal
      ? new CursorPtyDriver(opts.logger ? { logger: opts.logger } : {})
      : headlessCursor,
  };
  const fallbacks: Partial<Record<AgentId, AgentDriver>> = terminal
    ? { claude: headlessClaude, codex: headlessCodex, cursor: headlessCursor }
    : {};
  return { drivers, fallbacks };
}
