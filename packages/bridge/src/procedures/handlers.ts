/**
 * MCP tool handlers for the six procedures_* tools.
 *
 * Each handler:
 *  1. Validates and coerces raw params — throws CodedError("INVALID_PARAMS") on bad shape.
 *  2. Calls ensureIndex() to get a fresh manifest (cheap mtime check).
 *  3. Performs the operation.
 *  4. Returns the exact output shape specified in
 *
 * YAML round-trip decision (handleSave):
 *   We inject the server-controlled `meta` block into the parsed YAML object
 *   and re-stringify via yaml.stringify(). This normalizes whitespace and
 *   ensures meta fields are always present in the stored file. The trade-off
 *   is that callers may see different formatting on round-trip. Chosen because:
 *   (a) correctness is more important than preserving cosmetic whitespace, and
 *   (b) any future version bump or meta mutation is safe via this path.
 *   If this causes friction, a targeted meta-only injection (splice the block)
 *   is the migration path — the caller API is stable either way.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";
import {
  proceduresRoot,
  procedureYamlPath,
} from "./paths.js";
import {
  CodedError,
  readProcedureYaml,
  writeProcedureYamlAtomic,
  deleteProcedureDir,
  moveProcedureDir,
} from "./store.js";
import {
  ensureIndex,
  buildIndex,
  writeIndex,
  type ManifestEntry,
  type Manifest,
} from "./index-builder.js";
import { validateProcedure } from "./validator.js";
import { validateBindings } from "./binding-validator.js";
import { search } from "./search.js";
import type { SearchOptions } from "./search.js";

// ---------------------------------------------------------------------------
// Name pattern (mirrors the JSON-Schema in packages/shared)
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/;

function assertName(value: unknown, field = "name"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CodedError("INVALID_PARAMS", `${field} must be a non-empty string`);
  }
  if (!NAME_PATTERN.test(value)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `${field} must match pattern ^[a-z][a-z0-9_.-]{0,79}$ — got: ${value}`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Entry shape returned by list / search (no tokens, path, or owner)
// ---------------------------------------------------------------------------

export interface ProcedureEntry {
  name: string;
  kind: "leaf" | "composite";
  domain?: string;
  description: string;
  inputs: string[];
  triggers: string[];
  tags: string[];
  usedBy?: string[];
}

function toEntry(name: string, entry: ManifestEntry): ProcedureEntry {
  const out: ProcedureEntry = {
    name,
    kind: entry.kind,
    description: entry.description,
    inputs: entry.inputs,
    triggers: entry.triggers,
    tags: entry.tags,
  };
  if (entry.domain !== null) {
    out.domain = entry.domain;
  }
  if (entry.usedBy && entry.usedBy.length > 0) {
    out.usedBy = entry.usedBy;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scope filter (mirrored from search.ts)
// ---------------------------------------------------------------------------

function isShared(entry: ManifestEntry): boolean {
  return entry.owner === null && entry.path.startsWith("shared/");
}

function passesScopeFilter(
  entryName: string,
  entry: ManifestEntry,
  scope: "all" | "shared" | string,
): boolean {
  if (scope === "all") return true;
  if (scope === "shared") return isShared(entry);
  // "composite:X" form
  if (scope.startsWith("composite:")) {
    const compositeName = scope.slice("composite:".length);
    return entryName === compositeName || entry.owner === compositeName;
  }
  return true;
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

// ---- handleList ----

export interface ListResult {
  tree: {
    shared: ProcedureEntry[];
    composites: Record<string, { composite: ProcedureEntry; subs: ProcedureEntry[] }>;
  };
}

export async function handleList(raw: Record<string, unknown>): Promise<ListResult> {
  // Validate optional params
  const scope =
    raw["scope"] !== undefined
      ? (() => {
          const s = raw["scope"];
          if (typeof s !== "string") {
            throw new CodedError("INVALID_PARAMS", "scope must be a string");
          }
          if (s !== "all" && s !== "shared" && !s.startsWith("composite:")) {
            throw new CodedError(
              "INVALID_PARAMS",
              `scope must be "all", "shared", or "composite:<name>"`,
            );
          }
          return s;
        })()
      : "all";

  const domain =
    raw["domain"] !== undefined
      ? (() => {
          const d = raw["domain"];
          if (typeof d !== "string") {
            throw new CodedError("INVALID_PARAMS", "domain must be a string");
          }
          return d;
        })()
      : undefined;

  const manifest = await ensureIndex(proceduresRoot());

  const shared: ProcedureEntry[] = [];
  const composites: Record<string, { composite: ProcedureEntry; subs: ProcedureEntry[] }> = {};

  for (const [name, entry] of Object.entries(manifest.procedures)) {
    // Apply scope filter
    if (!passesScopeFilter(name, entry, scope)) continue;

    // Apply domain filter
    if (domain !== undefined && entry.domain !== domain) continue;

    if (isShared(entry) && entry.kind !== "composite") {
      // Top-level shared leaf
      shared.push(toEntry(name, entry));
    } else if (isShared(entry) && entry.kind === "composite") {
      // Shared composites — treat as standalone in shared list
      shared.push(toEntry(name, entry));
    } else if (entry.owner === null && !isShared(entry)) {
      // Top-level composite (path like "email_posthog_users/procedure.yaml")
      if (!composites[name]) {
        composites[name] = { composite: toEntry(name, entry), subs: [] };
      } else {
        composites[name]!.composite = toEntry(name, entry);
      }
    } else if (entry.owner !== null) {
      // Sub-procedure — place under owner composite
      const owner = entry.owner;
      if (!composites[owner]) {
        // Owner might not have been visited yet or filtered out
        composites[owner] = {
          composite: { name: owner, kind: "composite", description: "", inputs: [], triggers: [], tags: [] },
          subs: [],
        };
      }
      composites[owner]!.subs.push(toEntry(name, entry));
    }
  }

  // If scope is "composite:X", prune composites that aren't X
  if (scope.startsWith("composite:")) {
    const compositeName = scope.slice("composite:".length);
    for (const key of Object.keys(composites)) {
      if (key !== compositeName) {
        delete composites[key];
      }
    }
  }

  return { tree: { shared, composites } };
}

// ---- handleSearch ----

export async function handleSearch(raw: Record<string, unknown>): Promise<unknown> {
  const query = raw["query"];
  if (typeof query !== "string") {
    throw new CodedError("INVALID_PARAMS", "query must be a string");
  }
  if (query.trim() === "") {
    throw new CodedError("INVALID_PARAMS", "query must not be empty");
  }

  const options: SearchOptions = {};

  if (raw["limit"] !== undefined) {
    if (typeof raw["limit"] !== "number") {
      throw new CodedError("INVALID_PARAMS", "limit must be a number");
    }
    options.limit = raw["limit"] as number;
  }
  if (raw["min_score"] !== undefined) {
    if (typeof raw["min_score"] !== "number") {
      throw new CodedError("INVALID_PARAMS", "min_score must be a number");
    }
    options.min_score = raw["min_score"] as number;
  }
  if (raw["domain"] !== undefined) {
    if (typeof raw["domain"] !== "string") {
      throw new CodedError("INVALID_PARAMS", "domain must be a string");
    }
    options.domain = raw["domain"] as string;
  }
  if (raw["scope"] !== undefined) {
    if (typeof raw["scope"] !== "string") {
      throw new CodedError("INVALID_PARAMS", "scope must be a string");
    }
    options.scope = raw["scope"] as SearchOptions["scope"];
  }
  if (raw["deep"] !== undefined) {
    if (typeof raw["deep"] !== "boolean") {
      throw new CodedError("INVALID_PARAMS", "deep must be a boolean");
    }
    options.deep = raw["deep"] as boolean;
  }

  const root = proceduresRoot();
  const manifest = await ensureIndex(root);
  return search(root, manifest, query, options);
}

// ---- handleGet ----

interface ProcedureMeta {
  version: number;
  created: string;
  last_verified: string;
  success_count: number;
  failure_count: number;
}

export interface GetResult {
  yaml: string;
  path: string;
  meta: ProcedureMeta;
}

export async function handleGet(raw: Record<string, unknown>): Promise<GetResult> {
  const name = assertName(raw["name"]);

  const manifest = await ensureIndex(proceduresRoot());
  const entry = manifest.procedures[name];
  if (!entry) {
    throw new CodedError("PROC_NOT_FOUND", `procedure not found: ${name}`, { name });
  }

  const absPath = path.join(proceduresRoot(), entry.path);
  const yamlText = await readProcedureYaml(absPath);

  // Get mtime for default timestamps
  let defaultTs: string;
  try {
    const stat = await fs.stat(absPath);
    defaultTs = stat.mtime.toISOString();
  } catch {
    defaultTs = new Date().toISOString();
  }

  // Parse to extract meta fields
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (e) {
    throw new CodedError(
      "PROC_SCHEMA_INVALID",
      `YAML parse error: ${(e as Error).message}`,
      { name },
    );
  }

  const meta = extractMeta(parsed, defaultTs);

  return {
    yaml: yamlText,
    path: entry.path,
    meta,
  };
}

function extractMeta(parsed: unknown, defaultTs: string): ProcedureMeta {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("meta" in parsed) ||
    typeof (parsed as Record<string, unknown>)["meta"] !== "object" ||
    (parsed as Record<string, unknown>)["meta"] === null
  ) {
    return {
      version: 1,
      created: defaultTs,
      last_verified: defaultTs,
      success_count: 0,
      failure_count: 0,
    };
  }

  const m = (parsed as Record<string, unknown>)["meta"] as Record<string, unknown>;
  return {
    version: typeof m["version"] === "number" ? m["version"] : 1,
    created: typeof m["created"] === "string" ? m["created"] : defaultTs,
    last_verified: typeof m["last_verified"] === "string" ? m["last_verified"] : defaultTs,
    success_count: typeof m["success_count"] === "number" ? m["success_count"] : 0,
    failure_count: typeof m["failure_count"] === "number" ? m["failure_count"] : 0,
  };
}

// ---- handleSave ----

export interface SaveResult {
  saved: true;
  path: string;
  version: number;
}

export async function handleSave(raw: Record<string, unknown>): Promise<SaveResult> {
  const name = assertName(raw["name"]);

  const yamlInput = raw["yaml"];
  if (typeof yamlInput !== "string") {
    throw new CodedError("INVALID_PARAMS", "yaml must be a string");
  }
  if (yamlInput.length > 65536) {
    throw new CodedError("INVALID_PARAMS", "yaml exceeds maximum length of 65536 characters");
  }

  const owner =
    raw["owner"] !== undefined
      ? (() => {
          const o = raw["owner"];
          if (typeof o !== "string") {
            throw new CodedError("INVALID_PARAMS", "owner must be a string");
          }
          return assertName(o, "owner");
        })()
      : undefined;

  const overwrite =
    raw["overwrite"] !== undefined
      ? (() => {
          const ov = raw["overwrite"];
          if (typeof ov !== "boolean") {
            throw new CodedError("INVALID_PARAMS", "overwrite must be a boolean");
          }
          return ov;
        })()
      : false;

  // Parse YAML
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlInput);
  } catch (e) {
    throw new CodedError(
      "PROC_SCHEMA_INVALID",
      `YAML parse error: ${(e as Error).message}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new CodedError("PROC_SCHEMA_INVALID", "parsed YAML must be an object");
  }

  // Assert name field matches
  const parsedName = (parsed as Record<string, unknown>)["name"];
  if (parsedName !== name) {
    throw new CodedError(
      "PROC_SCHEMA_INVALID",
      `name field in YAML (${String(parsedName)}) must match input name (${name})`,
    );
  }

  // Validate schema
  const validation = validateProcedure(parsed);
  if (!validation.valid) {
    const msgs = (validation.errors ?? []).join("; ");
    throw new CodedError("PROC_SCHEMA_INVALID", `schema validation failed: ${msgs}`);
  }

  // Validate {{...}} binding references against tool outputSchemas
  const bindingResult = validateBindings(parsed);
  if (!bindingResult.valid) {
    const msgs = (bindingResult.errors ?? [])
      .map((e) => `${e.instancePath} ${e.message}`)
      .join("; ");
    throw new CodedError("PROC_SCHEMA_INVALID", `binding validation failed: ${msgs}`);
  }

  const manifest = await ensureIndex(proceduresRoot());

  // Validate owner if provided
  if (owner !== undefined) {
    const ownerEntry = manifest.procedures[owner];
    if (!ownerEntry || ownerEntry.kind !== "composite") {
      throw new CodedError(
        "PROC_OWNER_INVALID",
        `owner "${owner}" does not exist or is not a composite procedure`,
        { owner },
      );
    }
  }

  // Compute target path
  const targetPath = procedureYamlPath(owner ?? null, name);
  const relPath = path.relative(proceduresRoot(), targetPath);

  // Check for existing procedure
  let fileExists = false;
  try {
    await fs.access(targetPath);
    fileExists = true;
  } catch {
    // File doesn't exist — ok
  }

  if (fileExists && !overwrite) {
    throw new CodedError(
      "PROC_ALREADY_EXISTS",
      `procedure already exists at ${relPath} — set overwrite: true to replace`,
      { path: relPath },
    );
  }

  // Validate uses references
  const parsedObj = parsed as Record<string, unknown>;
  if (Array.isArray(parsedObj["uses"])) {
    for (const ref of parsedObj["uses"] as unknown[]) {
      if (typeof ref !== "string") continue;

      // Resolution: for a sub (owner != null), check local subs first, then shared
      let resolved = false;
      if (owner !== undefined) {
        // Check if ref exists as a sub of this composite
        const refEntry = manifest.procedures[ref];
        if (refEntry && refEntry.owner === owner) {
          resolved = true;
        }
      }
      if (!resolved) {
        // Check if ref exists anywhere in manifest
        const refEntry = manifest.procedures[ref];
        if (refEntry) {
          resolved = true;
        }
      }

      if (!resolved) {
        throw new CodedError(
          "PROC_NOT_FOUND",
          `uses: references unknown procedure "${ref}"`,
          { ref },
        );
      }
    }
  }

  // Compute meta
  const now = new Date().toISOString();
  let newMeta: ProcedureMeta;

  if (fileExists && overwrite) {
    // Read existing meta
    let priorMeta: ProcedureMeta;
    try {
      const priorText = await readProcedureYaml(targetPath);
      const priorParsed = YAML.parse(priorText);
      let priorDefaultTs: string;
      try {
        const stat = await fs.stat(targetPath);
        priorDefaultTs = stat.mtime.toISOString();
      } catch {
        priorDefaultTs = now;
      }
      priorMeta = extractMeta(priorParsed, priorDefaultTs);
    } catch {
      priorMeta = { version: 1, created: now, last_verified: now, success_count: 0, failure_count: 0 };
    }
    newMeta = {
      version: priorMeta.version + 1,
      created: priorMeta.created,
      last_verified: now,
      success_count: priorMeta.success_count,
      failure_count: priorMeta.failure_count,
    };
  } else {
    newMeta = {
      version: 1,
      created: now,
      last_verified: now,
      success_count: 0,
      failure_count: 0,
    };
  }

  // Inject meta into parsed object and re-stringify (round-trip)
  // Caller-supplied meta is overwritten with server-controlled values.
  (parsedObj as Record<string, unknown>)["meta"] = newMeta;
  const finalYaml = YAML.stringify(parsedObj);

  await writeProcedureYamlAtomic(targetPath, finalYaml);

  // Rebuild index
  const newManifest = await buildIndex(proceduresRoot());
  await writeIndex(proceduresRoot(), newManifest);

  return { saved: true, path: relPath, version: newMeta.version };
}

// ---- handlePromote ----

export interface PromoteResult {
  promoted: true;
  old_path: string;
  new_path: string;
  rewrote: string[];
}

export async function handlePromote(raw: Record<string, unknown>): Promise<PromoteResult> {
  const name = assertName(raw["name"]);
  const fromOwner = assertName(raw["from_owner"], "from_owner");

  const manifest = await ensureIndex(proceduresRoot());
  const entry = manifest.procedures[name];

  if (!entry) {
    throw new CodedError("PROC_NOT_FOUND", `procedure not found: ${name}`, { name });
  }

  if (entry.owner !== fromOwner) {
    throw new CodedError(
      "PROC_OWNER_INVALID",
      `procedure "${name}" is not owned by "${fromOwner}" (actual owner: ${entry.owner ?? "none"})`,
      { name, from_owner: fromOwner, actual_owner: entry.owner },
    );
  }

  const fromPath = procedureYamlPath(fromOwner, name);
  const toPath = procedureYamlPath(null, name);
  const fromDir = path.dirname(fromPath);
  const toDir = path.dirname(toPath);

  const oldRelPath = path.relative(proceduresRoot(), fromPath);
  const newRelPath = path.relative(proceduresRoot(), toPath);

  // Move the directory
  await moveProcedureDir(fromDir, toDir);

  // Check owner's uses: for this sub — log a warning if not found (v1 behavior)
  const ownerEntry = manifest.procedures[fromOwner];
  if (ownerEntry && ownerEntry.uses) {
    if (!ownerEntry.uses.includes(name)) {
      process.stderr.write(
        `[procedures] warn: promoted "${name}" from "${fromOwner}" but owner's uses: does not include it\n`,
      );
    }
    // In v1: name doesn't change on promotion, so uses: stays the same.
    // No rewrite needed.
  }

  // Rebuild index
  const newManifest = await buildIndex(proceduresRoot());
  await writeIndex(proceduresRoot(), newManifest);

  return {
    promoted: true,
    old_path: oldRelPath,
    new_path: newRelPath,
    rewrote: [], // v1: names don't change on promotion, so no rewrite needed
  };
}

// ---- handleDelete ----

export interface DeleteResult {
  deleted: true;
  path: string;
}

export async function handleDelete(raw: Record<string, unknown>): Promise<DeleteResult> {
  const name = assertName(raw["name"]);

  const force =
    raw["force"] !== undefined
      ? (() => {
          const f = raw["force"];
          if (typeof f !== "boolean") {
            throw new CodedError("INVALID_PARAMS", "force must be a boolean");
          }
          return f;
        })()
      : false;

  const manifest = await ensureIndex(proceduresRoot());
  const entry = manifest.procedures[name];

  if (!entry) {
    throw new CodedError("PROC_NOT_FOUND", `procedure not found: ${name}`, { name });
  }

  // Check for referrers (usedBy)
  if (!force && entry.usedBy && entry.usedBy.length > 0) {
    throw new CodedError(
      "PROC_IN_USE",
      `procedure "${name}" is referenced by: ${entry.usedBy.join(", ")}. Use force: true to delete anyway.`,
      { name, referrers: entry.usedBy },
    );
  }

  const absYamlPath = procedureYamlPath(entry.owner, name);
  const absDirPath = path.dirname(absYamlPath);
  const relPath = entry.path;

  // cascade=true: composites own their subs
  await deleteProcedureDir(absDirPath, true);

  // Rebuild index
  const newManifest = await buildIndex(proceduresRoot());
  await writeIndex(proceduresRoot(), newManifest);

  return { deleted: true, path: relPath };
}

// ---------------------------------------------------------------------------
// Handler map
// ---------------------------------------------------------------------------

type HandlerFn = (raw: Record<string, unknown>) => Promise<unknown>;

export const PROCEDURE_HANDLERS: Record<string, HandlerFn> = {
  "procedures_list": handleList,
  "procedures_search": handleSearch,
  "procedures_get": handleGet,
  "procedures_save": handleSave,
  "procedures_promote": handlePromote,
  "procedures_delete": handleDelete,
};

/**
 * Registers procedure handlers via a callback.
 *
 * The callback receives the handler name and function, mirroring how
 * mcp-server.ts can build its dispatch map.
 */
export function registerProcedureHandlers(
  registerFn: (name: string, handler: HandlerFn) => void,
): void {
  for (const [name, fn] of Object.entries(PROCEDURE_HANDLERS)) {
    registerFn(name, fn);
  }
}
