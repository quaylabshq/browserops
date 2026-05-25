import { describe, it, expect } from "vitest";
import {
  validateMemory,
  type MemoryRecord,
} from "./memory.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBlocker(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    schema_version: 1,
    name: "test.blocker",
    scope: "site",
    kind: "blocker",
    title: "Test blocker",
    origin: "https://example.com",
    detail: {
      wall: "The button is hidden behind a cookie banner.",
      door: "Dismiss the banner first by pressing Escape.",
    },
    ...overrides,
  };
}

function makeLesson(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    schema_version: 1,
    name: "test.lesson",
    scope: "global",
    kind: "lesson",
    title: "A useful lesson",
    detail: {
      note: "Always check the cookie banner before interacting.",
    },
    ...overrides,
  };
}

function makeSelector(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    schema_version: 1,
    name: "test.selector",
    scope: "site",
    kind: "selector",
    title: "Submit button locator",
    origin: "https://example.com",
    detail: {
      locator: { role: "button", name: "/^submit/i" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateMemory", () => {
  describe("name pattern", () => {
    it("accepts a valid name", () => {
      expect(validateMemory(makeLesson({ name: "my.lesson_name-ok" }))).toEqual([]);
    });

    it("rejects a name starting with a digit", () => {
      const errors = validateMemory(makeLesson({ name: "1bad" }));
      expect(errors.some((e) => e.field === "name")).toBe(true);
    });

    it("rejects a name with uppercase letters", () => {
      const errors = validateMemory(makeLesson({ name: "Bad.Name" }));
      expect(errors.some((e) => e.field === "name")).toBe(true);
    });

    it("rejects a name that is too long (>80 chars)", () => {
      const longName = "a" + "b".repeat(80); // 81 chars
      const errors = validateMemory(makeLesson({ name: longName }));
      expect(errors.some((e) => e.field === "name")).toBe(true);
    });

    it("accepts a name at the maximum length (80 chars)", () => {
      const maxName = "a" + "b".repeat(79); // 80 chars
      expect(validateMemory(makeLesson({ name: maxName }))).toEqual([]);
    });
  });

  describe("scope / origin rule", () => {
    it("passes when scope=global and no origin is set", () => {
      expect(validateMemory(makeLesson())).toEqual([]);
    });

    it("fails when scope=site and origin is missing", () => {
      const errors = validateMemory(makeBlocker({ origin: undefined }));
      expect(errors.some((e) => e.field === "origin")).toBe(true);
    });

    it("passes when scope=site and origin is present", () => {
      expect(validateMemory(makeBlocker())).toEqual([]);
    });

    it("fails when scope=global but origin is set", () => {
      const errors = validateMemory(
        makeLesson({ scope: "global", origin: "https://example.com" }),
      );
      expect(errors.some((e) => e.field === "origin")).toBe(true);
    });
  });

  describe("title cap", () => {
    it("accepts a title of exactly 120 chars", () => {
      const title = "a".repeat(120);
      expect(validateMemory(makeLesson({ title }))).toEqual([]);
    });

    it("rejects a title longer than 120 chars", () => {
      const title = "a".repeat(121);
      const errors = validateMemory(makeLesson({ title }));
      expect(errors.some((e) => e.field === "title")).toBe(true);
    });
  });

  describe("tags cap", () => {
    it("accepts exactly 10 tags", () => {
      const tags = Array.from({ length: 10 }, (_, i) => `tag${i}`);
      expect(validateMemory(makeLesson({ tags }))).toEqual([]);
    });

    it("rejects more than 10 tags", () => {
      const tags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
      const errors = validateMemory(makeLesson({ tags }));
      expect(errors.some((e) => e.field === "tags")).toBe(true);
    });
  });

  describe("kind / detail coherence — blocker", () => {
    it("passes when blocker has wall + door", () => {
      expect(validateMemory(makeBlocker())).toEqual([]);
    });

    it("fails when blocker is missing wall", () => {
      const r = makeBlocker();
      delete r.detail.wall;
      const errors = validateMemory(r);
      expect(errors.some((e) => e.field === "detail.wall")).toBe(true);
    });

    it("fails when blocker is missing door", () => {
      const r = makeBlocker();
      delete r.detail.door;
      const errors = validateMemory(r);
      expect(errors.some((e) => e.field === "detail.door")).toBe(true);
    });

    it("reports both missing fields when both are absent", () => {
      const r = makeBlocker();
      delete r.detail.wall;
      delete r.detail.door;
      const errors = validateMemory(r);
      expect(errors.some((e) => e.field === "detail.wall")).toBe(true);
      expect(errors.some((e) => e.field === "detail.door")).toBe(true);
    });
  });

  describe("kind / detail coherence — selector", () => {
    it("passes when selector has a locator", () => {
      expect(validateMemory(makeSelector())).toEqual([]);
    });

    it("fails when selector is missing locator", () => {
      const r = makeSelector();
      delete r.detail.locator;
      const errors = validateMemory(r);
      expect(errors.some((e) => e.field === "detail.locator")).toBe(true);
    });
  });

  describe("kind / detail coherence — lesson / affordance / gotcha", () => {
    it("passes when lesson has note", () => {
      expect(validateMemory(makeLesson())).toEqual([]);
    });

    it("fails when lesson is missing note", () => {
      const r = makeLesson();
      delete r.detail.note;
      const errors = validateMemory(r);
      expect(errors.some((e) => e.field === "detail.note")).toBe(true);
    });

    it("fails when affordance is missing note", () => {
      const r = makeLesson({ kind: "affordance" });
      delete r.detail.note;
      const errors = validateMemory(r);
      expect(errors.some((e) => e.field === "detail.note")).toBe(true);
    });

    it("fails when gotcha is missing note", () => {
      const r = makeLesson({ kind: "gotcha" });
      delete r.detail.note;
      const errors = validateMemory(r);
      expect(errors.some((e) => e.field === "detail.note")).toBe(true);
    });
  });

  describe("valid complete records", () => {
    it("passes a fully-populated blocker", () => {
      const r = makeBlocker({
        severity: "high",
        tags: ["cookie", "banner"],
        origin_wildcard: true,
        path_glob: "/checkout*",
        links: { procedures: ["checkout.complete"], memories: [] },
        stats: { hits: 5, resolved: 3, door_failures: 1, captures: 2 },
        meta: {
          version: 1,
          created: "2026-01-01T00:00:00Z",
          updated: "2026-01-01T00:00:00Z",
          source: "scribe",
          corroborated: true,
        },
      });
      expect(validateMemory(r)).toEqual([]);
    });

    it("passes a minimal global lesson", () => {
      expect(validateMemory(makeLesson())).toEqual([]);
    });
  });
});
