/**
 * Builds and manages the playbook index (index.json).
 *
 * Mirrors procedures/index-builder.ts with the playbook entry shape —
 * adds `side_effects[]` to the manifest entry so search results can be
 * filtered by safety class.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import YAML from "yaml";
import { tokenize } from "@browserops/shared";
import type { PlaybookDef, PlaybookSideEffect } from "@browserops/shared";
import { readPlaybookYaml, atomicWriteFile } from "./store.js";
import { validatePlaybook } from "./validator.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlaybookManifestEntry {
  /** Path relative to the playbooksRoot. */
  path: string;
  kind: "leaf" | "composite";
  domain: string | null;
  description: string;
  /** Optional one-line goal. */
  goal?: string;
  inputs: string[];
  triggers: string[];
  tags: string[];
  side_effects: PlaybookSideEffect[];
  /** null = top-level shared; else composite owner name. */
  owner: string | null;
  /** Composites only: names of referenced sub-playbooks. */
  uses?: string[];
  /** Composites with subs: names of sub-playbooks. */
  subs?: string[];
  /** Reverse index: names of composites that reference this playbook. */
  usedBy: string[];
  /** Pre-tokenized union of all discoverable text fields; deduplicated. */
  tokens: string[];
  /** Verification state. Playbooks default to "draft" until bump_success. */
  status: "draft" | "trusted";
}

export interface PlaybookManifest {
  version: 1;
  updated: string;
  playbooks: Record<string, PlaybookManifestEntry>;
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

async function tryParsePlaybook(
  absYamlPath: string,
): Promise<PlaybookDef | null> {
  let text: string;
  try {
    text = await readPlaybookYaml(absYamlPath);
  } catch {
    process.stderr.write(
      `[playbooks-index-builder] warn: could not read ${absYamlPath} — skipping\n`,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (e) {
    process.stderr.write(
      `[playbooks-index-builder] warn: YAML parse error in ${absYamlPath}: ${(e as Error).message} — skipping\n`,
    );
    return null;
  }

  const result = validatePlaybook(parsed);
  if (!result.valid) {
    const errs = (result.errors ?? []).join("; ");
    process.stderr.write(
      `[playbooks-index-builder] warn: schema invalid in ${absYamlPath}: ${errs} — skipping\n`,
    );
    return null;
  }

  return parsed as PlaybookDef;
}

function buildTokens(pb: PlaybookDef): string[] {
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
  pb: PlaybookDef,
  relPath: string,
  owner: string | null,
  subsNames?: string[],
): PlaybookManifestEntry {
  const status: "draft" | "trusted" = pb.meta?.status ?? "draft";

  const entry: PlaybookManifestEntry = {
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

export async function scanTree(root: string): Promise<PlaybookManifest> {
  const playbooks: Record<string, PlaybookManifestEntry> = {};

  // Shared/ tree
  const sharedRoot = path.join(root, "shared");
  const sharedDirs = await listSubdirs(sharedRoot);

  for (const dirEntry of sharedDirs) {
    const absYaml = path.join(sharedRoot, dirEntry, "playbook.yaml");
    const pb = await tryParsePlaybook(absYaml);
    if (!pb) continue;

    const relPath = path.join("shared", dirEntry, "playbook.yaml");
    playbooks[pb.name] = buildEntry(pb, relPath, null);
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

    const compositeYaml = path.join(compositeAbs, "playbook.yaml");
    const compositePb = await tryParsePlaybook(compositeYaml);

    const subsRoot = path.join(compositeAbs, "subs");
    const subDirs = await listSubdirs(subsRoot);
    const subsNames: string[] = [];

    for (const subDir of subDirs) {
      const subYaml = path.join(subsRoot, subDir, "playbook.yaml");
      const subPb = await tryParsePlaybook(subYaml);
      if (!subPb) continue;

      const subRelPath = path.join(compositeDir, "subs", subDir, "playbook.yaml");
      playbooks[subPb.name] = buildEntry(
        subPb,
        subRelPath,
        compositePb ? compositePb.name : compositeDir,
      );
      subsNames.push(subPb.name);
    }

    if (!compositePb) continue;

    const compositeRelPath = path.join(compositeDir, "playbook.yaml");
    playbooks[compositePb.name] = buildEntry(
      compositePb,
      compositeRelPath,
      null,
      subsNames,
    );
  }

  // Reverse index usedBy
  for (const [name, entry] of Object.entries(playbooks)) {
    if (entry.kind !== "composite" || !entry.uses) continue;
    for (const ref of entry.uses) {
      const refEntry = playbooks[ref];
      if (refEntry !== undefined) {
        refEntry.usedBy.push(name);
      } else {
        process.stderr.write(
          `[playbooks-index-builder] warn: composite "${name}" references unknown playbook "${ref}" in uses:\n`,
        );
      }
    }
  }

  return {
    version: 1,
    updated: new Date().toISOString(),
    playbooks,
  };
}

export async function buildIndex(root: string): Promise<PlaybookManifest> {
  return scanTree(root);
}

export async function writeIndex(
  root: string,
  manifest: PlaybookManifest,
): Promise<void> {
  const absIndexPath = path.join(root, "index.json");
  await atomicWriteFile(absIndexPath, JSON.stringify(manifest, null, 2));
}

export async function readIndex(root: string): Promise<PlaybookManifest | null> {
  const absIndexPath = path.join(root, "index.json");

  let text: string;
  try {
    text = await fs.readFile(absIndexPath, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as PlaybookManifest;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (parsed.version !== 1) return null;
    if (typeof parsed.playbooks !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function ensureIndex(root: string): Promise<PlaybookManifest> {
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
    if (await yamlNewerThan(path.join(sharedRoot, d, "playbook.yaml"), thresholdMs)) {
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
    if (await yamlNewerThan(path.join(compositeAbs, "playbook.yaml"), thresholdMs)) {
      return true;
    }
    const subsRoot = path.join(compositeAbs, "subs");
    const subDirs = await listSubdirs(subsRoot);
    for (const s of subDirs) {
      if (await yamlNewerThan(path.join(subsRoot, s, "playbook.yaml"), thresholdMs)) {
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
