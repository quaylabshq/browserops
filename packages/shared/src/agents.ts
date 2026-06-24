/**
 * Catalogue of coding agents BrowserOps can drive.
 *
 * Shared by both sides: the extension renders this list as the chat/launcher
 * agent picker, and the bridge validates incoming `/launch` and `/chat/*`
 * requests against it.
 *
 * Two independent capabilities, because they ship per agent at different times:
 *  - `caps.launch` — can be opened as an interactive terminal session (today's
 *    `/launch`, and the chat engine's "take over in terminal" eject).
 *  - `caps.chat`   — can be driven by the in-panel bidirectional chat engine.
 *
 * Adding a new agent is a registry entry here plus whichever per-agent launch
 * specs / chat drivers are available in the bridge. Disabled agents render as
 * "coming soon" and are refused server-side with `agent_disabled`.
 */

export type AgentId = "claude" | "codex" | "cursor";

export interface AgentCaps {
  /** Launchable as an interactive terminal session (`/launch`, takeover eject). */
  launch: boolean;
  /** Drivable by the in-panel chat engine (bidirectional streaming). */
  chat: boolean;
}

export interface AgentInfo {
  id: AgentId;
  /** Display label for the picker. */
  label: string;
  /** Whether this agent is generally available (not "coming soon"). */
  enabled: boolean;
  /** Short note shown in the UI (e.g. "coming soon"). */
  note?: string;
  /** Fine-grained capabilities (see module doc). */
  caps: AgentCaps;
}

export const AGENTS: readonly AgentInfo[] = [
  { id: "claude", label: "Claude Code", enabled: true, caps: { launch: true, chat: true } },
  {
    id: "codex",
    label: "Codex",
    enabled: true,
    caps: { launch: false, chat: true },
  },
  {
    id: "cursor",
    label: "Cursor",
    enabled: true,
    caps: { launch: false, chat: true },
  },
];

/** The default agent the picker pre-selects. */
export const DEFAULT_AGENT_ID: AgentId = "claude";

export function getAgent(id: string): AgentInfo | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** True only for a known agent whose terminal launch is available today. */
export function isLaunchableAgent(id: string): id is AgentId {
  return getAgent(id)?.caps.launch === true;
}

/** True only for a known agent the in-panel chat engine can drive today. */
export function canChatAgent(id: string): id is AgentId {
  return getAgent(id)?.caps.chat === true;
}
