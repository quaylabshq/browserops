/**
 * Filesystem store for the cross-agent memory.
 *
 * Layout (v2):
 *   <root>/global/<name>.yaml          — cross-site records (scope: global)
 *   <root>/sites/<origin-slug>/<name>.yaml — per-site records (scope: site)
 *   <root>/index.json                  — origin → [names], global → [names], confidence map
 *
 * Legacy markdown files at <root>/*.md are still readable (for migration in 2.4)
 * but all NEW writes use YAML MemoryRecord files in the two-store layout.
 *
 * All reads/writes go through this module.
 */
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  MEMORY_NAME_REGEX,
  MEMORY_TYPES,
  isMemoryType,
  tokenize,
  validateMemory,
  type MemoryEntry,
  type MemoryFrontmatter,
  type MemoryRecord,
  type MemoryType,
} from "@browserops/shared";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Root directory for memory storage. Overridable via
 * BROWSEROPS_MEMORY_DIR. Read at call time so tests can flip the env
 * var in beforeEach.
 */
function memoryRoot(): string {
  return (
    process.env["BROWSEROPS_MEMORY_DIR"] ??
    path.join(os.homedir(), "browserops", "memory")
  );
}

export function memoriesRoot(): string {
  return memoryRoot();
}

/** Legacy path: used for reading old .md files and by legacy tests. */
export function memoryFilePath(name: string): string {
  return path.join(memoryRoot(), `${name}.md`);
}

/** Path for a v2 YAML record in the global store. */
export function globalRecordPath(name: string): string {
  return path.join(memoryRoot(), "global", `${name}.yaml`);
}

/** Path for a v2 YAML record in the site store. */
export function siteRecordPath(originSlug: string, name: string): string {
  return path.join(memoryRoot(), "sites", originSlug, `${name}.yaml`);
}

/** Path for the index manifest. */
export function indexPath(): string {
  return path.join(memoryRoot(), "index.json");
}

/**
 * Compute an origin slug from a URL origin string (scheme://host[:port]).
 * `.` and `:` are replaced with `-`.
 * e.g. "https://www.notion.so" → "www-notion-so"
 *      "http://localhost:3000" → "localhost-3000"
 */
export function originToSlug(origin: string): string {
  // Strip scheme (e.g. "https://")
  const withoutScheme = origin.replace(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//, "");
  // Replace dots and colons with dashes
  return withoutScheme.replace(/[.:]/g, "-");
}

// ---------------------------------------------------------------------------
// CodedError — same shape the bridge's extractErrorCode helper reads.
// ---------------------------------------------------------------------------

export class CodedError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "CodedError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Write mutex — serialize concurrent writes so two MCP sessions saving
// different memories don't race on mkdir + atomic-rename of the same dir.
// Reads stay outside the chain (atomic rename makes them safe).
// ---------------------------------------------------------------------------

let writeChain: Promise<void> = Promise.resolve();
export function withWriteLock<T>(op: () => Promise<T>): Promise<T> {
  const prev = writeChain;
  let release!: () => void;
  writeChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  return prev.then(async () => {
    try {
      return await op();
    } finally {
      release();
    }
  });
}

/** Internal write without the serialize lock — use only inside withWriteLock. */
async function atomicWriteFileInner(absPath: string, text: string): Promise<void> {
  const dir = path.dirname(absPath);
  const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(tmpPath, text, "utf8");
    await fs.rename(tmpPath, absPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    const nodeErr = err as NodeJS.ErrnoException;
    throw new CodedError(
      "INTERNAL",
      `failed to write memory: ${absPath}: ${nodeErr.message}`,
      { path: absPath, cause: nodeErr.code },
    );
  }
}

export async function atomicWriteFile(absPath: string, text: string): Promise<void> {
  return withWriteLock(() => atomicWriteFileInner(absPath, text));
}

// ---------------------------------------------------------------------------
// Index manifest
// ---------------------------------------------------------------------------

export interface MemoryIndex {
  /** global record names */
  global: string[];
  /** origin slug → list of record names */
  origins: Record<string, string[]>;
  /**
   * name → confidence score [0,1].
   * Optional / defaulted: Phase 3.2 populates this; Phase 2 omits or defaults 0.
   */
  confidence: Record<string, number>;
}

async function readIndex(): Promise<MemoryIndex> {
  const p = indexPath();
  try {
    const text = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(text) as Partial<MemoryIndex>;
    return {
      global: parsed.global ?? [],
      origins: parsed.origins ?? {},
      confidence: parsed.confidence ?? {},
    };
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      return { global: [], origins: {}, confidence: {} };
    }
    throw new CodedError(
      "INTERNAL",
      `failed to read memory index: ${nodeErr.message}`,
      { path: p, cause: nodeErr.code },
    );
  }
}

