/**
 * Tests for the v2 record search: scope/origin/kind filters,
 * token-coverage ranking, and the confidence seam.
 */
import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "@browserops/shared";
import { searchRecords } from "./search.js";

function globalLesson(name: string, title: string, note: string): MemoryRecord {
  return {
    schema_version: 1,
    name,
    scope: "global",
    kind: "lesson",
    title,
    detail: { note },
  };
}

function siteBlocker(name: string, origin: string, title: string): MemoryRecord {
  return {
    schema_version: 1,
    name,
    scope: "site",
    kind: "blocker",
    origin,
    title,
    detail: { wall: "The wall.", door: "The door." },
  };
}

describe("searchRecords", () => {
  const records: MemoryRecord[] = [
    globalLesson("gmail-compose", "How to compose email in Gmail", "Click the Compose button in Gmail."),
    globalLesson("slack-send", "Sending messages in Slack", "Press Enter to send in Slack."),
    siteBlocker("notion-modal", "https://www.notion.so", "Notion modal blocks typing"),
    siteBlocker("gmail-cookie", "https://mail.google.com", "Gmail cookie consent banner"),
  ];

  it("returns all matches with no filters", () => {
    const result = searchRecords(records, "Gmail", { min_score: 0.1 });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.map((m) => m.name)).toContain("gmail-compose");
  });

  it("filters by scope=global", () => {
    const result = searchRecords(records, "modal send compose", {
      scope: "global",
      min_score: 0.1,
    });
    for (const m of result.matches) {
      expect(m.scope).toBe("global");
    }
    expect(result.matches.map((m) => m.name)).not.toContain("notion-modal");
  });

  it("filters by scope=site", () => {
    const result = searchRecords(records, "modal cookie", {
      scope: "site",
      min_score: 0.1,
    });
    for (const m of result.matches) {
      expect(m.scope).toBe("site");
    }
    expect(result.matches.map((m) => m.name)).not.toContain("gmail-compose");
  });

  it("filters by origin", () => {
    const result = searchRecords(records, "modal cookie banner", {
      origin: "https://mail.google.com",
      min_score: 0.1,
    });
    expect(result.matches.map((m) => m.name)).toContain("gmail-cookie");
    expect(result.matches.map((m) => m.name)).not.toContain("notion-modal");
  });

  it("filters by kind=blocker", () => {
    const result = searchRecords(records, "notion gmail cookie modal", {
      kind: "blocker",
      min_score: 0.1,
    });
    for (const m of result.matches) {
      expect(m.kind).toBe("blocker");
    }
    expect(result.matches.map((m) => m.name)).not.toContain("gmail-compose");
  });

  it("respects limit and reports truncated", () => {
    const manyRecords = Array.from({ length: 15 }, (_, i) =>
      globalLesson(`entry-${i}`, `shared keyword keyword entry ${i}`, "keyword content"),
    );
    const result = searchRecords(manyRecords, "keyword", { limit: 5 });
    expect(result.matches).toHaveLength(5);
    expect(result.total).toBe(15);
    expect(result.truncated).toBe(true);
  });

  it("confidence seam: records with higher confidence rank first", () => {
    const recs: MemoryRecord[] = [
      globalLesson("low-conf", "Gmail compose tip", "Click compose to write email."),
      globalLesson("high-conf", "Gmail send email tip", "Click compose button to open."),
    ];
    // Provide a confidenceOf that returns 0.9 for high-conf and 0.1 for low-conf
    const confidenceOf = (r: MemoryRecord) => (r.name === "high-conf" ? 0.9 : 0.1);
    const result = searchRecords(recs, "Gmail compose email", {
      min_score: 0.1,
      confidenceOf,
    });
    expect(result.matches[0]?.name).toBe("high-conf");
  });

  it("falls back to token coverage when confidenceOf returns 0 for all", () => {
    const recs: MemoryRecord[] = [
      globalLesson("exact-match", "Gmail compose", "Click compose button."),
      globalLesson("partial-match", "Something else", "Only one word: Gmail."),
    ];
    const result = searchRecords(recs, "Gmail compose button", { min_score: 0.1 });
    expect(result.matches[0]?.name).toBe("exact-match");
  });

  it("returns empty result for stop-words-only query", () => {
    const result = searchRecords(records, "the a is");
    expect(result.matches).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("match includes name, title, scope, kind, snippet", () => {
    const result = searchRecords(records, "Compose Gmail", { min_score: 0.1 });
    const match = result.matches.find((m) => m.name === "gmail-compose");
    expect(match).toBeDefined();
    expect(match?.title).toBe("How to compose email in Gmail");
    expect(match?.scope).toBe("global");
    expect(match?.kind).toBe("lesson");
    expect(typeof match?.snippet).toBe("string");
  });
});
