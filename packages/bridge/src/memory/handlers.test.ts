/**
 * Tests for the v2 memory handlers (Phase 4.2+).
 *
 * The old legacy-API tests (name+description+type+body) were removed when the
 * handlers were rewired to the v2 store (saveRecord / readRecord / etc.).
 * The full dispatch + feature-gate tests live in the Phase 4.5 test file
 * (src/memory/memory-dispatch.test.ts). This file covers the handler
 * functions themselves.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMemorySessionTraceHandler,
  handleMemoryDelete,
  handleMemoryGet,
  handleMemoryListForOrigin,
  handleMemorySave,
  handleMemorySearch,
} from "./handlers.js";
import { CodedError } from "./store.js";
import type { MemoryRecord } from "@browserops/shared";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".handlers-test-"),
  );
  process.env["BROWSEROPS_MEMORY_DIR"] = tmpRoot;
});

afterEach(async () => {
  delete process.env["BROWSEROPS_MEMORY_DIR"];
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const VALID_RECORD: MemoryRecord = {
  schema_version: 1,
  name: "feedback.terse",
  scope: "global",
  kind: "lesson",
  title: "User wants terse responses",
  detail: { note: "Keep responses under three sentences whenever possible." },
};

const VALID_SITE_RECORD: MemoryRecord = {
  schema_version: 1,
  name: "notion.compose-blocker",
  scope: "site",
  origin: "https://www.notion.so",
  kind: "blocker",
  title: "Notion compose editor loses focus on first click",
  detail: {
    wall: "Clicking the compose button often does nothing on first try.",
    door: "Double-click or wait 500ms after page load before attempting to click.",
  },
};

describe("handleMemorySave (v2)", () => {
  it("creates a global record and reports created:true", async () => {
    const result = await handleMemorySave({ record: VALID_RECORD });
    expect(result.saved).toBe(true);
    expect(result.created).toBe(true);
  });

  it("rejects a duplicate without replace and accepts with replace:true", async () => {
    await handleMemorySave({ record: VALID_RECORD });
    await expect(handleMemorySave({ record: VALID_RECORD })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_ALREADY_EXISTS",
    );
    const second = await handleMemorySave({ record: VALID_RECORD, replace: true });
    expect(second.created).toBe(false);
  });

  it("rejects missing record with INVALID_PARAMS", async () => {
    await expect(handleMemorySave({})).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("rejects an invalid record (missing required field) with MEMORY_SCHEMA_INVALID", async () => {
    const bad = { ...VALID_RECORD, name: "INVALID NAME" } as unknown as Record<string, unknown>;
    await expect(handleMemorySave({ record: bad })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError &&
        (err.code === "MEMORY_SCHEMA_INVALID" || err.code === "INVALID_PARAMS"),
    );
  });

  it("creates a site-scoped record", async () => {
    const result = await handleMemorySave({ record: VALID_SITE_RECORD });
    expect(result.saved).toBe(true);
    expect(result.created).toBe(true);
  });
});

describe("handleMemoryGet (v2)", () => {
  it("returns the record and path for an existing global memory", async () => {
    await handleMemorySave({ record: VALID_RECORD });
    const got = await handleMemoryGet({ name: VALID_RECORD.name });
    expect(got.record.name).toBe(VALID_RECORD.name);
    expect(got.record.kind).toBe("lesson");
    expect(got.path).toContain(VALID_RECORD.name);
  });

  it("returns a site-scoped record by name", async () => {
    await handleMemorySave({ record: VALID_SITE_RECORD });
    const got = await handleMemoryGet({ name: VALID_SITE_RECORD.name });
    expect(got.record.name).toBe(VALID_SITE_RECORD.name);
    expect(got.record.scope).toBe("site");
  });

  it("throws MEMORY_NOT_FOUND for an unknown name", async () => {
    await expect(handleMemoryGet({ name: "nope" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_NOT_FOUND",
    );
  });
});

describe("handleMemoryDelete (v2)", () => {
  it("removes a global record and returns deleted:true", async () => {
    await handleMemorySave({ record: VALID_RECORD });
    const result = await handleMemoryDelete({ name: VALID_RECORD.name });
    expect(result.deleted).toBe(true);
    await expect(handleMemoryGet({ name: VALID_RECORD.name })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_NOT_FOUND",
    );
  });

  it("removes a site-scoped record", async () => {
    await handleMemorySave({ record: VALID_SITE_RECORD });
    const result = await handleMemoryDelete({ name: VALID_SITE_RECORD.name });
    expect(result.deleted).toBe(true);
  });

  it("throws MEMORY_NOT_FOUND for unknown name", async () => {
    await expect(handleMemoryDelete({ name: "nope" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_NOT_FOUND",
    );
  });
});

describe("handleMemorySearch (v2)", () => {
  beforeEach(async () => {
    await handleMemorySave({ record: VALID_RECORD });
    await handleMemorySave({ record: VALID_SITE_RECORD });
  });

  it("returns v2 matches with confidence and snippet", async () => {
    const result = (await handleMemorySearch({ query: "terse responses" })) as {
      matches: Array<{ name: string; snippet: string; score: number; confidence: number }>;
      total: number;
      truncated: boolean;
    };
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]?.name).toBe(VALID_RECORD.name);
    expect(result.matches[0]?.score).toBeGreaterThan(0);
    expect(typeof result.matches[0]?.confidence).toBe("number");
    expect(result.matches[0]?.snippet).toBeTypeOf("string");
  });

  it("filters by kind", async () => {
    const result = (await handleMemorySearch({
      query: "compose",
      kind: "blocker",
    })) as { matches: Array<{ name: string }> };
    expect(result.matches.map((m) => m.name)).toContain(VALID_SITE_RECORD.name);
  });

  it("filters by scope", async () => {
    const result = (await handleMemorySearch({
      query: "terse",
      scope: "global",
    })) as { matches: Array<{ name: string }> };
    expect(result.matches.map((m) => m.name)).toContain(VALID_RECORD.name);
  });

  it("rejects invalid kind filter with INVALID_PARAMS", async () => {
    await expect(
      handleMemorySearch({ query: "send", kind: "bogus" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("rejects an empty query with INVALID_PARAMS", async () => {
    await expect(handleMemorySearch({ query: "" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });
});

describe("handleMemoryListForOrigin (v2)", () => {
  beforeEach(async () => {
    await handleMemorySave({ record: VALID_SITE_RECORD });
  });

  it("returns site records for the given origin", async () => {
    const result = await handleMemoryListForOrigin({
      origin: "https://www.notion.so",
    });
    expect(result.total).toBeGreaterThan(0);
    expect(result.records[0]?.name).toBe(VALID_SITE_RECORD.name);
    expect(typeof result.records[0]?.confidence).toBe("number");
  });

  it("returns empty for unknown origin", async () => {
    const result = await handleMemoryListForOrigin({
      origin: "https://unknown.example.com",
    });
    expect(result.total).toBe(0);
    expect(result.records).toHaveLength(0);
  });
});

describe("handleMemorySessionTrace (no buffer)", () => {
  it("returns empty entries when no trace buffer is provided", async () => {
    const handler = buildMemorySessionTraceHandler(undefined, undefined);
    const result = await handler({ session_id: "s_test" });
    expect(result.entries).toEqual([]);
  });
});