/** Write the index — must be called inside withWriteLock. */
async function writeIndexInner(index: MemoryIndex): Promise<void> {
  const p = indexPath();
  const text = JSON.stringify(index, null, 2) + "\n";
  await atomicWriteFileInner(p, text);
}

/**
 * Inner rebuild — must be called inside withWriteLock.
 * Scans global/ and sites/ directories and writes the index atomically.
 */
async function rebuildIndexInner(): Promise<MemoryIndex> {
  const root = memoryRoot();
  const existing = await readIndex();
  const index: MemoryIndex = {
    global: [],
    origins: {},
    confidence: existing.confidence,
  };

  // Scan global/
  const globalDir = path.join(root, "global");
  try {
    const files = await fs.readdir(globalDir);
    for (const f of files) {
      if (!f.endsWith(".yaml")) continue;
      const name = f.slice(0, -5);
      if (MEMORY_NAME_REGEX.test(name)) index.global.push(name);
    }
    index.global.sort();
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== "ENOENT") throw err;
  }

  // Scan sites/
  const sitesDir = path.join(root, "sites");
  try {
    const slugDirs = await fs.readdir(sitesDir);
    for (const slug of slugDirs) {
      const slugDir = path.join(sitesDir, slug);
      let stat: Stats | undefined;
      try {
        stat = await fs.stat(slugDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      const files = await fs.readdir(slugDir);
      const names: string[] = [];
      for (const f of files) {
        if (!f.endsWith(".yaml")) continue;
        const name = f.slice(0, -5);
        if (MEMORY_NAME_REGEX.test(name)) names.push(name);
      }
      if (names.length > 0) {
        names.sort();
        index.origins[slug] = names;
      }
    }
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== "ENOENT") throw err;
  }

  await writeIndexInner(index);
  return index;
}

/**
 * Public: rebuild the index, acquiring the write lock.
 * Does not touch confidence (those are computed by Phase 3).
 */
export async function rebuildIndex(): Promise<MemoryIndex> {
  return withWriteLock(() => rebuildIndexInner());
}

// ---------------------------------------------------------------------------
// v2 YAML record (de)serialization
// ---------------------------------------------------------------------------

function serializeRecord(record: MemoryRecord): string {
  return YAML.stringify(record, { lineWidth: 0 });
}

