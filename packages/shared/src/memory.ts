/**
 * Cross-agent memory store schema.
 *
 * Memories live as one markdown file per entry under
 * ~/browserops/memory/<name>.md, with YAML frontmatter at the top
 * carrying the metadata fields below and a markdown body underneath.
 * The store is owned by the bridge and exposed to every MCP client via
 * the memory_save / memory_search / memory_get / memory_delete tools.
 *
 * There is no per-entry scope: any file in the bridge store is shared
 * by definition. Claude Code's auto-memory at ~/.claude/projects/.../memory/
 * is a separate store that the bridge does not see.
 */

/** Memory categories — same taxonomy Claude's auto-memory uses. */
export type MemoryType = "user" | "feedback" | "project" | "reference";

export const MEMORY_TYPES: readonly MemoryType[] = [
  "user",
  "feedback",
  "project",
  "reference",
] as const;

/** Pattern enforced for memory names (mirrors procedure-name discipline). */
export const MEMORY_NAME_PATTERN = "^[a-z][a-z0-9._-]{0,79}$";
export const MEMORY_NAME_REGEX = new RegExp(MEMORY_NAME_PATTERN);

/** Metadata persisted in the YAML frontmatter at the top of every memory file. */
export interface MemoryFrontmatter {
  /** Unique identifier; matches MEMORY_NAME_PATTERN. */
  name: string;
  /** One-line summary used by memory_search to decide relevance. */
  description: string;
  /** Category tag — same set Claude's auto-memory uses. */
  type: MemoryType;
  /** Who wrote the entry. mcp-tool = via memory_save, cli = via the human CLI. */
  source: "mcp-tool" | "cli";
  /** ISO 8601 timestamp set on first write. */
  created: string;
  /** ISO 8601 timestamp updated on every save. */
  updated: string;
}

/** Full in-memory representation: metadata + markdown body + on-disk path. */
export interface MemoryEntry {
  meta: MemoryFrontmatter;
  body: string;
  path: string;
}

/** Single hit returned by memory_search (metadata only, no body). */
export interface MemorySearchMatch {
  name: string;
  description: string;
  type: MemoryType;
  /** Coverage ratio in [0, 1]: matched query tokens / total query tokens. */
  score: number;
  /** First ~120 characters of the body, for at-a-glance context. */
  snippet: string;
}

/** Type guard for the MemoryType enum. */
export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}
