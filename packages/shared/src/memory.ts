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

// ---------------------------------------------------------------------------
// v2 structured schema — additive; legacy types kept until Phase 4
// ---------------------------------------------------------------------------

import type { Locator } from "./locator.js";

/** Scope discriminator: global (cross-site) or site-specific. */
export type MemoryScope = "global" | "site";

/** Semantic category of what the record captures. */
export type MemoryKind = "blocker" | "affordance" | "gotcha" | "selector" | "lesson";

/** How serious the recorded knowledge is. */
export type MemorySeverity = "low" | "med" | "high";

/** Bridge/scribe-managed counters; never hand-authored. */
export interface MemoryStats {
  hits: number;
  last_hit?: string;
  resolved: number;
  last_resolved?: string;
  /** Delivered door later failed — self-heal signal. */
  door_failures: number;
  /** Number of times the scribe has touched this record (dedup pressure). */
  captures: number;
}

/** Full structured memory record (schema_version 1). */
export interface MemoryRecord {
  schema_version: 1;
  /** Unique identifier — must match MEMORY_NAME_PATTERN. */
  name: string;
  scope: MemoryScope;
  kind: MemoryKind;
  /** ≤120 chars; the line shown in a primer index. */
  title: string;
  /** REQUIRED when scope==="site"; scheme://host[:port]. */
  origin?: string;
  /** When true, match subdomains of origin (default false). */
  origin_wildcard?: boolean;
  /** Optional path narrowing, e.g. "/compose*". */
  path_glob?: string;
  /** Default "med". */
  severity?: MemorySeverity;
  /** ≤10 tags. */
  tags?: string[];
  detail: {
    /** blocker: symptom description. */
    wall?: string;
    /** blocker: the workaround. */
    door?: string;
    /** affordance / gotcha / lesson: the fact. */
    note?: string;
    /** selector: reuse the procedures Locator descriptor. */
    locator?: Locator;
  };
  links?: {
    procedures?: string[];
    memories?: string[];
  };
  stats?: MemoryStats;
  meta?: {
    version: number;
    created: string;
    updated: string;
    source: "scribe" | "mcp-tool" | "cli";
    corroborated?: boolean;
  };
}

/** Validation error shape returned by validateMemory. */
export interface MemoryValidationError {
  field: string;
  message: string;
}

/**
 * Validate a MemoryRecord against structural rules that JSON-Schema alone
 * cannot express (cross-field dependencies, caps, enum coherence).
 *
 * Returns an empty array on success; an array of {field, message} on failure.
 * Mirrors the validateProcedure style in procedures.ts.
 */
export function validateMemory(record: MemoryRecord): MemoryValidationError[] {
  const errors: MemoryValidationError[] = [];

  // name pattern
  if (!MEMORY_NAME_REGEX.test(record.name)) {
    errors.push({
      field: "name",
      message: `name must match ${MEMORY_NAME_PATTERN}`,
    });
  }

  // scope === "site" requires origin
  if (record.scope === "site" && !record.origin) {
    errors.push({
      field: "origin",
      message: "origin is required when scope is \"site\"",
    });
  }

  // origin only allowed when scope === "site"
  if (record.origin && record.scope !== "site") {
    errors.push({
      field: "origin",
      message: "origin may only be set when scope is \"site\"",
    });
  }

  // title cap
  if (record.title.length > 120) {
    errors.push({
      field: "title",
      message: "title must be ≤120 characters",
    });
  }

  // tags cap
  if (record.tags && record.tags.length > 10) {
    errors.push({
      field: "tags",
      message: "tags must contain ≤10 entries",
    });
  }

  // kind / detail coherence
  switch (record.kind) {
    case "blocker":
      if (!record.detail.wall) {
        errors.push({
          field: "detail.wall",
          message: "detail.wall is required for kind \"blocker\"",
        });
      }
      if (!record.detail.door) {
        errors.push({
          field: "detail.door",
          message: "detail.door is required for kind \"blocker\"",
        });
      }
      break;
    case "selector":
      if (!record.detail.locator) {
        errors.push({
          field: "detail.locator",
          message: "detail.locator is required for kind \"selector\"",
        });
      }
      break;
    case "affordance":
    case "gotcha":
    case "lesson":
      if (!record.detail.note) {
        errors.push({
          field: "detail.note",
          message: `detail.note is required for kind "${record.kind}"`,
        });
      }
      break;
  }

  return errors;
}

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
