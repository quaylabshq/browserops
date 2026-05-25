/**
 * Tests for the v2 memory search (Phase 4.4+).
 *
 * The legacy searchMemories (MemoryEntry / markdown) was removed in Phase 4.4.
 * This file covers searchRecords / searchRecordsWithConfidence.
 */
import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@browserops/shared";
import { searchRecords, searchRecordsWithConfidence } from "./search.js";

function record(args: {
  name: string;
  title: string;
  note?: string;
  kind?: MemoryRecord["kind"];
  scope?: MemoryRecord["scope"];
  origin?: string;
  tags?: string[];
}): MemoryRecord {
  const scope = args.scope ?? "global";
  const base: MemoryRecord = {
    schema_version: 1,
    name: args.name,
    scope,
    kind: args.kind ?? "lesson",
    title: args.title,
    detail: { note: args.note ?? "" },
    tags: args.tags,
    ...(scope === "site" && args.origin ? { origin: args.origin } : {}),
  };
  return base;
}

describe("searchRecords", () => {
  it("returns no matches when the query has no usable tokens", () => {
    const records = [record({ name: "x", title: "y" })];
    const result = searchRecords(records, "the a is");
    expect(result.matches).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("ranks title matches higher than note-only matches", () => {
    const records = [
      record({
        name: "gmail-send-tips",
        title: "Gmail send button location",
        note: "no signal",
      }),
      record({
        name: "unrelated",
        title: "Unrelated title",
        note: "gmail send tips appear here",
      }),
    ];
    const result = searchRecords(records, "gmail send", { min_score: 0.1 });
    expect(result.matches[0]?.name).toBe("gmail-send-tips");
  });

  it("filters by kind when provided", () => {
    const records = [
      record({ name: "lesson-one", title: "A lesson", kind: "lesson" }),
      record({ name: "blocker-one", title: "A blocker lesson", kind: "blocker" }),
    ];
    const result = searchRecords(records, "lesson", { kind: "lesson", min_score: 0.1 });
    expect(result.matches.map((m) => m.name)).toEqual(["lesson-one"]);
  });

  it("filters by scope", () => {
    const global = record({ name: "global-one", title: "A global lesson", scope: "global" });
    const site = record({
      name: "site-one",
      title: "A site lesson",
      scope: "site",
      origin: "https://example.com",
    });
    const result = searchRecords([global, site], "lesson", { scope: "global", min_score: 0.1 });
    expect(result.matches.map((m) => m.name)).toEqual(["global-one"]);
  });

  it("filters by origin", () => {
    const a = record({
      name: "notion-one",
      title: "Notion lesson",
      scope: "site",
      origin: "https://www.notion.so",
    });
    const b = record({
      name: "slack-one",
      title: "Slack lesson",
      scope: "site",
      origin: "https://app.slack.com",
    });
    const result = searchRecords([a, b], "lesson", {
      origin: "https://www.notion.so",
      min_score: 0.1,
    });
    expect(result.matches.map((m) => m.name)).toEqual(["notion-one"]);
  });

  it("respects the limit and reports truncated correctly", () => {
    const records = Array.from({ length: 15 }, (_, i) =>
      record({ name: `entry-${i}`, title: `shared keyword keyword entry ${i}` }),
    );
    const result = searchRecords(records, "keyword", { limit: 5 });
    expect(result.matches).toHaveLength(5);
    expect(result.total).toBe(15);
    expect(result.truncated).toBe(true);
  });

  it("skips records below min_score", () => {
    const records = [
      record({ name: "alpha", title: "exactly one match: keyword" }),
    ];
    // Query has 3 distinct tokens; only "keyword" lands → coverage 1/3 ≈ 0.33.
    const result = searchRecords(records, "keyword zebra mango", { min_score: 0.5 });
    expect(result.matches).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("produces a title-derived snippet trimmed to ≤120 chars", () => {
    const longNote = "abc ".repeat(200);
    const records = [record({ name: "snip", title: "Snippet test", note: longNote })];
    const result = searchRecords(records, "snippet");
    expect(result.matches[0]?.snippet?.length ?? 0).toBeLessThanOrEqual(120);
  });

  it("result matches carry confidence:0 when no confidenceOf provided", () => {
    const records = [record({ name: "alpha", title: "alpha lesson note" })];
    const result = searchRecords(records, "lesson");
    expect(result.matches[0]?.confidence).toBe(0);
  });
});

describe("searchRecordsWithConfidence", () => {
  it("returns matches with a numeric confidence field", () => {
    const records = [record({ name: "alpha", title: "alpha lesson note" })];
    const result = searchRecordsWithConfidence(records, "lesson");
    expect(typeof result.matches[0]?.confidence).toBe("number");
  });
});
