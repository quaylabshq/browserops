/**
 * Tests for the v2 memory store: YAML records, two-store layout,
 * index, dedup guard, redaction guard, merge_into, and migration.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryRecord } from "@browserops/shared";
import {
  checkRedaction,
  CodedError,
  deleteRecord,
  globalRecordPath,
  indexPath,
  listRecords,
  originToSlug,
  readRecord,
  rebuildIndex,
  saveRecord,
  siteRecordPath,
} from "./store.js";
import { migrateLegacyMarkdown } from "./migrate.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".store-v2-test-"),
  );
  process.env["BROWSEROPS_MEMORY_DIR"] = tmpRoot;
});

afterEach(async () => {
  delete process.env["BROWSEROPS_MEMORY_DIR"];
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function globalRecord(overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    schema_version: 1,
    name: "test-lesson",
    scope: "global",
    kind: "lesson",
    title: "Test lesson title",
    detail: { note: "This is a test lesson." },
    ...overrides,
  };
}

function siteRecord(overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    schema_version: 1,
    name: "test-blocker",
    scope: "site",
    kind: "blocker",
    origin: "https://www.example.com",
    title: "Test blocker title",
    detail: { wall: "The wall symptom.", door: "The door workaround." },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// originToSlug
// ---------------------------------------------------------------------------

describe("originToSlug", () => {
  it("converts https://www.notion.so → www-notion-so", () => {
    expect(originToSlug("https://www.notion.so")).toBe("www-notion-so");
  });

  it("converts http://localhost:3000 → localhost-3000", () => {
    expect(originToSlug("http://localhost:3000")).toBe("localhost-3000");
  });

  it("converts https://app.linear.app → app-linear-app", () => {
    expect(originToSlug("https://app.linear.app")).toBe("app-linear-app");
  });
});

// ---------------------------------------------------------------------------
// Save + read roundtrip — global store
// ---------------------------------------------------------------------------

describe("saveRecord + readRecord roundtrip (global)", () => {
  it("creates a file at the correct path and returns created:true", async () => {
    const rec = globalRecord();
    const result = await saveRecord({ record: rec });
    expect(result.created).toBe(true);
    expect(result.path).toBe(globalRecordPath("test-lesson"));

    const stat = await fs.stat(result.path);
    expect(stat.isFile()).toBe(true);
  });

  it("round-trips the record correctly", async () => {
    const rec = globalRecord({ tags: ["foo", "bar"] });
    await saveRecord({ record: rec });
    const loaded = await readRecord("test-lesson", "global");
    expect(loaded.schema_version).toBe(1);
    expect(loaded.name).toBe("test-lesson");
    expect(loaded.scope).toBe("global");
    expect(loaded.kind).toBe("lesson");
    expect(loaded.title).toBe("Test lesson title");
    expect(loaded.detail.note).toBe("This is a test lesson.");
    expect(loaded.tags).toEqual(["foo", "bar"]);
  });

  it("populates meta.created and meta.updated on create", async () => {
    const rec = globalRecord();
    const result = await saveRecord({ record: rec });
    expect(result.record.meta?.created).toBeTruthy();
    expect(result.record.meta?.updated).toBeTruthy();
  });

  it("preserves created timestamp on overwrite, advances updated", async () => {
    const rec = globalRecord();
    const first = await saveRecord({ record: rec });
    const createdFirst = first.record.meta?.created ?? "";

    await new Promise((r) => setTimeout(r, 10));

    const second = await saveRecord({
      record: { ...rec, title: "Updated title" },
      replace: true,
    });
    expect(second.created).toBe(false);
    expect(second.record.meta?.created).toBe(createdFirst);
    expect(second.record.meta?.updated ?? "").not.toBe(createdFirst);
  });

  it("rejects duplicate name without replace:true", async () => {
    const rec = globalRecord();
    await saveRecord({ record: rec });
    await expect(saveRecord({ record: rec })).rejects.toSatisfy(
      (e: unknown) => e instanceof CodedError && e.code === "MEMORY_ALREADY_EXISTS",
    );
  });
});

// ---------------------------------------------------------------------------
// Save + read roundtrip — site store
// ---------------------------------------------------------------------------

describe("saveRecord + readRecord roundtrip (site)", () => {
  it("creates file at sites/<slug>/<name>.yaml", async () => {
    const rec = siteRecord();
    const result = await saveRecord({ record: rec });
    const slug = originToSlug("https://www.example.com");
    expect(result.path).toBe(siteRecordPath(slug, "test-blocker"));

    const loaded = await readRecord("test-blocker", "site", "https://www.example.com");
    expect(loaded.scope).toBe("site");
    expect(loaded.origin).toBe("https://www.example.com");
  });

  it("round-trips blocker fields", async () => {
    const rec = siteRecord();
    await saveRecord({ record: rec });
    const loaded = await readRecord("test-blocker", "site", "https://www.example.com");
    expect(loaded.detail.wall).toBe("The wall symptom.");
    expect(loaded.detail.door).toBe("The door workaround.");
  });
});

// ---------------------------------------------------------------------------
// deleteRecord
// ---------------------------------------------------------------------------

describe("deleteRecord", () => {
  it("removes a global record and returns path", async () => {
    await saveRecord({ record: globalRecord() });
    const result = await deleteRecord("test-lesson", "global");
    expect(result.path).toBe(globalRecordPath("test-lesson"));
    await expect(readRecord("test-lesson", "global")).rejects.toSatisfy(
      (e: unknown) => e instanceof CodedError && e.code === "MEMORY_NOT_FOUND",
    );
  });

  it("throws MEMORY_NOT_FOUND for a nonexistent record", async () => {
    await expect(deleteRecord("ghost", "global")).rejects.toSatisfy(
      (e: unknown) => e instanceof CodedError && e.code === "MEMORY_NOT_FOUND",
    );
  });
});

// ---------------------------------------------------------------------------
// Index build and persist
// ---------------------------------------------------------------------------

describe("rebuildIndex", () => {
  it("returns empty index when no records exist", async () => {
    const index = await rebuildIndex();
    expect(index.global).toEqual([]);
    expect(index.origins).toEqual({});
  });

  it("lists global records in index.global", async () => {
    await saveRecord({
      record: globalRecord({ name: "alpha", title: "Alpha unique tip about formatting", detail: { note: "Alpha note about formatting text." } }),
    });
    await saveRecord({
      record: globalRecord({ name: "zeta", title: "Zeta tip about navigation shortcuts", detail: { note: "Zeta note about keyboard navigation." } }),
    });
    const index = await rebuildIndex();
    expect(index.global).toContain("alpha");
    expect(index.global).toContain("zeta");
  });

  it("lists site records under correct origin slug", async () => {
    await saveRecord({ record: siteRecord({ name: "b1" }) });
    const index = await rebuildIndex();
    const slug = originToSlug("https://www.example.com");
    expect(index.origins[slug]).toContain("b1");
  });

  it("persists the index to disk as valid JSON", async () => {
    await saveRecord({ record: globalRecord() });
    await rebuildIndex();
    const raw = await fs.readFile(indexPath(), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("global");
    expect(parsed).toHaveProperty("origins");
    expect(parsed).toHaveProperty("confidence");
  });

  it("populates confidence for each record after rebuild", async () => {
    // Phase 3.2: rebuildIndex computes confidence fresh from disk records;
    // stale entries for records that no longer exist on disk are dropped.
    await saveRecord({ record: globalRecord() });
    const raw = await fs.readFile(indexPath(), "utf8");
    const parsed = JSON.parse(raw) as { confidence: Record<string, number> };
    // The saved record should have a confidence value in [0, 1]
    expect(typeof parsed.confidence["test-lesson"]).toBe("number");
    expect(parsed.confidence["test-lesson"]).toBeGreaterThanOrEqual(0);
    expect(parsed.confidence["test-lesson"]).toBeLessThanOrEqual(1);
    // Records not on disk are not in the confidence map
    expect(parsed.confidence["some-record"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dedup guard
// ---------------------------------------------------------------------------

describe("dedup guard", () => {
  it("detects a near-duplicate and returns possible_duplicate instead of writing", async () => {
    // Use nearly identical content to ensure Jaccard similarity >= 0.8
    const rec = globalRecord({
      name: "original-lesson",
      title: "Gmail compose button click to open compose modal dialog",
      detail: { note: "Click the compose button to open the compose modal dialog in Gmail." },
    });
    await saveRecord({ record: rec });

    const dup = globalRecord({
      name: "new-lesson",
      // Identical title and nearly identical note — Jaccard should be >= 0.8
      title: "Gmail compose button click to open compose modal dialog",
      detail: { note: "Click compose button to open compose modal dialog in Gmail." },
    });
    const result = await saveRecord({ record: dup });
    expect(result.possible_duplicate).toBeDefined();
    expect(result.possible_duplicate?.name).toBe("original-lesson");
    expect(result.possible_duplicate?.score).toBeGreaterThanOrEqual(0.8);
    // File should NOT have been written
    await expect(readRecord("new-lesson", "global")).rejects.toSatisfy(
      (e: unknown) => e instanceof CodedError && e.code === "MEMORY_NOT_FOUND",
    );
  });

  it("allows distinct records without flagging duplicates", async () => {
    const rec1 = globalRecord({
      name: "lesson-a",
      title: "Slack message sending tip",
      detail: { note: "Press Enter to send a message in Slack." },
    });
    await saveRecord({ record: rec1 });

    const rec2 = globalRecord({
      name: "lesson-b",
      title: "Gmail compose shortcut",
      detail: { note: "Use C to open compose in Gmail." },
    });
    const result = await saveRecord({ record: rec2 });
    expect(result.possible_duplicate).toBeUndefined();
    expect(result.created).toBe(true);
  });

  it("does not dedup when replace:true is set", async () => {
    const rec = globalRecord({
      name: "lesson-original",
      title: "Click compose in Gmail to open the compose dialog modal",
      detail: { note: "The button is in the upper left sidebar." },
    });
    await saveRecord({ record: rec });

    // Overwrite the same name — replace:true bypasses dedup
    const updated = globalRecord({
      name: "lesson-original",
      title: "Click compose in Gmail to open the compose dialog modal",
      detail: { note: "Updated: the button is now in the top bar." },
    });
    const result = await saveRecord({ record: updated, replace: true });
    expect(result.created).toBe(false);
    expect(result.possible_duplicate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// merge_into
// ---------------------------------------------------------------------------

describe("merge_into", () => {
  it("updates the target record and bumps captures", async () => {
    const original = globalRecord({
      name: "original",
      title: "Original title",
      detail: { note: "Original note." },
      stats: { hits: 5, resolved: 2, door_failures: 0, captures: 1 },
    });
    await saveRecord({ record: original });

    const patch = globalRecord({
      name: "patch",
      title: "Refined title",
      detail: { note: "Refined note." },
    });
    const result = await saveRecord({ record: patch, merge_into: "original" });
    expect(result.created).toBe(false);
    expect(result.record.name).toBe("original");
    expect(result.record.title).toBe("Refined title");
    expect(result.record.detail.note).toBe("Refined note.");
    expect(result.record.stats?.captures).toBe(2);
  });

  it("sets corroborated:true when captures reaches 2", async () => {
    const original = globalRecord({
      name: "to-corroborate",
      stats: { hits: 1, resolved: 0, door_failures: 0, captures: 1 },
    });
    await saveRecord({ record: original });

    const patch = globalRecord({ name: "p2" });
    const result = await saveRecord({ record: patch, merge_into: "to-corroborate" });
    expect(result.record.meta?.corroborated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listRecords with filters
// ---------------------------------------------------------------------------

describe("listRecords filters", () => {
  it("returns only global records when scope=global", async () => {
    await saveRecord({ record: globalRecord({ name: "g1" }) });
    await saveRecord({ record: siteRecord({ name: "s1" }) });
    const records = await listRecords({ scope: "global" });
    expect(records.map((r) => r.name)).toContain("g1");
    expect(records.map((r) => r.name)).not.toContain("s1");
  });

  it("returns only site records when scope=site", async () => {
    await saveRecord({ record: globalRecord({ name: "g1" }) });
    await saveRecord({ record: siteRecord({ name: "s1" }) });
    const records = await listRecords({ scope: "site" });
    expect(records.map((r) => r.name)).not.toContain("g1");
    expect(records.map((r) => r.name)).toContain("s1");
  });

  it("filters by origin", async () => {
    await saveRecord({ record: siteRecord({ name: "s-example" }) });
    await saveRecord({
      record: siteRecord({
        name: "s-other",
        origin: "https://other.com",
        title: "Other site blocker",
        detail: { wall: "Wall.", door: "Door." },
      }),
    });
    const records = await listRecords({ origin: "https://www.example.com" });
    expect(records.map((r) => r.name)).toContain("s-example");
    expect(records.map((r) => r.name)).not.toContain("s-other");
  });
});

// ---------------------------------------------------------------------------
// Redaction guard
// ---------------------------------------------------------------------------

describe("checkRedaction", () => {
  it("rejects a record with an email address", () => {
    const rec = globalRecord({ detail: { note: "Contact user@example.com for details." } });
    const result = checkRedaction(rec);
    expect(result).not.toBeNull();
    expect(result).toMatch(/email/);
  });

  it("rejects a record with a long digit run", () => {
    const rec = globalRecord({ detail: { note: "Call us at 1234567890 for support." } });
    const result = checkRedaction(rec);
    expect(result).not.toBeNull();
    expect(result).toMatch(/digit/);
  });

  it("rejects a record with a Bearer token", () => {
    const rec = globalRecord({ detail: { note: "Use Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 in the header." } });
    const result = checkRedaction(rec);
    expect(result).not.toBeNull();
    expect(result).toMatch(/secret|token/);
  });

  it("allows clean records", () => {
    const rec = globalRecord();
    const result = checkRedaction(rec);
    expect(result).toBeNull();
  });

  it("saveRecord rejects PII with MEMORY_PII_REJECTED", async () => {
    const rec = globalRecord({ detail: { note: "Send to admin@company.com" } });
    await expect(saveRecord({ record: rec })).rejects.toSatisfy(
      (e: unknown) => e instanceof CodedError && e.code === "MEMORY_PII_REJECTED",
    );
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe("migrateLegacyMarkdown", () => {
  it("is a no-op when no .md files exist", async () => {
    const result = await migrateLegacyMarkdown();
    expect(result.migrated).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("migrates a legacy .md file to global/lesson YAML", async () => {
    // Write a legacy markdown file
    await fs.mkdir(tmpRoot, { recursive: true });
    const legacyContent = [
      "---",
      "name: old-tip",
      "description: An old tip about Slack",
      "type: feedback",
      "source: cli",
      "created: 2025-01-01T00:00:00.000Z",
      "updated: 2025-01-15T00:00:00.000Z",
      "---",
      "",
      "Press Ctrl+K to open the channel switcher in Slack.",
    ].join("\n");
    await fs.writeFile(path.join(tmpRoot, "old-tip.md"), legacyContent, "utf8");

    const result = await migrateLegacyMarkdown();
    expect(result.migrated).toContain("old-tip");
    expect(result.errors).toHaveLength(0);

    // Check the v2 record was created
    const record = await readRecord("old-tip", "global");
    expect(record.schema_version).toBe(1);
    expect(record.scope).toBe("global");
    expect(record.kind).toBe("lesson");
    expect(record.title).toBe("An old tip about Slack");
    expect(record.detail.note).toContain("Ctrl+K");
    expect(record.meta?.source).toBe("cli");
    expect(record.meta?.created).toBe("2025-01-01T00:00:00.000Z");
  });

  it("moves original .md to _legacy/ after migration", async () => {
    await fs.mkdir(tmpRoot, { recursive: true });
    const legacyContent = [
      "---",
      "name: to-move",
      "description: Something to move",
      "type: project",
      "source: mcp-tool",
      "created: 2025-06-01T00:00:00.000Z",
      "updated: 2025-06-01T00:00:00.000Z",
      "---",
      "",
      "Some body text.",
    ].join("\n");
    await fs.writeFile(path.join(tmpRoot, "to-move.md"), legacyContent, "utf8");

    await migrateLegacyMarkdown();

    // Original should no longer be at root
    await expect(fs.access(path.join(tmpRoot, "to-move.md"))).rejects.toBeTruthy();
    // Should be in _legacy/
    const stat = await fs.stat(path.join(tmpRoot, "_legacy", "to-move.md"));
    expect(stat.isFile()).toBe(true);
  });

  it("is idempotent when called twice", async () => {
    await fs.mkdir(tmpRoot, { recursive: true });
    const legacyContent = [
      "---",
      "name: idempotent-test",
      "description: Test idempotency",
      "type: user",
      "source: cli",
      "created: 2025-01-01T00:00:00.000Z",
      "updated: 2025-01-01T00:00:00.000Z",
      "---",
      "",
      "Body.",
    ].join("\n");
    await fs.writeFile(path.join(tmpRoot, "idempotent-test.md"), legacyContent, "utf8");

    const first = await migrateLegacyMarkdown();
    expect(first.migrated).toContain("idempotent-test");

    // Second call: no more .md in root, no-op
    const second = await migrateLegacyMarkdown();
    expect(second.migrated).toHaveLength(0);
    expect(second.errors).toHaveLength(0);
  });
});
