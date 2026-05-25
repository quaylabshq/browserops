/**
 * MCP tool handlers for the six memory_* tools (v2 shapes, Phase 4).
 *
 * Each handler validates raw params, calls into the in-process store
 * (v2 API: saveRecord / readRecord / deleteRecord / listRecords /
 * searchRecordsWithConfidence), and returns the output shape declared by the
 * matching ToolDef in packages/shared/src/tools.ts.
 *
 * memory_session_trace is a STUB returning {entries:[]} — the real
 * implementation follows in Phase 5.3 (trace buffer).
 *
 * Memory handlers are pure-filesystem — no wsBridge, no extension round-trip.
 */
import {
  MEMORY_NAME_REGEX,
  validateMemory,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
} from "@browserops/shared";
import {
  CodedError,
  checkRedaction,
  deleteRecord,
  listRecords,
  readRecord,
  saveRecord,
} from "./store.js";
import { searchRecordsWithConfidence } from "./search.js";
import type { TraceBuffer, TraceEntry } from "./trace.js";
import type { TabRegistry } from "../tab-registry.js";

// ---------------------------------------------------------------------------
// Param coercion helpers
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
// memory_save — v2: takes {record: MemoryRecord, merge_into?, replace?}
// ---------------------------------------------------------------------------

export interface SaveResult {
  saved: true;
  path: string;
  created: boolean;
  possible_duplicate?: { name: string; score: number };
}

