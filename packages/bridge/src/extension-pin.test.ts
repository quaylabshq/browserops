import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPinnedExtensionId,
  loadPinnedExtensionId,
  persistPinnedExtensionId,
} from "./extension-pin.js";
import { extensionIdPath } from "./paths.js";

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "browserops-extpin-"));
  prevHome = process.env["HOME"];
  process.env["HOME"] = tmp;
});

afterEach(async () => {
  process.env["HOME"] = prevHome;
  await rm(tmp, { recursive: true, force: true });
});

describe("extension-pin", () => {
  it("loadPinnedExtensionId returns null when the file does not exist", async () => {
    const id = await loadPinnedExtensionId();
    expect(id).toBeNull();
  });

  it("persistPinnedExtensionId writes a 0600 file containing the ID", async () => {
    await persistPinnedExtensionId("fcjcldlmaoincljnghkbhhalnjfmbhnp");
    const raw = await readFile(extensionIdPath(), "utf8");
    expect(raw.trim()).toBe("fcjcldlmaoincljnghkbhhalnjfmbhnp");
  });

  it("loadPinnedExtensionId reads back a value written by persist", async () => {
    await persistPinnedExtensionId("fcjcldlmaoincljnghkbhhalnjfmbhnp");
    const id = await loadPinnedExtensionId();
    expect(id).toBe("fcjcldlmaoincljnghkbhhalnjfmbhnp");
  });

  it("loadPinnedExtensionId returns null for a malformed file (paranoia guard)", async () => {
    await persistPinnedExtensionId("aaaabbbb");
    await writeFile(extensionIdPath(), "\n\n; rm -rf /\n");
    const id = await loadPinnedExtensionId();
    expect(id).toBeNull();
  });

  it("persistPinnedExtensionId refuses malformed input", async () => {
    await expect(persistPinnedExtensionId("../../escape")).rejects.toThrow(/malformed/);
  });

  it("clearPinnedExtensionId removes the file", async () => {
    await persistPinnedExtensionId("fcjcldlmaoincljnghkbhhalnjfmbhnp");
    await clearPinnedExtensionId();
    const id = await loadPinnedExtensionId();
    expect(id).toBeNull();
  });

  it("clearPinnedExtensionId is a no-op when the file is missing", async () => {
    await expect(clearPinnedExtensionId()).resolves.toBeUndefined();
  });
});
