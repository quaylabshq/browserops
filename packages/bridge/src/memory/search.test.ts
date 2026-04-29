import { describe, expect, it } from "vitest";
import type { MemoryEntry } from "@browserops/shared";
import { searchMemories } from "./search.js";

function entry(args: {
  name: string;
  description: string;
  body?: string;
  type?: MemoryEntry["meta"]["type"];
}): MemoryEntry {
  return {
    meta: {
      name: args.name,
      description: args.description,
      type: args.type ?? "feedback",
      source: "mcp-tool",
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
    },
    body: args.body ?? "",
    path: `/tmp/${args.name}.md`,
  };
}

describe("searchMemories", () => {
  it("returns no matches when the query has no usable tokens", () => {
    const entries = [entry({ name: "x", description: "y", body: "z" })];
    const result = searchMemories(entries, "the a is");
    expect(result.matches).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("ranks name matches higher than body-only matches", () => {
    const entries = [
      entry({
        name: "gmail-send-tips",
        description: "unrelated description",
        body: "no signal here",
      }),
      entry({
        name: "unrelated",
        description: "unrelated description",
        body: "gmail send tips appear deep in body",
      }),
    ];
    const result = searchMemories(entries, "gmail send", { min_score: 0.1 });
    expect(result.matches[0]?.name).toBe("gmail-send-tips");
  });

  it("filters by type when provided", () => {
    const entries = [
      entry({
        name: "u-pref",
        description: "user preference for X",
        type: "user",
      }),
      entry({
        name: "f-rule",
        description: "feedback rule about X",
        type: "feedback",
      }),
    ];
    const result = searchMemories(entries, "preference rule", {
      type: "user",
      min_score: 0.1,
    });
    expect(result.matches.map((m) => m.name)).toEqual(["u-pref"]);
  });

  it("respects the limit and reports truncated correctly", () => {
    const entries = Array.from({ length: 15 }, (_, i) =>
      entry({
        name: `entry-${i}`,
        description: "shared keyword keyword",
        body: "",
      }),
    );
    const result = searchMemories(entries, "keyword", { limit: 5 });
    expect(result.matches).toHaveLength(5);
    expect(result.total).toBe(15);
    expect(result.truncated).toBe(true);
  });

  it("skips entries below min_score", () => {
    const entries = [
      entry({
        name: "alpha",
        description: "exactly one match: keyword",
        body: "",
      }),
    ];
    // Query has 3 distinct tokens; only "keyword" lands → coverage 1/3 ≈ 0.33.
    const result = searchMemories(entries, "keyword zebra mango", {
      min_score: 0.5,
    });
    expect(result.matches).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("produces a body-derived snippet trimmed to ≤120 chars", () => {
    const longBody = "abc ".repeat(200);
    const entries = [
      entry({ name: "snip", description: "snippet test", body: longBody }),
    ];
    const result = searchMemories(entries, "snippet");
    expect(result.matches[0]?.snippet?.length ?? 0).toBeLessThanOrEqual(120);
  });
});