export async function handleMemorySave(raw: Record<string, unknown>): Promise<SaveResult> {
  const recordRaw = raw["record"];
  if (typeof recordRaw !== "object" || recordRaw === null) {
    throw new CodedError("INVALID_PARAMS", "record must be an object");
  }
  const record = recordRaw as MemoryRecord;

  // validateMemory covers name-pattern, scope/origin, kind/detail coherence, caps
  const errs = validateMemory(record);
  if (errs.length > 0) {
    throw new CodedError(
      "MEMORY_SCHEMA_INVALID",
      `record validation failed: ${errs.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
    );
  }

  // Redaction guard (PII check)
  const piiError = checkRedaction(record);
  if (piiError) {
    throw new CodedError("MEMORY_PII_REJECTED", piiError);
  }

  const mergeInto = optionalString(raw, "merge_into");
  const replace = optionalBoolean(raw, "replace") ?? false;

  const result = await saveRecord({ record, merge_into: mergeInto, replace });

  return {
    saved: true,
    path: result.path,
    created: result.created,
    ...(result.possible_duplicate ? { possible_duplicate: result.possible_duplicate } : {}),
  };
}

// ---------------------------------------------------------------------------
// memory_search — v2: gains scope, origin, kind filters; results carry confidence
// ---------------------------------------------------------------------------

const VALID_SCOPES = new Set<string>(["global", "site"]);
const VALID_KINDS = new Set<string>(["blocker", "affordance", "gotcha", "selector", "lesson"]);

export async function handleMemorySearch(raw: Record<string, unknown>): Promise<unknown> {
  const query = requireString(raw, "query");

  const scopeRaw = optionalString(raw, "scope");
  if (scopeRaw !== undefined && !VALID_SCOPES.has(scopeRaw)) {
    throw new CodedError("INVALID_PARAMS", `scope must be "global" or "site"`);
  }
  const scope = scopeRaw as MemoryScope | undefined;

  const origin = optionalString(raw, "origin");

  const kindRaw = optionalString(raw, "kind");
  if (kindRaw !== undefined && !VALID_KINDS.has(kindRaw)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `kind must be one of: blocker, affordance, gotcha, selector, lesson`,
    );
  }
  const kind = kindRaw as MemoryKind | undefined;

  const limit = optionalNumber(raw, "limit");
  const minScore = optionalNumber(raw, "min_score");

  const records = await listRecords({ scope, origin });
  return searchRecordsWithConfidence(records, query, {
    scope,
    origin,
    kind,
    limit,
    min_score: minScore,
  });
}

// ---------------------------------------------------------------------------
// memory_get — v2: returns {record, path}
// ---------------------------------------------------------------------------

export interface GetResult {
  record: MemoryRecord;
  path: string;
}

export async function handleMemoryGet(raw: Record<string, unknown>): Promise<GetResult> {
  const name = requireName(raw);
  // v2 get: try global first, then fall back to searching across all scopes
  // by name. Since we don't receive scope/origin in the tool call for get,
  // search global first, then sites.
  let record: MemoryRecord;
  let resolvedPath: string;

  try {
    record = await readRecord(name, "global");
    const { globalRecordPath } = await import("./store.js");
    resolvedPath = globalRecordPath(name);
  } catch (err) {
    if ((err as { code?: string }).code !== "MEMORY_NOT_FOUND") throw err;
    // Search site stores
    const allRecords = await listRecords({ scope: "site" });
    const found = allRecords.find((r) => r.name === name);
    if (!found) {
      throw new CodedError("MEMORY_NOT_FOUND", `memory "${name}" not found`, { name });
    }
    record = found;
    const { originToSlug, siteRecordPath } = await import("./store.js");
    resolvedPath = siteRecordPath(originToSlug(found.origin ?? ""), name);
  }

  return { record, path: resolvedPath };
}

// ---------------------------------------------------------------------------
// memory_delete — v2: tries global first, then site scope by searching
// ---------------------------------------------------------------------------

export interface DeleteResult {
  deleted: true;
  path: string;
}

export async function handleMemoryDelete(raw: Record<string, unknown>): Promise<DeleteResult> {
  const name = requireName(raw);
  // Try global first
  try {
    const { path: absPath } = await deleteRecord(name, "global");
    return { deleted: true, path: absPath };
  } catch (err) {
    if ((err as { code?: string }).code !== "MEMORY_NOT_FOUND") throw err;
  }
  // Search site records for this name
  const allRecords = await listRecords({ scope: "site" });
  const found = allRecords.find((r) => r.name === name);
  if (!found) {
    throw new CodedError("MEMORY_NOT_FOUND", `memory "${name}" not found`, { name });
  }
  const { path: absPath } = await deleteRecord(name, "site", found.origin);
  return { deleted: true, path: absPath };
}

// ---------------------------------------------------------------------------
// memory_list_for_origin — list site-scoped records for a given origin
// ---------------------------------------------------------------------------

export interface ListForOriginResult {
  records: Array<{
    name: string;
    title: string;
    scope: MemoryScope;
    kind: MemoryKind;
    origin?: string;
    score: number;
    confidence: number;
    snippet: string;
  }>;
  total: number;
}

export async function handleMemoryListForOrigin(
  raw: Record<string, unknown>,
): Promise<ListForOriginResult> {
  const origin = requireString(raw, "origin");
  const kindRaw = optionalString(raw, "kind");
  if (kindRaw !== undefined && !VALID_KINDS.has(kindRaw)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `kind must be one of: blocker, affordance, gotcha, selector, lesson`,
    );
  }
  const kind = kindRaw as MemoryKind | undefined;
  const minConfidence = optionalNumber(raw, "min_confidence");
  const limitRaw = optionalNumber(raw, "limit");
  const limit = limitRaw !== undefined ? Math.min(100, Math.max(1, limitRaw)) : 20;

  const records = await listRecords({ scope: "site", origin });

  // Use searchRecordsWithConfidence with a wildcard query to get all records
  // ranked by confidence; apply kind filter and min_confidence threshold.
  const { confidence } = await import("./confidence.js");
  let filtered = records.filter((r) => r.origin === origin);
  if (kind !== undefined) filtered = filtered.filter((r) => r.kind === kind);

  // Rank by confidence descending
  const ranked = filtered
    .map((r) => ({ r, conf: confidence(r) }))
    .filter(({ conf }) => minConfidence === undefined || conf >= minConfidence)
    .sort((a, b) => b.conf - a.conf)
    .slice(0, limit);

  return {
    records: ranked.map(({ r, conf }) => ({
      name: r.name,
      title: r.title,
      scope: r.scope,
      kind: r.kind,
      origin: r.origin,
      score: 1,
      confidence: conf,
      snippet:
        (r.detail.note ?? r.detail.wall ?? r.detail.door ?? r.title)
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 120),
    })),
    total: filtered.length,
  };
}

// ---------------------------------------------------------------------------
// memory_session_trace — real implementation (Phase 5.3)
//
// Accepts {tab_id?, session_id?, limit?}.
//
//  • If session_id is given, it is used directly.
//  • If tab_id is given (and no session_id), the tab registry is consulted
//    to find the owning session. This allows the memory-scribe subagent
//    (which runs in its own session) to fetch the originating session's
//    trace by the tab_id the user already knows.
//  • If neither is given, returns an empty list.
// ---------------------------------------------------------------------------

export interface SessionTraceResult {
  entries: TraceEntry[];
  session_id?: string;
}

export function buildMemorySessionTraceHandler(
  traceBuffer: TraceBuffer | undefined,
  tabs: TabRegistry | undefined,
): (raw: Record<string, unknown>) => Promise<SessionTraceResult> {
  return async function handleMemorySessionTrace(
    raw: Record<string, unknown>,
  ): Promise<SessionTraceResult> {
    const limit = optionalNumber(raw, "limit");

    // Resolve session_id
    let sessionId = optionalString(raw, "session_id");
    const tabId = optionalString(raw, "tab_id");

    if (!sessionId && tabId && tabs) {
      // Look up the tab record to find its owning session.
      const rec = tabs.get(tabId);
      if (rec?.owner_session_id) {
        sessionId = rec.owner_session_id;
      }
    }

    if (!sessionId || !traceBuffer) {
      return { entries: [] };
    }

    const entries = traceBuffer.recent(sessionId, limit ?? 50);
    return { entries, session_id: sessionId };
  };
}

// ---------------------------------------------------------------------------
// Handler map — consumed by mcp-server.ts dispatch.
// ---------------------------------------------------------------------------

type HandlerFn = (raw: Record<string, unknown>) => Promise<unknown>;

/**
 * Build the full memory handler map, wiring the real session-trace handler
 * when traceBuffer and tabs are provided.
 */
export function buildMemoryHandlers(
  traceBuffer?: TraceBuffer,
  tabs?: TabRegistry,
): Record<string, HandlerFn> {
  return {
    memory_save: handleMemorySave,
    memory_search: handleMemorySearch,
    memory_get: handleMemoryGet,
    memory_delete: handleMemoryDelete,
    memory_list_for_origin: handleMemoryListForOrigin,
    memory_session_trace: buildMemorySessionTraceHandler(traceBuffer, tabs),
  };
}

/**
 * Default handler map (no trace buffer — stub returns empty).
 * Kept for backwards compat with tests that import MEMORY_HANDLERS directly.
 */
export const MEMORY_HANDLERS: Record<string, HandlerFn> = buildMemoryHandlers();
