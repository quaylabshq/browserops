import type { AgentId } from "@browserops/shared";

export interface ProviderMcpConnectionSnapshot {
  agent: AgentId;
  activeSessions: number;
  lastConnectedAt?: number;
}

/**
 * Tracks real MCP shim connections, which is intentionally separate from a
 * provider's persisted configuration. Headless provider CLIs may release
 * their stdio MCP subprocess between turns, so `lastConnectedAt` preserves
 * evidence of a successful handshake without presenting it as still live.
 */
export class McpConnectionMonitor {
  private readonly activeByAgent = new Map<AgentId, Set<string>>();
  private readonly agentBySession = new Map<string, AgentId>();
  private readonly lastConnectedAt = new Map<AgentId, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  markConnected(sessionId: string, clientName: string | undefined): AgentId | undefined {
    const agent = agentFromClientName(clientName);
    if (!agent) return undefined;
    this.agentBySession.set(sessionId, agent);
    const active = this.activeByAgent.get(agent) ?? new Set<string>();
    active.add(sessionId);
    this.activeByAgent.set(agent, active);
    this.lastConnectedAt.set(agent, this.now());
    return agent;
  }

  markDisconnected(sessionId: string): AgentId | undefined {
    const agent = this.agentBySession.get(sessionId);
    if (!agent) return undefined;
    this.agentBySession.delete(sessionId);
    const active = this.activeByAgent.get(agent);
    active?.delete(sessionId);
    if (active?.size === 0) this.activeByAgent.delete(agent);
    return agent;
  }

  activeSessions(agent: AgentId): number {
    return this.activeByAgent.get(agent)?.size ?? 0;
  }

  lastSeen(agent: AgentId): number | undefined {
    return this.lastConnectedAt.get(agent);
  }

  snapshot(): ProviderMcpConnectionSnapshot[] {
    return (["claude", "codex", "cursor"] as const).map((agent) => ({
      agent,
      activeSessions: this.activeSessions(agent),
      ...(this.lastSeen(agent) !== undefined ? { lastConnectedAt: this.lastSeen(agent) } : {}),
    }));
  }
}

/** Map the clientInfo reported by provider MCP clients to the panel agent id. */
export function agentFromClientName(clientName: string | undefined): AgentId | undefined {
  const name = clientName?.trim().toLowerCase() ?? "";
  if (name.includes("claude")) return "claude";
  if (name.includes("codex")) return "codex";
  if (name.includes("cursor")) return "cursor";
  return undefined;
}
