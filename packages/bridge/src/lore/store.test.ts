import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodedError,
  deleteLore,
  listLoreEntries,
  loreFilePath,
  readLore,
  saveLore,
} from "./store.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".store-test-"),
  );
  process.env["BROWSEROPS_LORE_DIR"] = tmpRoot;
});

afterEach(async () => {
  delete process.env["BROWSEROPS_LORE_DIR"];
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const BASE = {
  description: "round trip",
  type: "feedback" as const,
  body: "Body line one.\n",
};

describe("saveLore + readLore round-trip", () => {
  it("creates a file with valid frontmatter and returns created:true", async () => {
    const result = await saveLore({ ...BASE, name: "alpha" });
    expect(result.created).toBe(true);
    expect(result.entry.path).toBe(loreFilePath("alpha"));

    const round = await readLore("alpha");
    expect(round.meta.name).toBe("alpha");
    expect(round.meta.description).toBe("round trip");
    expect(round.meta.type).toBe("feedback");
    expect(round.meta.source).toBe("mcp-tool");
    expect(round.body).toBe("Body line one.\n");
  });

  it("preserves created timestamp on overwrite, advances updated", async () => {
    const first = await saveLore({ ...BASE, name: "beta" });
    const createdFirst = first.entry.meta.created;

    await new Promise((r) => setTimeout(r, 5));

    const second = await saveLore({
      ...BASE,
      name: "beta",
      body: "Updated body.\n",
      replace: true,
    });
    expect(second.created).toBe(false);
    expect(second.entry.meta.created).toBe(createdFirst);
    expect(second.entry.meta.updated >= createdFirst).toBe(true);
  });
});

describe("saveLore error mapping", () => {
  it("rejects an invalid name with INVALID_PARAMS", async () => {
    await expect(
      saveLore({ ...BASE, name: "Has Caps" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("rejects a duplicate name without replace:true with LORE_ALREADY_EXISTS", async () => {
    await saveLore({ ...BASE, name: "gamma" });
    await expect(saveLore({ ...BASE, name: "gamma" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "LORE_ALREADY_EXISTS",
    );
  });

  it("accepts replace:true on an existing name", async () => {
    await saveLore({ ...BASE, name: "delta" });
    const second = await saveLore({
      ...BASE,
      name: "delta",
      body: "Replaced.",
      replace: true,
    });
    expect(second.created).toBe(false);
  });

  it("rejects an empty description with INVALID_PARAMS", async () => {
    await expect(
      saveLore({ ...BASE, name: "epsilon", description: "   " }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });
});

describe("readLore error mapping", () => {
  it("throws LORE_NOT_FOUND when the file does not exist", async () => {
    await expect(readLore("ghost")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "LORE_NOT_FOUND",
    );
  });

  it("throws LORE_SCHEMA_INVALID when the file has no frontmatter", async () => {
    await fs.writeFile(loreFilePath("malformed"), "no frontmatter here", "utf8");
    await expect(readLore("malformed")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "LORE_SCHEMA_INVALID",
    );
  });

  it("throws LORE_SCHEMA_INVALID when type is not in the enum", async () => {
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
    await fs.writeFile(loreFilePath("bad-type"), text, "utf8");
    await expect(readLore("bad-type")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "LORE_SCHEMA_INVALID",
    );
  });
});

describe("deleteLore", () => {
  it("removes the file and returns the path", async () => {
    await saveLore({ ...BASE, name: "to-delete" });
    const result = await deleteLore("to-delete");
    expect(result.path).toBe(loreFilePath("to-delete"));
    await expect(readLore("to-delete")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "LORE_NOT_FOUND",
    );
  });

  it("throws LORE_NOT_FOUND when the file does not exist", async () => {
    await expect(deleteLore("never")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "LORE_NOT_FOUND",
    );
  });
});

describe("listLoreEntries", () => {
  it("returns [] when the root directory does not exist", async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    const result = await listLoreEntries();
    expect(result).toEqual([]);
  });

  it("returns parsed entries sorted by name", async () => {
    await saveLore({ ...BASE, name: "zeta" });
    await saveLore({ ...BASE, name: "alpha" });
    await saveLore({ ...BASE, name: "mu" });
    const entries = await listLoreEntries();
    expect(entries.map((e) => e.meta.name)).toEqual(["alpha", "mu", "zeta"]);
  });

  it("skips files whose frontmatter cannot be parsed", async () => {
    await saveLore({ ...BASE, name: "good" });
    await fs.writeFile(loreFilePath("broken"), "no frontmatter", "utf8");
    const entries = await listLoreEntries();
    expect(entries.map((e) => e.meta.name)).toEqual(["good"]);
  });

  it("ignores non-.md files and names that don't match the pattern", async () => {
    await saveLore({ ...BASE, name: "valid" });
    await fs.writeFile(path.join(tmpRoot, "notes.txt"), "ignored", "utf8");
    await fs.writeFile(path.join(tmpRoot, "Bad-Caps.md"), "ignored", "utf8");
    const entries = await listLoreEntries();
    expect(entries.map((e) => e.meta.name)).toEqual(["valid"]);
  });
});
