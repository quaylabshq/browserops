/**
 * Builds and manages the procedure index (index.json).
 *
 * Mirrors procedures/index-builder.ts with the procedure entry shape —
 * adds `side_effects[]` to the manifest entry so search results can be
 * filtered by safety class.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";
import { tokenize } from "@browserops/shared";
import type { ProcedureDef, SideEffectClass } from "@browserops/shared";
import { readProcedureYaml, atomicWriteFile } from "./store.js";
import { validateProcedure } from "./validator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProcedureManifestEntry {
  /** Path relative to the proceduresRoot. */
  path: string;
  kind: "leaf" | "composite";
  domain: string | null;
  description: string;
  /** Optional one-line goal. */
  goal?: string;
  inputs: string[];
  triggers: string[];
  tags: string[];
  side_effects: SideEffectClass[];
  /** null = top-level shared; else composite owner name. */
  owner: string | null;
  /** Composites only: names of referenced sub-procedures. */
  uses?: string[];
  /** Composites with subs: names of sub-procedures. */
  subs?: string[];
  /** Reverse index: names of composites that reference this procedure. */
  usedBy: string[];
  /** Pre-tokenized union of all discoverable text fields; deduplicated. */
  tokens: string[];
  /** Verification state. Procedures default to "draft" until bump_success. */
  status: "draft" | "trusted";
}

export interface ProcedureManifest {
  version: 1;
  updated: string;
  procedures: Record<string, ProcedureManifestEntry>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(["shared", ".git"]);

function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith(".");
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") return [];
    throw err;
  }
}

async function tryParseProcedure(
  absYamlPath: string,
): Promise<ProcedureDef | null> {
  let text: string;
  try {
    text = await readProcedureYaml(absYamlPath);
  } catch {
    process.stderr.write(
      `[procedures-index-builder] warn: could not read ${absYamlPath} — skipping\n`,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (e) {
    process.stderr.write(
      `[procedures-index-builder] warn: YAML parse error in ${absYamlPath}: ${(e as Error).message} — skipping\n`,
    );
    return null;
  }

  const result = validateProcedure(parsed);
  if (!result.valid) {
    const errs = (result.errors ?? []).join("; ");
    process.stderr.write(
      `[procedures-index-builder] warn: schema invalid in ${absYamlPath}: ${errs} — skipping\n`,
    );
    return null;
  }

  return parsed as ProcedureDef;
}

function buildTokens(pb: ProcedureDef): string[] {
  const parts: string[] = [
    ...pb.name.split("."),
    pb.description,
    pb.goal ?? "",
    ...(pb.triggers ?? []),
    ...(pb.tags ?? []),
    ...Object.keys(pb.inputs ?? {}),
    ...(pb.domain ? [pb.domain] : []),
  ];
  const allTokens = parts.flatMap((p) => tokenize(p));
  return [...new Set(allTokens)];
}

function buildEntry(
  pb: ProcedureDef,
  relPath: string,
  owner: string | null,
  subsNames?: string[],
): ProcedureManifestEntry {
  const status: "draft" | "trusted" = pb.meta?.status ?? "draft";

  const entry: ProcedureManifestEntry = {
    path: relPath,
    kind: pb.kind,
    domain: pb.domain ?? null,
    description: pb.description,
    inputs: Object.keys(pb.inputs ?? {}),
    triggers: pb.triggers ?? [],
    tags: pb.tags ?? [],
    side_effects: pb.side_effects ?? [],
    owner,
    usedBy: [],
    tokens: buildTokens(pb),
    status,
  };

  if (pb.goal !== undefined) entry.goal = pb.goal;

  if (pb.kind === "composite") {
    entry.uses = pb.uses ?? [];
    if (subsNames && subsNames.length > 0) entry.subs = subsNames;
  }

  return entry;
}

// ---------------------------------------------------------------------------
// scanTree / buildIndex / writeIndex / readIndex / ensureIndex
// ---------------------------------------------------------------------------

export async function scanTree(root: string): Promise<ProcedureManifest> {
  const procedures: Record<string, ProcedureManifestEntry> = {};

  // Shared/ tree
  const sharedRoot = path.join(root, "shared");
  const sharedDirs = await listSubdirs(sharedRoot);

  for (const dirEntry of sharedDirs) {
    const absYaml = path.join(sharedRoot, dirEntry, "procedure.yaml");
    const pb = await tryParseProcedure(absYaml);
    if (!pb) continue;

    const relPath = path.join("shared", dirEntry, "procedure.yaml");
    procedures[pb.name] = buildEntry(pb, relPath, null);
  }

  // Top-level composite dirs
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

    const compositeYaml = path.join(compositeAbs, "procedure.yaml");
    const compositePb = await tryParseProcedure(compositeYaml);

    const subsRoot = path.join(compositeAbs, "subs");
    const subDirs = await listSubdirs(subsRoot);
    const subsNames: string[] = [];

    for (const subDir of subDirs) {
      const subYaml = path.join(subsRoot, subDir, "procedure.yaml");
      const subPb = await tryParseProcedure(subYaml);
      if (!subPb) continue;

      const subRelPath = path.join(compositeDir, "subs", subDir, "procedure.yaml");
      procedures[subPb.name] = buildEntry(
        subPb,
        subRelPath,
        compositePb ? compositePb.name : compositeDir,
      );
      subsNames.push(subPb.name);
    }

    if (!compositePb) continue;

    const compositeRelPath = path.join(compositeDir, "procedure.yaml");
    procedures[compositePb.name] = buildEntry(
      compositePb,
      compositeRelPath,
      null,
      subsNames,
    );
  }

  // Reverse index usedBy
  for (const [name, entry] of Object.entries(procedures)) {
    if (entry.kind !== "composite" || !entry.uses) continue;
    for (const ref of entry.uses) {
      const refEntry = procedures[ref];
      if (refEntry !== undefined) {
        refEntry.usedBy.push(name);
      } else {
        process.stderr.write(
          `[procedures-index-builder] warn: composite "${name}" references unknown procedure "${ref}" in uses:\n`,
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

export async function buildIndex(root: string): Promise<ProcedureManifest> {
  return scanTree(root);
}

export async function writeIndex(
  root: string,
  manifest: ProcedureManifest,
): Promise<void> {
  const absIndexPath = path.join(root, "index.json");
  await atomicWriteFile(absIndexPath, JSON.stringify(manifest, null, 2));
}

export async function readIndex(root: string): Promise<ProcedureManifest | null> {
  const absIndexPath = path.join(root, "index.json");

  let text: string;
  try {
    text = await fs.readFile(absIndexPath, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as ProcedureManifest;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (parsed.version !== 1) return null;
    if (typeof parsed.procedures !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function ensureIndex(root: string): Promise<ProcedureManifest> {
  await fs.mkdir(root, { recursive: true });

  const absIndexPath = path.join(root, "index.json");

  const existing = await readIndex(root);
  if (!existing) {
    const manifest = await buildIndex(root);
    await writeIndex(root, manifest);
    return manifest;
  }

  let indexMtime: number;
  try {
    const stat = await fs.stat(absIndexPath);
    indexMtime = stat.mtimeMs;
  } catch {
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

async function isAnyYamlNewerThan(
  root: string,
  thresholdMs: number,
): Promise<boolean> {
  const sharedRoot = path.join(root, "shared");
  const sharedDirs = await listSubdirs(sharedRoot);
  for (const d of sharedDirs) {
    if (await yamlNewerThan(path.join(sharedRoot, d, "procedure.yaml"), thresholdMs)) {
      return true;
    }
  }

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
