/**
 * One-time migration: legacy ~/browserops/memory/*.md → v2 YAML records.
 *
 * Each legacy file becomes:
 *   scope: "global", kind: "lesson"
 *   title: <description field, truncated to 120 chars>
 *   detail.note: <markdown body>
 *   meta.source: "cli"
 *
 * Originals are moved to <root>/_legacy/ to prevent re-migration.
 * The function is idempotent: it only migrates files not already in _legacy.
 * No-op when no legacy .md files exist.
 *
 * Returns a summary of what was migrated.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MEMORY_NAME_REGEX, type MemoryRecord } from "@browserops/shared";
import {
  memoriesRoot,
  readLegacyMemory,
  saveRecord,
} from "./store.js";

export interface MigrationResult {
  migrated: string[];
  skipped: string[];
  errors: Array<{ name: string; reason: string }>;
}

/**
 * Scan the legacy markdown files and migrate them to the v2 YAML store.
 * Safe to call multiple times (idempotent).
 */
export async function migrateLegacyMarkdown(): Promise<MigrationResult> {
  const root = memoriesRoot();
  const result: MigrationResult = { migrated: [], skipped: [], errors: [] };

  // List files in the root (flat directory, not subdirectories)
  let filenames: string[];
  try {
    filenames = await fs.readdir(root);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") return result; // no store yet, nothing to do
    throw err;
  }

  const mdFiles = filenames.filter((f) => {
    if (!f.endsWith(".md")) return false;
    const name = f.slice(0, -3);
    return MEMORY_NAME_REGEX.test(name);
  });

  if (mdFiles.length === 0) return result;

  // Ensure legacy dir exists
  const legacyDir = path.join(root, "_legacy");
  await fs.mkdir(legacyDir, { recursive: true });

  for (const filename of mdFiles) {
    const name = filename.slice(0, -3);
    const srcPath = path.join(root, filename);
    const dstPath = path.join(legacyDir, filename);

    // Read and parse the legacy entry
    let entry: Awaited<ReturnType<typeof readLegacyMemory>>;
    try {
      entry = await readLegacyMemory(name);
    } catch (err) {
      result.errors.push({
        name,
        reason: `could not parse: ${(err as Error).message}`,
      });
      continue;
    }

    // Build a v2 MemoryRecord from the legacy entry
    const title = entry.meta.description.slice(0, 120);
    const note = entry.body.trim() || entry.meta.description;

    const record: MemoryRecord = {
      schema_version: 1,
      name,
      scope: "global",
      kind: "lesson",
      title,
      detail: { note },
      meta: {
        version: 1,
        created: entry.meta.created,
        updated: entry.meta.updated,
        source: "cli",
      },
    };

    // Save to the v2 store (replace if already migrated on a previous run)
    try {
      await saveRecord({ record, replace: true });
    } catch (err) {
      result.errors.push({
        name,
        reason: `could not save v2 record: ${(err as Error).message}`,
      });
      continue;
    }

    // Move original to _legacy/
    try {
      // Use copy+delete instead of rename in case src and dst are on different devices
      await fs.copyFile(srcPath, dstPath);
      await fs.unlink(srcPath);
    } catch (err) {
      result.errors.push({
        name,
        reason: `could not move to _legacy: ${(err as Error).message}`,
      });
      continue;
    }

    result.migrated.push(name);
  }

  return result;
}
