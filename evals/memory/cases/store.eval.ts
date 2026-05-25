/**
 * Capability B — store roundtrip: save paths, index updates, CRUD.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MemoryRecord } from "@browserops/shared";
import {
  saveRecord,
  readRecord,
  deleteRecord,
  readIndex,
  originToSlug,
  globalRecordPath,
  siteRecordPath,
} from "../../../packages/bridge/src/memory/store.js";
import { check, checkEqual, defineEval } from "../harness.js";

/** Minimal valid global lesson record. */
function makeLesson(name: string): MemoryRecord {
  return {
    schema_version: 1,
    name,
    scope: "global",
    kind: "lesson",
    title: "A test lesson record",
    detail: { note: "this is a test note" },
  };
}

/** Minimal valid site blocker record. */
function makeSiteBlocker(name: string, origin: string): MemoryRecord {
  return {
    schema_version: 1,
    name,
    scope: "site",
    kind: "blocker",
    title: "cookie consent blocks interaction",
    origin,
    detail: {
      wall: "modal blocks all interaction until dismissed",
      door: "click the dismiss button to proceed",
    },
  };
}

defineEval({
  id: "B1",
  capability: "store",
  title: "global record saves to global/ and site record saves to sites/<slug>/",
  async run(ctx) {
    const globalName = "test-global-lesson";
    const siteName = "test-site-blocker";
    const origin = "https://www.example.com";

    const globalResult = await saveRecord({ record: makeLesson(globalName) });
    const siteResult = await saveRecord({ record: makeSiteBlocker(siteName, origin) });

    // Global record should be under global/
    const expectedGlobalPath = globalRecordPath(globalName);
    checkEqual(globalResult.path, expectedGlobalPath, "global record path");
    check(globalResult.path.includes(`${path.sep}global${path.sep}`), `expected global/ in path, got ${globalResult.path}`);
    check(globalResult.created, "global record should be newly created");

    // Site record should be under sites/<slug>/
    const slug = originToSlug(origin);
    const expectedSitePath = siteRecordPath(slug, siteName);
    checkEqual(siteResult.path, expectedSitePath, "site record path");
    check(siteResult.path.includes(`${path.sep}sites${path.sep}${slug}${path.sep}`), `expected sites/<slug>/ in path, got ${siteResult.path}`);
    check(siteResult.created, "site record should be newly created");

    // Files actually exist on disk
    await fs.access(globalResult.path);
    await fs.access(siteResult.path);
  },
});

defineEval({
  id: "B2",
  capability: "store",
  title: "index.json is updated after save",
  async run(ctx) {
    const globalName = "b2-global-lesson";
    const siteName = "b2-site-blocker";
    const origin = "https://www.example.com";

    await saveRecord({ record: makeLesson(globalName) });
    await saveRecord({ record: makeSiteBlocker(siteName, origin) });

    const index = await readIndex();
    check(index.global.includes(globalName), `global index should include ${globalName}`);

    const slug = originToSlug(origin);
    check(
      Array.isArray(index.origins[slug]) && index.origins[slug].includes(siteName),
      `site index should include ${siteName} under slug ${slug}`,
    );
  },
});

defineEval({
  id: "B3",
  capability: "store",
  title: "save → readRecord roundtrip preserves all fields",
  async run(ctx) {
    const name = "b3-roundtrip-lesson";
    const record = makeLesson(name);

    const saved = await saveRecord({ record });
    const loaded = await readRecord(name, "global");

    checkEqual(loaded.name, name, "roundtrip name");
    checkEqual(loaded.scope, "global", "roundtrip scope");
    checkEqual(loaded.kind, "lesson", "roundtrip kind");
    checkEqual(loaded.title, record.title, "roundtrip title");
    checkEqual(loaded.detail.note, record.detail.note, "roundtrip detail.note");
    checkEqual(loaded.schema_version, 1, "roundtrip schema_version");

    // Meta fields should be populated
    check(loaded.meta !== undefined, "meta should be set after save");
    check(loaded.meta!.created !== undefined, "meta.created should be set");
    checkEqual(loaded.meta!.version, 1, "meta.version should be 1 on first save");
  },
});

defineEval({
  id: "B4",
  capability: "store",
  title: "delete removes the file and the index entry",
  async run(ctx) {
    const name = "b4-deletable-lesson";
    const origin = "https://delete.example.com";
    const siteName = "b4-deletable-site-blocker";

    await saveRecord({ record: makeLesson(name) });
    await saveRecord({ record: makeSiteBlocker(siteName, origin) });

    // Verify they exist in index
    const indexBefore = await readIndex();
    check(indexBefore.global.includes(name), "global should exist before delete");

    // Delete global record
    await deleteRecord(name, "global");

    // File should be gone
    const globalPath = globalRecordPath(name);
    let threw = false;
    try {
      await fs.access(globalPath);
    } catch {
      threw = true;
    }
    check(threw, "global file should be gone after delete");

    // Index should be updated
    const indexAfter = await readIndex();
    check(!indexAfter.global.includes(name), "global index should not include deleted name");

    // Delete site record
    const slug = originToSlug(origin);
    await deleteRecord(siteName, "site", origin);

    // Site entry should be gone from index
    const indexFinal = await readIndex();
    check(
      !indexFinal.origins[slug]?.includes(siteName),
      "site index should not include deleted name",
    );
  },
});

defineEval({
  id: "B5",
  capability: "store",
  title: "temp-store isolation: each ctx.dir is independent",
  async run(ctx) {
    // This eval runs inside withTempStore via the harness.
    // Save a record and verify it's in this temp dir, not anywhere else.
    const name = "b5-isolation-test";
    const result = await saveRecord({ record: makeLesson(name) });

    // The path should be under ctx.dir
    check(
      result.path.startsWith(ctx.dir),
      `record path ${result.path} should start with ctx.dir ${ctx.dir}`,
    );

    // Verify the file exists in the expected isolated location
    await fs.access(result.path);
  },
});
