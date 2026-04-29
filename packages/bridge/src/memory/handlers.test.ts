import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleMemoryDelete,
  handleMemoryGet,
  handleMemorySave,
  handleMemorySearch,
} from "./handlers.js";
import { CodedError } from "./store.js";

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

const VALID = {
  name: "feedback_terse",
  description: "user wants terse responses",
  type: "feedback",
  body: "Keep responses under three sentences whenever possible.",
};

describe("handleMemorySave", () => {
  it("creates a memory and reports created:true", async () => {
    const result = await handleMemorySave({ ...VALID });
    expect(result.saved).toBe(true);
    expect(result.created).toBe(true);
  });

  it("rejects a duplicate without replace and accepts with replace:true", async () => {
    await handleMemorySave({ ...VALID });
    await expect(handleMemorySave({ ...VALID })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_ALREADY_EXISTS",
    );
    const second = await handleMemorySave({ ...VALID, replace: true });
    expect(second.created).toBe(false);
  });

  it("rejects bad params with INVALID_PARAMS", async () => {
    await expect(handleMemorySave({ ...VALID, name: "" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
    await expect(
      handleMemorySave({ ...VALID, type: "bogus" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });
});

describe("handleMemoryGet", () => {
  it("returns the body, meta, and path for an existing memory", async () => {
    await handleMemorySave({ ...VALID });
    const got = await handleMemoryGet({ name: VALID.name });
    expect(got.meta.name).toBe(VALID.name);
    expect(got.body.startsWith("Keep responses")).toBe(true);
    expect(got.path.endsWith(`${VALID.name}.md`)).toBe(true);
  });

  it("throws MEMORY_NOT_FOUND for an unknown name", async () => {
    await expect(handleMemoryGet({ name: "nope" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_NOT_FOUND",
    );
  });
});

describe("handleMemoryDelete", () => {
  it("removes the file and returns deleted:true", async () => {
    await handleMemorySave({ ...VALID });
    const result = await handleMemoryDelete({ name: VALID.name });
    expect(result.deleted).toBe(true);
    await expect(handleMemoryGet({ name: VALID.name })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "MEMORY_NOT_FOUND",
    );
  });
});

describe("handleMemorySearch", () => {
  beforeEach(async () => {
    await handleMemorySave({
      name: "gmail_compose",
      description: "tips for the gmail compose flow",
      type: "feedback",
      body: "send button is bottom-left",
    });
    await handleMemorySave({
      name: "slack_dm",
      description: "how to send a slack dm",
      type: "reference",
      body: "use cmd-k to switch channels",
    });
  });

  it("returns metadata-only matches with score and snippet", async () => {
    const result = (await handleMemorySearch({ query: "gmail send" })) as {
      matches: Array<{ name: string; snippet: string; score: number }>;
      total: number;
      truncated: boolean;
    };
    expect(result.matches[0]?.name).toBe("gmail_compose");
    expect(result.matches[0]?.score).toBeGreaterThan(0);
    expect(result.matches[0]?.snippet).toBeTypeOf("string");
  });

  it("filters by type", async () => {
    const result = (await handleMemorySearch({
      query: "send",
      type: "reference",
    })) as { matches: Array<{ name: string }> };
    expect(result.matches.map((m) => m.name)).toEqual(["slack_dm"]);
  });

  it("rejects invalid type filter with INVALID_PARAMS", async () => {
    await expect(
      handleMemorySearch({ query: "send", type: "bogus" }),
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
