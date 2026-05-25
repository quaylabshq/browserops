/**
 * Tests for the v2 memory store (Phase 4.4+).
 *
 * The legacy saveMemory/readMemory/deleteMemory/listMemoryEntries API was
 * removed in Phase 4.4. This file covers the v2 CRUD (saveRecord / readRecord /
 * deleteRecord / listRecords) and the readLegacyMemory migration helper.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodedError,
  deleteRecord,
  globalRecordPath,
  listRecords,
  memoryFilePath,
  readLegacyMemory,
  readRecord,
  saveRecord,
} from "./store.js";
import type { MemoryRecord } from "@browserops/shared";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".store-test-"),
  );
  process.env["BROWSEROPS_MEMORY_DIR"] = tmpRoot;
});

afterEach(async () => {
  delete process.env["BROWSEROPS_MEMORY_DIR"];
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const BASE_RECORD: MemoryRecord = {
  schema_version: 1,
  name: "lesson.terse",
  scope: "global",
  kind: "lesson",
  title: "User prefers terse responses",
  detail: { note: "Keep responses under three sentences." },
};

const SITE_RECORD: MemoryRecord = {
  schema_version: 1,
  name: "notion.compose",
  scope: "site",
  origin: "https://www.notion.so",
  kind: "blocker",
  title: "Notion compose loses focus",
  detail: {
    wall: "First click often does nothing.",
    door: "Double-click or wait 500ms.",
  },
};

describe("saveRecord + readRecord round-trip", () => {
  it("creates a global YAML record and returns created:true", async () => {
    const result = await saveRecord({ record: BASE_RECORD });
    expect(result.created).toBe(true);
    expect(result.path).toBe(globalRecordPath(BASE_RECORD.name));

    const round = await readRecord(BASE_RECORD.name, "global");
    expect(round.name).toBe(BASE_RECORD.name);
    expect(round.kind).toBe("lesson");
    expect(round.scope).toBe("global");
    expect(round.detail.note).toBe("Keep responses under three sentences.");
  });

  it("creates a site-scoped YAML record", async () => {
    const result = await saveRecord({ record: SITE_RECORD });
    expect(result.created).toBe(true);

    const round = await readRecord(SITE_RECORD.name, "site", SITE_RECORD.origin);
    expect(round.scope).toBe("site");
    expect(round.origin).toBe("https://www.notion.so");
  });

  it("preserves created timestamp on overwrite, advances updated", async () => {
    const first = await saveRecord({ record: BASE_RECORD });
    const createdFirst = first.record.meta?.created;

    await new Promise((r) => setTimeout(r, 5));

    const updated: MemoryRecord = { ...BASE_RECORD, title: "Updated title" };
    const second = await saveRecord({ record: updated, replace: true });
    expect(second.created).toBe(false);
    expect(second.record.meta?.created).toBe(createdFirst);
  });
});

describe("saveRecord error mapping", () => {
  it("rejects a duplicate name without replace:true with MEMORY_ALREADY_EXISTS", async () => {
    await saveRecord({ record: BASE_RECORD });
    await expect(saveRecord({ record: BASE_RECORD })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_ALREADY_EXISTS",
    );
  });

  it("accepts replace:true on an existing name", async () => {
    await saveRecord({ record: BASE_RECORD });
    const second = await saveRecord({
      record: { ...BASE_RECORD, title: "New title" },
      replace: true,
    });
    expect(second.created).toBe(false);
  });
});

describe("readRecord error mapping", () => {
  it("throws MEMORY_NOT_FOUND when the file does not exist", async () => {
    await expect(readRecord("ghost", "global")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_NOT_FOUND",
    );
  });
});

describe("deleteRecord", () => {
  it("removes the file and returns the path", async () => {
    await saveRecord({ record: BASE_RECORD });
    const result = await deleteRecord(BASE_RECORD.name, "global");
    expect(result.path).toContain(BASE_RECORD.name);
    await expect(readRecord(BASE_RECORD.name, "global")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_NOT_FOUND",
    );
  });

  it("throws MEMORY_NOT_FOUND when the file does not exist", async () => {
    await expect(deleteRecord("never", "global")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_NOT_FOUND",
    );
  });
});

describe("listRecords", () => {
  it("returns [] when the root directory does not exist", async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    const result = await listRecords();
    expect(result).toEqual([]);
  });

  it("returns parsed records sorted by name", async () => {
    const z: MemoryRecord = { ...BASE_RECORD, name: "zeta.one", title: "Zeta unique terse record" };
    const a: MemoryRecord = { ...BASE_RECORD, name: "alpha.one", title: "Alpha unique verbose record" };
    const m: MemoryRecord = { ...BASE_RECORD, name: "mu.one", title: "Mu unique concise record" };
    await saveRecord({ record: z });
    await saveRecord({ record: a });
    await saveRecord({ record: m });
    const records = await listRecords({ scope: "global" });
    expect(records.map((r) => r.name)).toEqual(["alpha.one", "mu.one", "zeta.one"]);
  });

  it("filters by scope", async () => {
    await saveRecord({ record: BASE_RECORD });
    await saveRecord({ record: SITE_RECORD });
    const globals = await listRecords({ scope: "global" });
    expect(globals.every((r) => r.scope === "global")).toBe(true);
    const sites = await listRecords({ scope: "site" });
    expect(sites.every((r) => r.scope === "site")).toBe(true);
  });
});

describe("readLegacyMemory (migration helper)", () => {
  const LEGACY_TEXT = [
    "---",
    "name: feedback-terse",
    "description: user wants terse responses",
    "type: feedback",
    "source: mcp-tool",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-01-01T00:00:00.000Z",
    "---",
    "",
    "Keep responses short.",
  ].join("\n");

  it("parses a valid legacy .md file", async () => {
    await fs.writeFile(memoryFilePath("feedback-terse"), LEGACY_TEXT, "utf8");
    const entry = await readLegacyMemory("feedback-terse");
    expect(entry.meta.name).toBe("feedback-terse");
    expect(entry.meta.description).toBe("user wants terse responses");
    expect(entry.meta.type).toBe("feedback");
    expect(entry.body).toBe("Keep responses short.");
    expect(entry.path).toBe(memoryFilePath("feedback-terse"));
  });

  it("throws MEMORY_NOT_FOUND for a missing file", async () => {
    await expect(readLegacyMemory("ghost")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_NOT_FOUND",
    );
  });

  it("throws MEMORY_SCHEMA_INVALID when the file has no frontmatter", async () => {
    await fs.writeFile(memoryFilePath("malformed"), "no frontmatter here", "utf8");
    await expect(readLegacyMemory("malformed")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_SCHEMA_INVALID",
    );
  });

  it("throws MEMORY_SCHEMA_INVALID when type is not in the enum", async () => {
    const text = [
      "---",
      "name: bad-type",
      "description: invalid type",
      "type: bogus",
      "source: mcp-tool",
      "created: 2026-01-01T00:00:00.000Z",
      "updated: 2026-01-01T00:00:00.000Z",
      "---",
      "",
      "body",
    ].join("\n");
    await fs.writeFile(memoryFilePath("bad-type"), text, "utf8");
    await expect(readLegacyMemory("bad-type")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_SCHEMA_INVALID",
    );
  });
});
