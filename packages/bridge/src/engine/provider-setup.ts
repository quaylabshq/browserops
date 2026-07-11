/**
 * BrowserOps panel-chat provider preflight.
 *
 * The panel starts provider CLIs directly, so an installed binary alone is not
 * enough: the CLI must also know about BrowserOps' stdio MCP shim. Keeping this
 * check here makes the state explicit before a user opens a conversation and
 * gives the panel one safe, user-initiated registration action.
 */
import { existsSync } from "node:fs";
import { promises as nodeFs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentId, ChatAgentStatus } from "@browserops/shared";

export interface McpInvocation {
  command: string;
  args: string[];
}

interface FileOps {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, contents: string, encoding: "utf8"): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<string | undefined>;
  rename(from: string, to: string): Promise<void>;
}

export interface ProviderSetupDeps {
  /** Override the home directory in tests. */
  home?: string;
  /** Override the BrowserOps stdio command in tests or embedded deployments. */
  shim?: McpInvocation;
  fs?: FileOps;
}

type JsonRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "value"; value: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configPath(agent: AgentId, home: string): string {
  switch (agent) {
    case "claude":
      // Claude Code's --scope user registrations live in ~/.claude.json.
      return join(home, ".claude.json");
    case "codex":
      return join(home, ".codex", "config.toml");
    case "cursor":
      return join(home, ".cursor", "mcp.json");
  }
}

/**
 * The daemon and shim are bundled beside each other in dist/. Prefer that
 * absolute invocation so a globally-installed browserops CLI does not depend
 * on a transitive browserops-shim binary being present on PATH. Source/tests
 * fall back to the normal executable name unless a test supplies an override.
 */
export function defaultShimInvocation(): McpInvocation {
  const bundledShim = join(dirname(fileURLToPath(import.meta.url)), "shim.js");
  return existsSync(bundledShim)
    ? { command: process.execPath, args: [bundledShim] }
    : { command: "browserops-shim", args: [] };
}

function withCliMissing(base: ChatAgentStatus, path: string): ChatAgentStatus {
  return {
    ...base,
    available: false,
    setupState: "cli_missing",
    configPath: path,
    canConfigure: false,
  };
}

function withMcpState(
  base: ChatAgentStatus,
  path: string,
  setupState: "ready" | "mcp_missing" | "config_invalid",
): ChatAgentStatus {
  const ready = setupState === "ready";
  return {
    ...base,
    available: ready,
    setupState,
    configPath: path,
    canConfigure: setupState === "mcp_missing",
    ...(ready ? { reason: undefined } : { reason: setupState }),
  };
}

async function readJson(path: string, fs: FileOps): Promise<JsonRead> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw err;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? { kind: "value", value } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function jsonMcpState(value: Record<string, unknown>): "ready" | "mcp_missing" | "config_invalid" {
  const servers = value["mcpServers"];
  if (servers === undefined) return "mcp_missing";
  if (!isRecord(servers)) return "config_invalid";
  const browserops = servers["browserops"];
  if (browserops === undefined) return "mcp_missing";
  // BrowserOps is a local stdio server. A named but malformed entry must not
  // be treated as ready, and we deliberately do not overwrite it automatically.
  return isRecord(browserops) &&
    typeof browserops["command"] === "string" &&
    browserops["command"].trim().length > 0
    ? "ready"
    : "config_invalid";
}

function codexMcpState(raw: string): "ready" | "mcp_missing" | "config_invalid" {
  const header = /^\[mcp_servers\.browserops\]\s*$/m;
  const match = header.exec(raw);
  if (!match || match.index === undefined) return "mcp_missing";
  const afterHeader = raw.indexOf("\n", match.index);
  const rest = afterHeader === -1 ? "" : raw.slice(afterHeader + 1);
  const next = /^\[/m.exec(rest);
  const section = next?.index === undefined ? rest : rest.slice(0, next.index);
  const command = /^command\s*=\s*"([^"]*)"\s*$/m.exec(section)?.[1];
  return command?.trim() ? "ready" : "config_invalid";
}

