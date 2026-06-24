import type { AgentId } from "@browserops/shared";
import type { Logger } from "../logger.js";
import type { ChatTransport } from "../config.js";
import type { AgentDriver } from "./driver.js";
import { ClaudeDriver } from "./claude/driver.js";
import { ClaudePtyDriver } from "./claude/terminal-driver.js";
import { CodexDriver } from "./codex/driver.js";
import { CursorDriver } from "./cursor/driver.js";

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
  const drivers: Partial<Record<AgentId, AgentDriver>> = {
    claude:
      opts.chatTransport === "terminal"
        ? new ClaudePtyDriver(opts.logger ? { logger: opts.logger } : {})
        : headlessClaude,
    codex: new CodexDriver(opts.logger ? { logger: opts.logger } : {}),
    cursor: new CursorDriver(opts.logger ? { logger: opts.logger } : {}),
  };
  const fallbacks: Partial<Record<AgentId, AgentDriver>> =
    opts.chatTransport === "terminal" ? { claude: headlessClaude } : {};
  return { drivers, fallbacks };
}
