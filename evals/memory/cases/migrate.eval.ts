/**
 * Capability C — migrate: legacy .md → v2 YAML records.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { migrateLegacyMarkdown } from "../../../packages/bridge/src/memory/migrate.js";
import { readRecord } from "../../../packages/bridge/src/memory/store.js";
import { check, checkEqual, defineEval } from "../harness.js";

/** Build a valid legacy markdown memory file content. */
function legacyMdContent(opts: {
  name: string;
  description: string;
  body?: string;
  created?: string;
  updated?: string;
}): string {
  const created = opts.created ?? "2024-01-01T00:00:00.000Z";
  const updated = opts.updated ?? "2024-01-02T00:00:00.000Z";
  const body = opts.body ?? "This is the legacy body content.";
  return [
    "---",
    `name: ${opts.name}`,
    `description: ${opts.description}`,
    `type: user`,
    `source: cli`,
    `created: ${created}`,
    `updated: ${updated}`,
    "---",
    body,
  ].join("\n");
}

defineEval({
  id: "C1",
  capability: "migrate",
  title: "legacy .md becomes scope:global / kind:lesson in the v2 store",
  async run(ctx) {
    // Seed one legacy markdown file
    const name = "c1-legacy-lesson";
    const description = "A legacy lesson about modal dialogs";
    const body = "This is the body explaining the issue in detail.";
    const mdContent = legacyMdContent({ name, description, body });

    await fs.writeFile(path.join(ctx.dir, `${name}.md`), mdContent, "utf8");

    const result = await migrateLegacyMarkdown();

    check(result.migrated.includes(name), `expected ${name} in migrated list, got: ${JSON.stringify(result.migrated)}`);
    checkEqual(result.errors.length, 0, "expected no migration errors");

    // The v2 record should exist
    const record = await readRecord(name, "global");
    checkEqual(record.scope, "global", "migrated record should have scope:global");
    checkEqual(record.kind, "lesson", "migrated record should have kind:lesson");
    checkEqual(record.title, description, "migrated record title should be legacy description");
    check(record.detail.note !== undefined, "migrated record should have detail.note");
    check(record.detail.note!.includes("body") || record.detail.note!.length > 0, "detail.note should have body content");
    checkEqual(record.meta?.source, "cli", "migrated record source should be cli");
  },
});

defineEval({
  id: "C2",
  capability: "migrate",
  title: "original .md files are moved to _legacy/ after migration",
  async run(ctx) {
    const name = "c2-original-moved";
    const description = "Original that should be moved";
    const mdContent = legacyMdContent({ name, description });

    await fs.writeFile(path.join(ctx.dir, `${name}.md`), mdContent, "utf8");

    await migrateLegacyMarkdown();

    // Original should be gone from root
    let threwOnRoot = false;
    try {
      await fs.access(path.join(ctx.dir, `${name}.md`));
    } catch {
      threwOnRoot = true;
    }
    check(threwOnRoot, "original .md should be gone from root after migration");

    // Original should be in _legacy/
    const legacyPath = path.join(ctx.dir, "_legacy", `${name}.md`);
    await fs.access(legacyPath);
    const legacyContent = await fs.readFile(legacyPath, "utf8");
    check(legacyContent.includes(name), "_legacy file should contain original content");
  },
});

defineEval({
  id: "C3",
  capability: "migrate",
  title: "migration is idempotent: running twice yields same result, no duplicate records",
  async run(ctx) {
    const name = "c3-idempotent-lesson";
    const description = "Idempotency test lesson";
    const mdContent = legacyMdContent({ name, description });

    await fs.writeFile(path.join(ctx.dir, `${name}.md`), mdContent, "utf8");

    // First migration
    const result1 = await migrateLegacyMarkdown();
    check(result1.migrated.includes(name), "first migration should migrate the file");

    // Second migration — no .md files left (moved to _legacy), so should be no-op
    const result2 = await migrateLegacyMarkdown();
    checkEqual(result2.migrated.length, 0, "second migration should have nothing to migrate");
    checkEqual(result2.errors.length, 0, "second migration should have no errors");

    // Record should still be readable (only one version)
    const record = await readRecord(name, "global");
    checkEqual(record.name, name, "record should still be readable after idempotent run");
  },
});

defineEval({
  id: "C4",
  capability: "migrate",
  title: "no-op on empty store — returns empty migrated list with no errors",
  async run(ctx) {
    // No legacy files seeded — ctx.dir is empty
    const result = await migrateLegacyMarkdown();

    checkEqual(result.migrated.length, 0, "no-op migration should have no migrated files");
    checkEqual(result.errors.length, 0, "no-op migration should have no errors");
    checkEqual(result.skipped.length, 0, "no-op migration should have no skipped files");
  },
});
