/**
 * MCP tool handlers for the four memory_* tools.
 *
 * Each handler validates raw params (throws CodedError("INVALID_PARAMS")
 * on bad shape), calls into the in-process store, and returns the
 * exact output shape declared by the matching ToolDef in
 * packages/shared/src/tools.ts.
 *
 * Memory handlers are pure-filesystem — no wsBridge, no extension
 * round-trip. Cheaper than the procedure handlers in every dimension.
 */
import {
  MEMORY_NAME_REGEX,
  MEMORY_TYPES,
  isMemoryType,
  type MemoryFrontmatter,
  type MemoryType,
} from "@browserops/shared";
import {
  CodedError,
  deleteMemory,
  listMemoryEntries,
  readMemory,
  saveMemory,
} from "./store.js";
import { searchMemories } from "./search.js";

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
  if (!MEMORY_NAME_REGEX.test(v)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `name must match pattern ^[a-z][a-z0-9._-]{0,79}$ — got: ${v}`,
    );
  }
  return v;
}

function requireType(raw: Record<string, unknown>): MemoryType {
  const v = raw["type"];
  if (typeof v !== "string" || !isMemoryType(v)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `type must be one of: ${MEMORY_TYPES.join(", ")}`,
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
  /** True when a new memory was created, false when an existing one was overwritten. */
  created: boolean;
}

export async function handleMemorySave(raw: Record<string, unknown>): Promise<SaveResult> {
  const name = requireName(raw);
  const description = requireString(raw, "description");
  const type = requireType(raw);
  const body = requireString(raw, "body");
  const replace = optionalBoolean(raw, "replace") ?? false;

  const result = await saveMemory({ name, description, type, body, replace });
  return { saved: true, path: result.entry.path, created: result.created };
}

export interface GetResult {
  meta: MemoryFrontmatter;
  body: string;
  path: string;
}

export async function handleMemoryGet(raw: Record<string, unknown>): Promise<GetResult> {
  const name = requireName(raw);
  const entry = await readMemory(name);
  return { meta: entry.meta, body: entry.body, path: entry.path };
}

export interface DeleteResult {
  deleted: true;
  path: string;
}

export async function handleMemoryDelete(raw: Record<string, unknown>): Promise<DeleteResult> {
  const name = requireName(raw);
  const { path: absPath } = await deleteMemory(name);
  return { deleted: true, path: absPath };
}

export async function handleMemorySearch(raw: Record<string, unknown>): Promise<unknown> {
  const query = requireString(raw, "query");
  const typeRaw = optionalString(raw, "type");
  if (typeRaw !== undefined && !isMemoryType(typeRaw)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `type filter must be one of: ${MEMORY_TYPES.join(", ")}`,
    );
  }
  const limit = optionalNumber(raw, "limit");
  const minScore = optionalNumber(raw, "min_score");

  const entries = await listMemoryEntries();
  return searchMemories(entries, query, {
    type: typeRaw as MemoryType | undefined,
    limit,
    min_score: minScore,
  });
}

// ---------------------------------------------------------------------------
// Handler map — consumed by mcp-server.ts dispatch.
// ---------------------------------------------------------------------------

type HandlerFn = (raw: Record<string, unknown>) => Promise<unknown>;

export const MEMORY_HANDLERS: Record<string, HandlerFn> = {
  memory_save: handleMemorySave,
  memory_search: handleMemorySearch,
  memory_get: handleMemoryGet,
  memory_delete: handleMemoryDelete,
};
