/**
 * Builds and manages the procedure index (index.json).
 *
 * The index is a denormalized manifest that lets list/search operate without
 * re-parsing every procedure.yaml. It is rebuilt on startup when missing or
 * stale, and after every mutating operation (save, delete, promote).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";
import { tokenize } from "@browserops/shared";
import type { ProcedureDef } from "@browserops/shared";
import { indexPath } from "./paths.js";
import { readProcedureYaml } from "./store.js";
import { atomicWriteFile } from "./store.js";
import { validateProcedure } from "./validator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  /** Path relative to the proceduresRoot. */
  path: string;
  kind: "leaf" | "composite";
  domain: string | null;
  description: string;
  /** Input names only. */
  inputs: string[];
  triggers: string[];
  tags: string[];
  /** null = top-level shared; else composite owner name. */
  owner: string | null;
  /** Composites only: names of referenced procedures. */
  uses?: string[];
  /** Composites with subs only: names of sub-procedures. */
  subs?: string[];
  /** Reverse index: names of composites that reference this procedure. */
  usedBy: string[];
  /** Pre-tokenized union of all discoverable text fields; deduplicated. */
  tokens: string[];
  /** Verification state. Procedures default to "draft" until bump_success. */
  status: "draft" | "trusted";
  /** Number of recorded successful runs (via procedures_save bump_success). */
  success_count: number;
}

export interface Manifest {
  version: 1;
  updated: string; // ISO 8601
  procedures: Record<string, ManifestEntry>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Directories under root that are never composite owners. */
const SKIP_DIRS = new Set(["shared", ".git"]);

/** True when a directory name should be skipped during enumeration. */
function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith(".");
}

/**
 * Enumerates child directory names directly under `dir`.
 * Returns an empty array if `dir` does not exist.
 */
async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Reads and parses a single procedure.yaml.
 *
 * Returns the parsed object on success, or `null` on any error (with a
 * warning printed to stderr).
 */
