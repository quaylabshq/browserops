import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  handleLoreDelete,
  handleLoreGet,
  handleLoreSave,
  handleLoreSearch,
} from "./handlers.js";
import { CodedError } from "./store.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".handlers-test-"),
  );
  process.env["BROWSEROPS_LORE_DIR"] = tmpRoot;
});

afterEach(async () => {
  delete process.env["BROWSEROPS_LORE_DIR"];
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const VALID = {
  name: "feedback_terse",
  description: "user wants terse responses",
  type: "feedback",
  body: "Keep responses under three sentences whenever possible.",
};

describe("handleLoreSave", () => {
  it("creates an entry and reports created:true", async () => {
    const result = await handleLoreSave({ ...VALID });
    expect(result.saved).toBe(true);
    expect(result.created).toBe(true);
  });

  it("rejects a duplicate without replace and accepts with replace:true", async () => {
    await handleLoreSave({ ...VALID });
    await expect(handleLoreSave({ ...VALID })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "LORE_ALREADY_EXISTS",
    );
    const second = await handleLoreSave({ ...VALID, replace: true });
    expect(second.created).toBe(false);
  });

  it("rejects bad params with INVALID_PARAMS", async () => {
    await expect(handleLoreSave({ ...VALID, name: "" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
    await expect(
      handleLoreSave({ ...VALID, type: "bogus" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });
});

describe("handleLoreGet", () => {
  it("returns the body, meta, and path for an existing lore entry", async () => {
    await handleLoreSave({ ...VALID });
    const got = await handleLoreGet({ name: VALID.name });
    expect(got.meta.name).toBe(VALID.name);
    expect(got.body.startsWith("Keep responses")).toBe(true);
    expect(got.path.endsWith(`${VALID.name}.md`)).toBe(true);
  });

  it("throws LORE_NOT_FOUND for an unknown name", async () => {
    await expect(handleLoreGet({ name: "nope" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "LORE_NOT_FOUND",
    );
  });
});

describe("handleLoreDelete", () => {
  it("removes the file and returns deleted:true", async () => {
    await handleLoreSave({ ...VALID });
    const result = await handleLoreDelete({ name: VALID.name });
    expect(result.deleted).toBe(true);
    await expect(handleLoreGet({ name: VALID.name })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "LORE_NOT_FOUND",
    );
  });
});

describe("handleLoreSearch", () => {
  beforeEach(async () => {
    await handleLoreSave({
      name: "gmail_compose",
      description: "tips for the gmail compose flow",
      type: "feedback",
      body: "send button is bottom-left",
    });
    await handleLoreSave({
      name: "slack_dm",
      description: "how to send a slack dm",
      type: "reference",
      body: "use cmd-k to switch channels",
    });
  });

  it("returns metadata-only matches with score and snippet", async () => {
    const result = (await handleLoreSearch({ query: "gmail send" })) as {
      matches: Array<{ name: string; snippet: string; score: number }>;
      total: number;
      truncated: boolean;
    };
    expect(result.matches[0]?.name).toBe("gmail_compose");
    expect(result.matches[0]?.score).toBeGreaterThan(0);
    expect(result.matches[0]?.snippet).toBeTypeOf("string");
  });

  it("filters by type", async () => {
    const result = (await handleLoreSearch({
      query: "send",
      type: "reference",
    })) as { matches: Array<{ name: string }> };
    expect(result.matches.map((m) => m.name)).toEqual(["slack_dm"]);
  });

  it("rejects invalid type filter with INVALID_PARAMS", async () => {
    await expect(
      handleLoreSearch({ query: "send", type: "bogus" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("rejects an empty query with INVALID_PARAMS", async () => {
    await expect(handleLoreSearch({ query: "" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });
});
