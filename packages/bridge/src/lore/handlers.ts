/**
 * MCP tool handlers for the four lore_* tools.
 *
 * Each handler validates raw params (throws CodedError("INVALID_PARAMS")
 * on bad shape), calls into the in-process store, and returns the
 * exact output shape declared by the matching ToolDef in
 * packages/shared/src/tools.ts.
 *
 * Lore handlers are pure-filesystem — no wsBridge, no extension
 * round-trip. Cheaper than the procedure handlers in every dimension.
 */
import {
  LORE_NAME_REGEX,
  LORE_TYPES,
  isLoreType,
  type LoreFrontmatter,
  type LoreType,
} from "@browserops/shared";
import {
  CodedError,
  deleteLore,
  listLoreEntries,
  readLore,
  saveLore,
} from "./store.js";
import { searchLore } from "./search.js";

// ---------------------------------------------------------------------------
// Param coercion
// ---------------------------------------------------------------------------

function requireString(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new CodedError("INVALID_PARAMS", `${key} must be a non-empty string`);
  }
  return v;
}

function requireName(raw: Record<string, unknown>): string {
  const v = requireString(raw, "name");
  if (!LORE_NAME_REGEX.test(v)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `name must match pattern ^[a-z][a-z0-9._-]{0,79}$ — got: ${v}`,
    );
  }
  return v;
}

function requireType(raw: Record<string, unknown>): LoreType {
  const v = raw["type"];
  if (typeof v !== "string" || !isLoreType(v)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `type must be one of: ${LORE_TYPES.join(", ")}`,
    );
  }
  return v;
}

function optionalBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    throw new CodedError("INVALID_PARAMS", `${key} must be a boolean if provided`);
  }
  return v;
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new CodedError("INVALID_PARAMS", `${key} must be a string if provided`);
  }
  return v;
}

function optionalNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const v = raw[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || Number.isNaN(v)) {
    throw new CodedError("INVALID_PARAMS", `${key} must be a number if provided`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export interface SaveResult {
  saved: true;
  path: string;
  /** True when a new lore entry was created, false when an existing one was overwritten. */
  created: boolean;
}

export async function handleLoreSave(raw: Record<string, unknown>): Promise<SaveResult> {
  const name = requireName(raw);
  const description = requireString(raw, "description");
  const type = requireType(raw);
  const body = requireString(raw, "body");
  const replace = optionalBoolean(raw, "replace") ?? false;

  const result = await saveLore({ name, description, type, body, replace });
  return { saved: true, path: result.entry.path, created: result.created };
}

export interface GetResult {
  meta: LoreFrontmatter;
  body: string;
  path: string;
}

export async function handleLoreGet(raw: Record<string, unknown>): Promise<GetResult> {
  const name = requireName(raw);
  const entry = await readLore(name);
  return { meta: entry.meta, body: entry.body, path: entry.path };
}

export interface DeleteResult {
  deleted: true;
  path: string;
}

export async function handleLoreDelete(raw: Record<string, unknown>): Promise<DeleteResult> {
  const name = requireName(raw);
  const { path: absPath } = await deleteLore(name);
  return { deleted: true, path: absPath };
}

export async function handleLoreSearch(raw: Record<string, unknown>): Promise<unknown> {
  const query = requireString(raw, "query");
  const typeRaw = optionalString(raw, "type");
  if (typeRaw !== undefined && !isLoreType(typeRaw)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `type filter must be one of: ${LORE_TYPES.join(", ")}`,
    );
  }
  const limit = optionalNumber(raw, "limit");
  const minScore = optionalNumber(raw, "min_score");

  const entries = await listLoreEntries();
  return searchLore(entries, query, {
    type: typeRaw as LoreType | undefined,
    limit,
    min_score: minScore,
  });
}

// ---------------------------------------------------------------------------
// Handler map — consumed by mcp-server.ts dispatch.
// ---------------------------------------------------------------------------

type HandlerFn = (raw: Record<string, unknown>) => Promise<unknown>;

export const LORE_HANDLERS: Record<string, HandlerFn> = {
  lore_save: handleLoreSave,
  lore_search: handleLoreSearch,
  lore_get: handleLoreGet,
  lore_delete: handleLoreDelete,
};