function parseRecord(text: string, absPath: string): MemoryRecord {
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (err) {
    throw new CodedError(
      "MEMORY_SCHEMA_INVALID",
      `YAML parse error in ${absPath}: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CodedError(
      "MEMORY_SCHEMA_INVALID",
      `memory record at ${absPath} must be a YAML object`,
    );
  }
  const record = parsed as MemoryRecord;
  if (record.schema_version !== 1) {
    throw new CodedError(
      "MEMORY_SCHEMA_INVALID",
      `unsupported schema_version in ${absPath}: expected 1`,
    );
  }
  const errs = validateMemory(record);
  if (errs.length > 0) {
    throw new CodedError(
      "MEMORY_SCHEMA_INVALID",
      `memory record at ${absPath} failed validation: ${errs.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// Path resolution for v2 records
// ---------------------------------------------------------------------------

export function recordFilePath(record: Pick<MemoryRecord, "scope" | "name" | "origin">): string {
  if (record.scope === "site" && record.origin) {
    const slug = originToSlug(record.origin);
    return siteRecordPath(slug, record.name);
  }
  return globalRecordPath(record.name);
}

// ---------------------------------------------------------------------------
// Dedup helpers
// ---------------------------------------------------------------------------

const DEDUP_THRESHOLD = 0.8;

/** Extract the searchable text from a MemoryRecord for similarity comparison. */
function recordText(r: MemoryRecord): string {
  const parts: string[] = [r.title];
  if (r.detail.wall) parts.push(r.detail.wall);
  if (r.detail.door) parts.push(r.detail.door);
  if (r.detail.note) parts.push(r.detail.note);
  if (r.tags) parts.push(...r.tags);
  return parts.join(" ");
}

function tokenSet(s: string): Set<string> {
  return new Set(tokenize(s));
}

/**
 * Jaccard-style similarity over token sets.
 * score = |intersection| / |union|
 */
function tokenSimilarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) {
    if (sb.has(t)) intersection++;
  }
  const union = sa.size + sb.size - intersection;
  return intersection / union;
}

/**
 * Find a possible duplicate among existing records with the same scope+origin.
 * Returns the best candidate above the threshold, or null if none found.
 */
async function findDuplicate(
  incoming: MemoryRecord,
): Promise<{ name: string; score: number } | null> {
  const existing = await listRecords({
    scope: incoming.scope,
    origin: incoming.origin,
  });
  const incomingText = recordText(incoming);
  let best: { name: string; score: number } | null = null;
  for (const rec of existing) {
    if (rec.name === incoming.name) continue; // same name = same file, not a dup
    const score = tokenSimilarity(incomingText, recordText(rec));
    if (score >= DEDUP_THRESHOLD) {
      if (!best || score > best.score) {
        best = { name: rec.name, score };
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Redaction guard
// ---------------------------------------------------------------------------

/** Email-shaped pattern: non-whitespace @ non-whitespace . non-whitespace */
const EMAIL_PATTERN = /\S+@\S+\.\S+/;

/** 7+ consecutive digits (phone numbers, credit cards, SSNs, etc.) */
const LONG_DIGIT_PATTERN = /\d{7,}/;

/**
 * Secrets/tokens: looks like a bearer token, API key, or high-entropy hex/base64.
 * Matches: "Bearer <token>", "sk-...", "ghp_...", hex runs ≥32 chars,
 * base64-like strings ≥40 chars.
 */
const SECRET_PATTERNS = [
  /Bearer\s+\S{8,}/i,
  /\bsk-[A-Za-z0-9]{8,}/,
  /\bghp_[A-Za-z0-9]{8,}/,
  /\bxoxb-[A-Za-z0-9-]{8,}/i,
  /\b[0-9a-f]{32,}\b/i,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
];

/** All detail string fields to scan. */
function detailStrings(record: MemoryRecord): string[] {
  const strs: string[] = [];
  if (record.detail.wall) strs.push(record.detail.wall);
  if (record.detail.door) strs.push(record.detail.door);
  if (record.detail.note) strs.push(record.detail.note);
  if (record.title) strs.push(record.title);
  return strs;
}

/**
 * Validate that a MemoryRecord does not contain PII or secrets.
 * Returns an error message string if rejected, or null if clean.
 */
export function checkRedaction(record: MemoryRecord): string | null {
  const texts = detailStrings(record);
  for (const text of texts) {
    if (EMAIL_PATTERN.test(text)) {
      return `record contains an email address in a detail field — remove PII before saving`;
    }
    if (LONG_DIGIT_PATTERN.test(text)) {
      return `record contains a long digit run (≥7 digits) in a detail field — likely a phone/card/ID number; remove PII`;
    }
    for (const pat of SECRET_PATTERNS) {
      if (pat.test(text)) {
        return `record contains what appears to be a secret or API token in a detail field — do not store credentials`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// v2 CRUD
// ---------------------------------------------------------------------------

export interface SaveRecordArgs {
  record: MemoryRecord;
  /** When true, overwrite an existing record; otherwise rejects with MEMORY_ALREADY_EXISTS. */
  replace?: boolean;
  /**
   * Name of an existing record to merge this into.
   * Bumps stats.captures, refines title/detail/tags fields.
   */
  merge_into?: string;
}

export interface SaveRecordResult {
  record: MemoryRecord;
  path: string;
  created: boolean;
  /** Present when a possible duplicate was detected and merge_into was not provided. */
  possible_duplicate?: { name: string; score: number };
}

export async function saveRecord(args: SaveRecordArgs): Promise<SaveRecordResult> {
  const { record, replace = false, merge_into } = args;

  // Validate the record
  const errors = validateMemory(record);
  if (errors.length > 0) {
    throw new CodedError(
      "INVALID_PARAMS",
      `record validation failed: ${errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`,
    );
  }

  // Redaction guard
  const piiError = checkRedaction(record);
  if (piiError) {
    throw new CodedError("MEMORY_PII_REJECTED", piiError);
  }

  const now = new Date().toISOString();

  if (merge_into) {
    // Merge path: load the target record, update fields, bump captures
    const target = await readRecord(merge_into, record.scope, record.origin);
    const merged: MemoryRecord = {
      ...target,
      // Update fields from the new record
      title: record.title ?? target.title,
      severity: record.severity ?? target.severity,
      tags: record.tags ?? target.tags,
      detail: { ...target.detail, ...record.detail },
      links: record.links ?? target.links,
      stats: {
        hits: target.stats?.hits ?? 0,
        resolved: target.stats?.resolved ?? 0,
        door_failures: target.stats?.door_failures ?? 0,
        captures: (target.stats?.captures ?? 0) + 1,
        last_hit: target.stats?.last_hit,
        last_resolved: target.stats?.last_resolved,
      },
      meta: {
        version: (target.meta?.version ?? 1) + 1,
        created: target.meta?.created ?? now,
        updated: now,
        source: record.meta?.source ?? target.meta?.source ?? "mcp-tool",
        corroborated:
          ((target.stats?.captures ?? 0) + 1) >= 2 ? true : target.meta?.corroborated,
      },
    };
    const absPath = recordFilePath(merged);
    await withWriteLock(async () => {
      await atomicWriteFileInner(absPath, serializeRecord(merged));
      await rebuildIndexInner();
    });
    return { record: merged, path: absPath, created: false };
  }

  const absPath = recordFilePath(record);
  const existed = await fileExists(absPath);

  if (existed && !replace) {
    throw new CodedError(
      "MEMORY_ALREADY_EXISTS",
      `memory "${record.name}" already exists; pass replace:true to overwrite`,
      { name: record.name, path: absPath },
    );
  }

  // Dedup check: only on CREATE (not overwrite), and only when not already
  // naming a merge target. Skip if the name itself already exists (handled above).
  if (!existed && !replace) {
    const dup = await findDuplicate(record);
    if (dup) {
      return {
        record,
        path: absPath,
        created: false,
        possible_duplicate: dup,
      };
    }
  }

  // Preserve created timestamp:
  // 1. On overwrite: read the previous record's created timestamp.
  // 2. On create with an explicit meta.created in the incoming record: honour it.
  // 3. Otherwise: use now.
  let createdAt = record.meta?.created ?? now;
  if (existed) {
    try {
      const prev = await readRecord(record.name, record.scope, record.origin);
      createdAt = prev.meta?.created ?? createdAt;
    } catch {
      // Existing file unreadable — fall through to the incoming or fresh timestamp.
    }
  }

  const toWrite: MemoryRecord = {
    ...record,
    stats: record.stats ?? {
      hits: 0,
      resolved: 0,
      door_failures: 0,
      captures: 0,
    },
    meta: {
      version: existed ? ((record.meta?.version ?? 1) + 1) : 1,
      created: createdAt,
      updated: now,
      source: record.meta?.source ?? "mcp-tool",
      corroborated: record.meta?.corroborated,
    },
  };

  await withWriteLock(async () => {
    await atomicWriteFileInner(absPath, serializeRecord(toWrite));
    await rebuildIndexInner();
  });
  return { record: toWrite, path: absPath, created: !existed };
}

export async function readRecord(
  name: string,
  scope: MemoryRecord["scope"],
  origin?: string,
): Promise<MemoryRecord> {
  if (!MEMORY_NAME_REGEX.test(name)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `memory name "${name}" does not match the allowed pattern`,
    );
  }
  const absPath =
    scope === "site" && origin
      ? siteRecordPath(originToSlug(origin), name)
      : globalRecordPath(name);

  let text: string;
  try {
    text = await fs.readFile(absPath, "utf8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      throw new CodedError("MEMORY_NOT_FOUND", `memory "${name}" not found`, {
        name,
        path: absPath,
      });
    }
    throw new CodedError(
      "INTERNAL",
      `failed to read memory ${absPath}: ${nodeErr.message}`,
      { path: absPath, cause: nodeErr.code },
    );
  }
  return parseRecord(text, absPath);
}

export async function deleteRecord(
  name: string,
  scope: MemoryRecord["scope"],
  origin?: string,
): Promise<{ path: string }> {
  if (!MEMORY_NAME_REGEX.test(name)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `memory name "${name}" does not match the allowed pattern`,
    );
  }
  const absPath =
    scope === "site" && origin
      ? siteRecordPath(originToSlug(origin), name)
      : globalRecordPath(name);

  return withWriteLock(async () => {
    try {
      await fs.unlink(absPath);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        throw new CodedError("MEMORY_NOT_FOUND", `memory "${name}" not found`, {
          name,
          path: absPath,
        });
      }
      throw new CodedError(
        "INTERNAL",
        `failed to delete memory ${absPath}: ${nodeErr.message}`,
        { path: absPath, cause: nodeErr.code },
      );
    }
    await rebuildIndexInner();
    return { path: absPath };
  });
}

/**
 * List all v2 MemoryRecord files in the store.
 * Silently skips unreadable or malformed files.
 */
export async function listRecords(
  filter?: { scope?: MemoryRecord["scope"]; origin?: string },
): Promise<MemoryRecord[]> {
  const root = memoryRoot();
  const records: MemoryRecord[] = [];

  if (!filter?.scope || filter.scope === "global") {
    const globalDir = path.join(root, "global");
    try {
      const files = await fs.readdir(globalDir);
      await Promise.all(
        files.map(async (f) => {
          if (!f.endsWith(".yaml")) return;
          const name = f.slice(0, -5);
          if (!MEMORY_NAME_REGEX.test(name)) return;
          try {
            const text = await fs.readFile(path.join(globalDir, f), "utf8");
            const rec = parseRecord(text, path.join(globalDir, f));
            records.push(rec);
          } catch {
            // Skip unreadable / malformed
          }
        }),
      );
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== "ENOENT") throw err;
    }
  }

  if (!filter?.scope || filter.scope === "site") {
    const sitesDir = path.join(root, "sites");
    try {
      const slugDirs = await fs.readdir(sitesDir);
      for (const slug of slugDirs) {
        // If filtering by origin, only read matching slug
        if (filter?.origin && originToSlug(filter.origin) !== slug) continue;
        const slugDir = path.join(sitesDir, slug);
        let stat: Stats | undefined;
        try {
          stat = await fs.stat(slugDir);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        const files = await fs.readdir(slugDir);
        await Promise.all(
          files.map(async (f) => {
            if (!f.endsWith(".yaml")) return;
            const name = f.slice(0, -5);
            if (!MEMORY_NAME_REGEX.test(name)) return;
            try {
              const text = await fs.readFile(path.join(slugDir, f), "utf8");
              const rec = parseRecord(text, path.join(slugDir, f));
              records.push(rec);
            } catch {
              // Skip unreadable / malformed
            }
          }),
        );
      }
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== "ENOENT") throw err;
    }
  }

  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

// ---------------------------------------------------------------------------
// Legacy markdown read path (for migration — read only)
// ---------------------------------------------------------------------------

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseFrontmatter(text: string): { meta: MemoryFrontmatter; body: string } {
  const match = FRONTMATTER_REGEX.exec(text);
  if (!match) {
    throw new CodedError(
      "MEMORY_SCHEMA_INVALID",
      "memory file is missing the YAML frontmatter block delimited by '---' lines",
    );
  }
  const [, fmRaw, bodyRaw = ""] = match;

  let parsed: unknown;
  try {
    parsed = YAML.parse(fmRaw ?? "");
  } catch (err) {
    throw new CodedError(
      "MEMORY_SCHEMA_INVALID",
      `frontmatter YAML did not parse: ${(err as Error).message}`,
    );
  }
  return { meta: validateFrontmatter(parsed), body: bodyRaw.replace(/^\n/, "") };
}

function validateFrontmatter(raw: unknown): MemoryFrontmatter {
  if (typeof raw !== "object" || raw === null) {
    throw new CodedError(
      "MEMORY_SCHEMA_INVALID",
      "frontmatter must be a YAML object",
    );
  }
  const obj = raw as Record<string, unknown>;
  const required = ["name", "description", "type", "source", "created", "updated"] as const;
  for (const k of required) {
    if (typeof obj[k] !== "string" || (obj[k] as string).length === 0) {
      throw new CodedError(
        "MEMORY_SCHEMA_INVALID",
        `frontmatter field "${k}" is required and must be a non-empty string`,
      );
    }
  }
  if (!isMemoryType(obj["type"])) {
    throw new CodedError(
      "MEMORY_SCHEMA_INVALID",
      `frontmatter field "type" must be one of: ${MEMORY_TYPES.join(", ")}`,
    );
  }
  if (obj["source"] !== "mcp-tool" && obj["source"] !== "cli") {
    throw new CodedError(
      "MEMORY_SCHEMA_INVALID",
      `frontmatter field "source" must be "mcp-tool" or "cli"`,
    );
  }
  if (!MEMORY_NAME_REGEX.test(obj["name"] as string)) {
    throw new CodedError(
      "MEMORY_SCHEMA_INVALID",
      `frontmatter field "name" does not match the allowed pattern`,
    );
  }
  return {
    name: obj["name"] as string,
    description: obj["description"] as string,
    type: obj["type"] as MemoryType,
    source: obj["source"] as "mcp-tool" | "cli",
    created: obj["created"] as string,
    updated: obj["updated"] as string,
  };
}

// ---------------------------------------------------------------------------
// Legacy CRUD (preserved for backward compatibility and migration)
// ---------------------------------------------------------------------------

function serializeFrontmatter(meta: MemoryFrontmatter, body: string): string {
  const fm = YAML.stringify({
    name: meta.name,
    description: meta.description,
    type: meta.type,
    source: meta.source,
    created: meta.created,
    updated: meta.updated,
  }).trimEnd();
  const trimmedBody = body.replace(/\s+$/, "");
  return `---\n${fm}\n---\n\n${trimmedBody}\n`;
}

export interface SaveMemoryArgs {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  /** When true, overwrite an existing memory; otherwise rejects with MEMORY_ALREADY_EXISTS. */
  replace?: boolean;
  /** Defaults to "mcp-tool" — the CLI passes "cli" instead. */
  source?: "mcp-tool" | "cli";
}

export interface SaveMemoryResult {
  entry: MemoryEntry;
  /** True when the memory was created, false when an existing one was overwritten. */
  created: boolean;
}

export async function saveMemory(args: SaveMemoryArgs): Promise<SaveMemoryResult> {
  if (!MEMORY_NAME_REGEX.test(args.name)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `memory name "${args.name}" does not match the allowed pattern`,
    );
  }
  if (!isMemoryType(args.type)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `memory type "${args.type}" is not one of: ${MEMORY_TYPES.join(", ")}`,
    );
  }
  if (args.description.trim().length === 0) {
    throw new CodedError("INVALID_PARAMS", "memory description must be non-empty");
  }

  const absPath = memoryFilePath(args.name);
  const existed = await fileExists(absPath);

  if (existed && !args.replace) {
    throw new CodedError(
      "MEMORY_ALREADY_EXISTS",
      `memory "${args.name}" already exists; pass replace:true to overwrite`,
      { name: args.name, path: absPath },
    );
  }

  const now = new Date().toISOString();
  let created = now;
  if (existed) {
    try {
      const prev = await readMemory(args.name);
      created = prev.meta.created;
    } catch {
      // Existing file unreadable — fall through and rewrite with a fresh `created`.
    }
  }

  const meta: MemoryFrontmatter = {
    name: args.name,
    description: args.description.trim(),
    type: args.type,
    source: args.source ?? "mcp-tool",
    created,
    updated: now,
  };
  const text = serializeFrontmatter(meta, args.body);
  await atomicWriteFile(absPath, text);
  return {
    entry: { meta, body: args.body, path: absPath },
    created: !existed,
  };
}

export async function readMemory(name: string): Promise<MemoryEntry> {
  if (!MEMORY_NAME_REGEX.test(name)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `memory name "${name}" does not match the allowed pattern`,
    );
  }
  const absPath = memoryFilePath(name);
  let text: string;
  try {
    text = await fs.readFile(absPath, "utf8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      throw new CodedError("MEMORY_NOT_FOUND", `memory "${name}" not found`, {
        name,
        path: absPath,
      });
    }
    throw new CodedError(
      "INTERNAL",
      `failed to read memory ${absPath}: ${nodeErr.message}`,
      { path: absPath, cause: nodeErr.code },
    );
  }
  const { meta, body } = parseFrontmatter(text);
  return { meta, body, path: absPath };
}