async function writeAtomically(path: string, contents: string, fs: FileOps): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.browserops.tmp`;
  await fs.writeFile(temporary, contents, "utf8");
  await fs.rename(temporary, path);
}

function withJsonRegistration(
  value: Record<string, unknown>,
  shim: McpInvocation,
): Record<string, unknown> {
  const servers = isRecord(value["mcpServers"]) ? { ...value["mcpServers"] } : {};
  servers["browserops"] = {
    command: shim.command,
    ...(shim.args.length > 0 ? { args: shim.args } : {}),
  };
  return { ...value, mcpServers: servers };
}

function codexBlock(shim: McpInvocation): string {
  const args = `[${shim.args.map((arg) => JSON.stringify(arg)).join(", ")}]`;
  return `[mcp_servers.browserops]\ncommand = ${JSON.stringify(shim.command)}\nargs = ${args}\n`;
}

function replaceCodexBlock(raw: string, block: string): string {
  const header = /^\[mcp_servers\.browserops\]\s*$/m;
  const match = header.exec(raw);
  if (!match || match.index === undefined) {
    const base = raw.length === 0 || raw.endsWith("\n") ? raw : `${raw}\n`;
    return `${base}${block}`;
  }
  const afterHeader = raw.indexOf("\n", match.index);
  if (afterHeader === -1) return raw.slice(0, match.index) + block;
  const rest = raw.slice(afterHeader + 1);
  const next = /^\[/m.exec(rest);
  const end = next?.index === undefined ? raw.length : afterHeader + 1 + next.index;
  return raw.slice(0, match.index) + block + raw.slice(end);
}

/** Combine a driver's binary check with the provider's BrowserOps MCP registration. */
export async function inspectChatAgent(
  base: ChatAgentStatus,
  deps: ProviderSetupDeps = {},
): Promise<ChatAgentStatus> {
  const home = deps.home ?? homedir();
  const path = configPath(base.agent, home);
  const fs = deps.fs ?? nodeFs;
  if (!base.available) return withCliMissing(base, path);

  if (base.agent === "codex") {
    let raw: string;
    try {
      raw = await fs.readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return withMcpState(base, path, "mcp_missing");
      }
      throw err;
    }
    return withMcpState(base, path, codexMcpState(raw));
  }

  const json = await readJson(path, fs);
  if (json.kind === "missing") return withMcpState(base, path, "mcp_missing");
  if (json.kind === "invalid") return withMcpState(base, path, "config_invalid");
  return withMcpState(base, path, jsonMcpState(json.value));
}

export async function inspectChatAgents(
  base: ChatAgentStatus[],
  deps: ProviderSetupDeps = {},
): Promise<ChatAgentStatus[]> {
  return Promise.all(base.map((status) => inspectChatAgent(status, deps)));
}

/**
 * Register the BrowserOps shim for one installed provider. This never installs
 * a third-party CLI and refuses to overwrite a malformed existing config.
 */
export async function configureChatAgent(
  base: ChatAgentStatus,
  deps: ProviderSetupDeps = {},
): Promise<ChatAgentStatus> {
  const current = await inspectChatAgent(base, deps);
  if (!current.canConfigure) return current;

  const home = deps.home ?? homedir();
  const path = configPath(base.agent, home);
  const fs = deps.fs ?? nodeFs;
  const shim = deps.shim ?? defaultShimInvocation();

  if (base.agent === "codex") {
    let raw = "";
    try {
      raw = await fs.readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await writeAtomically(path, replaceCodexBlock(raw, codexBlock(shim)), fs);
  } else {
    const json = await readJson(path, fs);
    const existing = json.kind === "value" ? json.value : {};
    await writeAtomically(
      path,
      JSON.stringify(withJsonRegistration(existing, shim), null, 2) + "\n",
      fs,
    );
  }

  return inspectChatAgent(base, deps);
}
