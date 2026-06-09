/**
 * Filesystem store for the cross-agent lore at ~/browserops/lore/.
 *
 * One markdown file per entry: <root>/<name>.md, with YAML frontmatter
 * carrying the LoreFrontmatter fields and a markdown body underneath.
 * All reads/writes go through this module.
 *
 * Read time costs are linear in the number of entries on disk because
 * we glob and parse on every search — there is no index manifest by
 * design. That keeps the on-disk layout self-describing and avoids
 * stale-index bugs. Re-evaluate if catalogues routinely exceed ~500
 * entries.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import {
  LORE_NAME_REGEX,
  LORE_TYPES,
  isLoreType,
  type LoreEntry,
  type LoreFrontmatter,
  type LoreType,
} from "@browserops/shared";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Root directory for lore storage. Overridable via
 * BROWSEROPS_LORE_DIR. Read at call time so tests can flip the env
 * var in beforeEach.
 */
function loreRoot(): string {
  return process.env["BROWSEROPS_LORE_DIR"] ?? path.join(os.homedir(), "browserops", "lore");
}

export function loreStoreRoot(): string {
  return loreRoot();
}

export function loreFilePath(name: string): string {
  return path.join(loreRoot(), `${name}.md`);
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
// different entries don't race on mkdir + atomic-rename of the same dir.
// Reads stay outside the chain (atomic rename makes them safe).
// ---------------------------------------------------------------------------

let writeChain: Promise<void> = Promise.resolve();
function withWriteLock<T>(op: () => Promise<T>): Promise<T> {
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

async function atomicWriteFile(absPath: string, text: string): Promise<void> {
  return withWriteLock(async () => {
    const dir = path.dirname(absPath);
    const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.writeFile(tmpPath, text, "utf8");
      await fs.rename(tmpPath, absPath);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => undefined);
      const nodeErr = err as NodeJS.ErrnoException;
      throw new CodedError("INTERNAL", `failed to write lore: ${absPath}: ${nodeErr.message}`, {
        path: absPath,
        cause: nodeErr.code,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Frontmatter parse / serialize
// ---------------------------------------------------------------------------

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseFrontmatter(text: string): { meta: LoreFrontmatter; body: string } {
  const match = FRONTMATTER_REGEX.exec(text);
  if (!match) {
    throw new CodedError(
      "LORE_SCHEMA_INVALID",
      "lore file is missing the YAML frontmatter block delimited by '---' lines",
    );
  }
  const [, fmRaw, bodyRaw = ""] = match;

  let parsed: unknown;
  try {
    parsed = YAML.parse(fmRaw ?? "");
  } catch (err) {
    throw new CodedError(
      "LORE_SCHEMA_INVALID",
      `frontmatter YAML did not parse: ${(err as Error).message}`,
    );
  }
  return { meta: validateFrontmatter(parsed), body: bodyRaw.replace(/^\n/, "") };
}

function validateFrontmatter(raw: unknown): LoreFrontmatter {
  if (typeof raw !== "object" || raw === null) {
    throw new CodedError("LORE_SCHEMA_INVALID", "frontmatter must be a YAML object");
  }
  const obj = raw as Record<string, unknown>;
  const required = ["name", "description", "type", "source", "created", "updated"] as const;
  for (const k of required) {
    if (typeof obj[k] !== "string" || (obj[k] as string).length === 0) {
      throw new CodedError(
        "LORE_SCHEMA_INVALID",
        `frontmatter field "${k}" is required and must be a non-empty string`,
      );
    }
  }
  if (!isLoreType(obj["type"])) {
    throw new CodedError(
      "LORE_SCHEMA_INVALID",
      `frontmatter field "type" must be one of: ${LORE_TYPES.join(", ")}`,
    );
  }
  if (obj["source"] !== "mcp-tool" && obj["source"] !== "cli") {
    throw new CodedError(
      "LORE_SCHEMA_INVALID",
      `frontmatter field "source" must be "mcp-tool" or "cli"`,
    );
  }
  if (!LORE_NAME_REGEX.test(obj["name"] as string)) {
    throw new CodedError(
      "LORE_SCHEMA_INVALID",
      `frontmatter field "name" does not match the allowed pattern`,
    );
  }
  return {
    name: obj["name"] as string,
    description: obj["description"] as string,
    type: obj["type"] as LoreType,
    source: obj["source"] as "mcp-tool" | "cli",
    created: obj["created"] as string,
    updated: obj["updated"] as string,
  };
}

function serializeFrontmatter(meta: LoreFrontmatter, body: string): string {
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

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface SaveLoreArgs {
  name: string;
  description: string;
  type: LoreType;
  body: string;
  /** When true, overwrite an existing entry; otherwise rejects with LORE_ALREADY_EXISTS. */
  replace?: boolean;
  /** Defaults to "mcp-tool" — the CLI passes "cli" instead. */
  source?: "mcp-tool" | "cli";
}

export interface SaveLoreResult {
  entry: LoreEntry;
  /** True when the entry was created, false when an existing one was overwritten. */
  created: boolean;
}

export async function saveLore(args: SaveLoreArgs): Promise<SaveLoreResult> {
  if (!LORE_NAME_REGEX.test(args.name)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `lore name "${args.name}" does not match the allowed pattern`,
    );
  }
  if (!isLoreType(args.type)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `lore type "${args.type}" is not one of: ${LORE_TYPES.join(", ")}`,
    );
  }
  if (args.description.trim().length === 0) {
    throw new CodedError("INVALID_PARAMS", "lore description must be non-empty");
  }

  const absPath = loreFilePath(args.name);
  const existed = await fileExists(absPath);

  if (existed && !args.replace) {
    throw new CodedError(
      "LORE_ALREADY_EXISTS",
      `lore "${args.name}" already exists; pass replace:true to overwrite`,
      { name: args.name, path: absPath },
    );
  }

  const now = new Date().toISOString();
  let created = now;
  if (existed) {
    try {
      const prev = await readLore(args.name);
      created = prev.meta.created;
    } catch {
      // Existing file unreadable — fall through and rewrite with a fresh `created`.
    }
  }

  const meta: LoreFrontmatter = {
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

export async function readLore(name: string): Promise<LoreEntry> {
  if (!LORE_NAME_REGEX.test(name)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `lore name "${name}" does not match the allowed pattern`,
    );
  }
  const absPath = loreFilePath(name);
  let text: string;
  try {
    text = await fs.readFile(absPath, "utf8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      throw new CodedError("LORE_NOT_FOUND", `lore "${name}" not found`, {
        name,
        path: absPath,
      });
    }
    throw new CodedError("INTERNAL", `failed to read lore ${absPath}: ${nodeErr.message}`, {
      path: absPath,
      cause: nodeErr.code,
    });
  }
  const { meta, body } = parseFrontmatter(text);
  return { meta, body, path: absPath };
}

export async function deleteLore(name: string): Promise<{ path: string }> {
  if (!LORE_NAME_REGEX.test(name)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `lore name "${name}" does not match the allowed pattern`,
    );
  }
  const absPath = loreFilePath(name);
  return withWriteLock(async () => {
    try {
      await fs.unlink(absPath);
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        throw new CodedError("LORE_NOT_FOUND", `lore "${name}" not found`, {
          name,
          path: absPath,
        });
      }
      throw new CodedError("INTERNAL", `failed to delete lore ${absPath}: ${nodeErr.message}`, {
        path: absPath,
        cause: nodeErr.code,
      });
    }
    return { path: absPath };
  });
}

/**
 * Returns every lore entry currently on disk, with frontmatter parsed.
 * Files that fail to parse are silently skipped (the search ranker
 * shouldn't blow up on a single corrupt entry); callers that need to
 * surface those errors can use readLore directly.
 */
export async function listLoreEntries(): Promise<LoreEntry[]> {
  const root = loreRoot();
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") return [];
    throw new CodedError("INTERNAL", `failed to list lore directory ${root}: ${nodeErr.message}`, {
      path: root,
      cause: nodeErr.code,
    });
  }
  const entries: LoreEntry[] = [];
  await Promise.all(
    names.map(async (filename) => {
      if (!filename.endsWith(".md")) return;
      const name = filename.slice(0, -3);
      if (!LORE_NAME_REGEX.test(name)) return;
      try {
        const entry = await readLore(name);
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