export async function deleteMemory(name: string): Promise<{ path: string }> {
  if (!MEMORY_NAME_REGEX.test(name)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `memory name "${name}" does not match the allowed pattern`,
    );
  }
  const absPath = memoryFilePath(name);
  return withWriteLock(async () => {
    try {
      await fs.unlink(absPath);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        throw new CodedError("MEMORY_NOT_FOUND", `memory "${name}" not found`, {
          name,
          path: absPath,
        });
      }
      throw new CodedError(
        "INTERNAL",
        `failed to delete memory ${absPath}: ${nodeErr.message}`,
        { path: absPath, cause: nodeErr.code },
      );
    }
    return { path: absPath };
  });
}

/**
 * Returns every legacy memory currently on disk, with frontmatter parsed.
 * Files that fail to parse are silently skipped.
 */
export async function listMemoryEntries(): Promise<MemoryEntry[]> {
  const root = memoryRoot();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") return [];
    throw new CodedError(
      "INTERNAL",
      `failed to list memory directory ${root}: ${nodeErr.message}`,
      { path: root, cause: nodeErr.code },
    );
  }
  const entries: MemoryEntry[] = [];
  await Promise.all(
    names.map(async (filename) => {
      if (!filename.endsWith(".md")) return;
      const name = filename.slice(0, -3);
      if (!MEMORY_NAME_REGEX.test(name)) return;
      try {
        const entry = await readMemory(name);
        entries.push(entry);
      } catch {
        // Skip unreadable / malformed files.
      }
    }),
  );
  entries.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
  return entries;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}
