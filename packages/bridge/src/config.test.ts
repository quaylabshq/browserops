import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSafeMode } from "./config.js";

describe("loadSafeMode", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "browserops-config-"));
    path = join(dir, "config.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns false when the config file does not exist", async () => {
    await expect(loadSafeMode(join(dir, "missing.json"))).resolves.toBe(false);
  });

  it("returns false when safe_mode is absent", async () => {
    await fs.writeFile(path, JSON.stringify({ features: { procedures: true } }));
    await expect(loadSafeMode(path)).resolves.toBe(false);
  });

  it("returns true only when safe_mode === true", async () => {
    await fs.writeFile(path, JSON.stringify({ safe_mode: true }));
    await expect(loadSafeMode(path)).resolves.toBe(true);
  });

  it("treats non-boolean / falsy safe_mode values as false", async () => {
    await fs.writeFile(path, JSON.stringify({ safe_mode: "true" }));
    await expect(loadSafeMode(path)).resolves.toBe(false);

    await fs.writeFile(path, JSON.stringify({ safe_mode: false }));
    await expect(loadSafeMode(path)).resolves.toBe(false);
  });

  it("returns false on malformed JSON rather than throwing", async () => {
    await fs.writeFile(path, "{ not json");
    await expect(loadSafeMode(path)).resolves.toBe(false);
  });
});
