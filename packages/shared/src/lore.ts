/**
 * Cross-agent lore store schema.
 *
 * Memories live as one markdown file per entry under
 * ~/browserops/lore/<name>.md, with YAML frontmatter at the top
 * carrying the metadata fields below and a markdown body underneath.
 * The store is owned by the bridge and exposed to every MCP client via
 * the lore_save / lore_search / lore_get / lore_delete tools.
 *
 * There is no per-entry scope: any file in the bridge store is shared
 * by definition. Claude Code's auto-memory at ~/.claude/projects/.../memory/
 * is a separate store that the bridge does not see.
 */

/** Lore categories — same taxonomy Claude's auto-memory uses. */
export type LoreType = "user" | "feedback" | "project" | "reference";

export const LORE_TYPES: readonly LoreType[] = [
  "user",
  "feedback",
  "project",
  "reference",
] as const;

/** Pattern enforced for lore names (mirrors procedure-name discipline). */
export const LORE_NAME_PATTERN = "^[a-z][a-z0-9._-]{0,79}$";
export const LORE_NAME_REGEX = new RegExp(LORE_NAME_PATTERN);

/** Metadata persisted in the YAML frontmatter at the top of every lore file. */
export interface LoreFrontmatter {
  /** Unique identifier; matches LORE_NAME_PATTERN. */
  name: string;
  /** One-line summary used by lore_search to decide relevance. */
  description: string;
  /** Category tag — same set Claude's auto-memory uses. */
  type: LoreType;
  /** Who wrote the entry. mcp-tool = via lore_save, cli = via the human CLI. */
  source: "mcp-tool" | "cli";
  /** ISO 8601 timestamp set on first write. */
  created: string;
  /** ISO 8601 timestamp updated on every save. */
  updated: string;
}

/** Full in-memory representation: metadata + markdown body + on-disk path. */
export interface LoreEntry {
  meta: LoreFrontmatter;
  body: string;
  path: string;
}

/** Single hit returned by lore_search (metadata only, no body). */
export interface LoreSearchMatch {
  name: string;
  description: string;
  type: LoreType;
  /** Coverage ratio in [0, 1]: matched query tokens / total query tokens. */
  score: number;
  /** First ~120 characters of the body, for at-a-glance context. */
  snippet: string;
}

/** Type guard for the LoreType enum. */
export function isLoreType(value: unknown): value is LoreType {
  return typeof value === "string" && (LORE_TYPES as readonly string[]).includes(value);
}