async function tryParseProcedure(
  absYamlPath: string,
): Promise<ProcedureDef | null> {
  let text: string;
  try {
    text = await readProcedureYaml(absYamlPath);
  } catch {
    process.stderr.write(
      `[index-builder] warn: could not read ${absYamlPath} — skipping\n`,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (e) {
    process.stderr.write(
      `[index-builder] warn: YAML parse error in ${absYamlPath}: ${(e as Error).message} — skipping\n`,
    );
    return null;
  }

  const result = validateProcedure(parsed);
  if (!result.valid) {
    const errs = (result.errors ?? []).join("; ");
    process.stderr.write(
      `[index-builder] warn: schema invalid in ${absYamlPath}: ${errs} — skipping\n`,
    );
    return null;
  }

  return parsed as ProcedureDef;
}

/**
 * Builds the pre-tokenized tokens array for a procedure.
 *
 * Tokenizes the union of: name parts (split on `.`), description,
 * triggers, tags, input names, and domain. Deduplicates.
 */
function buildTokens(proc: ProcedureDef): string[] {
  const parts: string[] = [
    // Name parts split on dot (e.g. "gmail.send_email" → "gmail", "send_email")
    ...proc.name.split("."),
    proc.description,
    ...(proc.triggers ?? []),
    ...(proc.tags ?? []),
    ...Object.keys(proc.inputs ?? {}),
    ...(proc.domain ? [proc.domain] : []),
  ];

  const allTokens = parts.flatMap((p) => tokenize(p));
  return [...new Set(allTokens)];
}

/**
 * Builds one ManifestEntry from a parsed procedure.
 *
 * `relPath` is relative to the procedures root.
 * `owner`   is the composite name or null.
 * `subsNames` is populated by the caller for composite entries.
 */
function buildEntry(
  proc: ProcedureDef,
  relPath: string,
  owner: string | null,
  subsNames?: string[],
): ManifestEntry {
  const successCount = proc.meta?.success_count ?? 0;
  const status: "draft" | "trusted" =
    proc.meta?.status ?? (successCount >= 1 ? "trusted" : "draft");

  const entry: ManifestEntry = {
    path: relPath,
    kind: proc.kind,
    domain: proc.domain ?? null,
    description: proc.description,
    inputs: Object.keys(proc.inputs ?? {}),
    triggers: proc.triggers ?? [],
    tags: proc.tags ?? [],
    owner,
    usedBy: [], // populated in second pass
    tokens: buildTokens(proc),
    status,
    success_count: successCount,
  };

  if (proc.kind === "composite") {
    entry.uses = proc.uses ?? [];
    if (subsNames && subsNames.length > 0) {
      entry.subs = subsNames;
    }
  }

  return entry;
}

// ---------------------------------------------------------------------------
// scanTree
// ---------------------------------------------------------------------------

/**
 * Walks the procedure tree rooted at `root` and produces a Manifest.
 *
 * Pass 1: enumerate all procedure.yaml files, parse + validate, build entries.
 * Pass 2: populate `usedBy` by reverse-indexing each composite's `uses:`.
 */
export async function scanTree(root: string): Promise<Manifest> {
  const procedures: Record<string, ManifestEntry> = {};

  // ---------- Pass 1a: shared/ directory (top-level shared procedures) ----------

  const sharedRoot = path.join(root, "shared");
  const sharedDirs = await listSubdirs(sharedRoot);

  for (const dirEntry of sharedDirs) {
    const absYaml = path.join(sharedRoot, dirEntry, "procedure.yaml");
    const proc = await tryParseProcedure(absYaml);
    if (!proc) continue;

    const relPath = path.join("shared", dirEntry, "procedure.yaml");
    const entry = buildEntry(proc, relPath, null);
    procedures[proc.name] = entry;
  }

  // ---------- Pass 1b: top-level composite directories ----------

  let topDirs: string[];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    topDirs = entries
      .filter((e) => e.isDirectory() && !isSkippedDir(e.name))
      .map((e) => e.name);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      topDirs = [];
    } else {
      throw err;
    }
  }

  for (const compositeDir of topDirs) {
    const compositeAbs = path.join(root, compositeDir);

    // Read composite procedure.yaml
    const compositeYaml = path.join(compositeAbs, "procedure.yaml");
    const compositeProc = await tryParseProcedure(compositeYaml);

    // Enumerate subs/ regardless — they belong to this composite
    const subsRoot = path.join(compositeAbs, "subs");
    const subDirs = await listSubdirs(subsRoot);
    const subsNames: string[] = [];

    for (const subDir of subDirs) {
      const subYaml = path.join(subsRoot, subDir, "procedure.yaml");
      const subProc = await tryParseProcedure(subYaml);
      if (!subProc) continue;

      const subRelPath = path.join(compositeDir, "subs", subDir, "procedure.yaml");
      const subEntry = buildEntry(
        subProc,
        subRelPath,
        compositeProc ? compositeProc.name : compositeDir,
      );
      procedures[subProc.name] = subEntry;
      subsNames.push(subProc.name);
    }

    if (!compositeProc) continue;

    const compositeRelPath = path.join(compositeDir, "procedure.yaml");
    const compositeEntry = buildEntry(
      compositeProc,
      compositeRelPath,
      null,
      subsNames,
    );
    procedures[compositeProc.name] = compositeEntry;
  }

  // ---------- Pass 2: reverse-index usedBy ----------

  for (const [name, entry] of Object.entries(procedures)) {
    if (entry.kind !== "composite" || !entry.uses) continue;

    for (const ref of entry.uses) {
      const refEntry = procedures[ref];
      if (refEntry !== undefined) {
        refEntry.usedBy.push(name);
      } else {
        process.stderr.write(
          `[index-builder] warn: composite "${name}" references unknown procedure "${ref}" in uses:\n`,
        );
      }
    }
  }

  return {
    version: 1,
    updated: new Date().toISOString(),
    procedures,
  };
}

// ---------------------------------------------------------------------------
// buildIndex
// ---------------------------------------------------------------------------

/**
 * Builds and returns the full manifest for `root`.
 *
 * Thin wrapper around `scanTree`; the distinction is preserved for future
 * caching (e.g. partial incremental updates).
 */
export async function buildIndex(root: string): Promise<Manifest> {
  return scanTree(root);
}

// ---------------------------------------------------------------------------
// writeIndex
// ---------------------------------------------------------------------------

