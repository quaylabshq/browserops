/**
 * Catalogue of coding agents the BrowserOps launcher can start in a terminal.
 *
 * Shared by both sides: the extension renders this list as the launcher's
 * agent picker, and the bridge validates incoming `/launch` requests against
 * it (only `enabled` agents are actually launchable).
 *
 * Adding a new agent is a registry entry here + a per-agent launch spec in the
 * bridge (`launch-agent.ts`). Disabled agents render as "coming soon" and are
 * refused server-side with `agent_disabled`.
 */

export type AgentId = "claude" | "codex" | "cursor";

export interface AgentInfo {
  id: AgentId;
  /** Display label for the picker. */
  label: string;
  /** Whether this agent can actually be launched today. */
  enabled: boolean;
  /** Short note shown in the UI (e.g. "coming soon"). */
  note?: string;
}

export const AGENTS: readonly AgentInfo[] = [
  { id: "claude", label: "Claude Code", enabled: true },
  { id: "codex", label: "Codex", enabled: false, note: "coming soon" },
  { id: "cursor", label: "Cursor", enabled: false, note: "coming soon" },
];

/** The default agent the launcher pre-selects. */
export const DEFAULT_AGENT_ID: AgentId = "claude";

export function getAgent(id: string): AgentInfo | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** True only for a known, currently-launchable agent id. */
export function isLaunchableAgent(id: string): id is AgentId {
  const a = getAgent(id);
  return a !== undefined && a.enabled;
}