/**
 * Atomically writes `manifest` as `index.json` inside `root`.
 */
export async function writeIndex(
  root: string,
  manifest: Manifest,
): Promise<void> {
  const absIndexPath = path.join(root, "index.json");
  await atomicWriteFile(absIndexPath, JSON.stringify(manifest, null, 2));
}

// ---------------------------------------------------------------------------
// readIndex
// ---------------------------------------------------------------------------

/**
 * Reads and parses `index.json` from `root`.
 *
 * Returns `null` if the file is missing or malformed.
 */
export async function readIndex(root: string): Promise<Manifest | null> {
  const absIndexPath = path.join(root, "index.json");

  let text: string;
  try {
    text = await fs.readFile(absIndexPath, "utf8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") return null;
    return null;
  }

  try {
    const parsed = JSON.parse(text) as Manifest;
    // Basic sanity: must have version and procedures fields.
    if (typeof parsed !== "object" || parsed === null) return null;
    if (parsed.version !== 1) return null;
    if (typeof parsed.procedures !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ensureIndex
// ---------------------------------------------------------------------------

/**
 * Startup-path helper: ensures the procedures tree exists and the index is
 * fresh.
 *
 * Algorithm:
 *   1. mkdir -p `root`.
 *   2. Read current index. If missing → build + write + return.
 *   3. Compare index mtime against every procedure.yaml mtime.
 *      If any yaml is newer → rebuild + write + return.
 *   4. Otherwise return the existing index (no rebuild).
 */
export async function ensureIndex(root: string): Promise<Manifest> {
  // 1. Ensure root exists.
  await fs.mkdir(root, { recursive: true });

  const absIndexPath = path.join(root, "index.json");

  // 2. Read existing index.
  const existing = await readIndex(root);
  if (!existing) {
    const manifest = await buildIndex(root);
    await writeIndex(root, manifest);
    return manifest;
  }

  // 3. Check index mtime vs procedure.yaml mtimes.
  let indexMtime: number;
  try {
    const stat = await fs.stat(absIndexPath);
    indexMtime = stat.mtimeMs;
  } catch {
    // index disappeared between readIndex and stat — rebuild.
    const manifest = await buildIndex(root);
    await writeIndex(root, manifest);
    return manifest;
  }

  const stale = await isAnyYamlNewerThan(root, indexMtime);
  if (stale) {
    const manifest = await buildIndex(root);
    await writeIndex(root, manifest);
    return manifest;
  }

  return existing;
}

/**
 * Returns true if any `procedure.yaml` file under `root` has an mtime
 * strictly greater than `thresholdMs`.
 */
async function isAnyYamlNewerThan(
  root: string,
  thresholdMs: number,
): Promise<boolean> {
  // Walk shared/
  const sharedRoot = path.join(root, "shared");
  const sharedDirs = await listSubdirs(sharedRoot);
  for (const d of sharedDirs) {
    if (await yamlNewerThan(path.join(sharedRoot, d, "procedure.yaml"), thresholdMs)) {
      return true;
    }
  }

  // Walk top-level composite dirs
  let topDirs: string[] = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    topDirs = entries
      .filter((e) => e.isDirectory() && !isSkippedDir(e.name))
      .map((e) => e.name);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== "ENOENT") throw err;
  }

  for (const d of topDirs) {
    const compositeAbs = path.join(root, d);
    if (await yamlNewerThan(path.join(compositeAbs, "procedure.yaml"), thresholdMs)) {
      return true;
    }
    // Check subs
    const subsRoot = path.join(compositeAbs, "subs");
    const subDirs = await listSubdirs(subsRoot);
    for (const s of subDirs) {
      if (await yamlNewerThan(path.join(subsRoot, s, "procedure.yaml"), thresholdMs)) {
        return true;
      }
    }
  }

  return false;
}

/** Returns true if the file exists and its mtime > thresholdMs. */
async function yamlNewerThan(
  absPath: string,
  thresholdMs: number,
): Promise<boolean> {
  try {
    const stat = await fs.stat(absPath);
    return stat.mtimeMs > thresholdMs;
  } catch {
    return false;
  }
}
