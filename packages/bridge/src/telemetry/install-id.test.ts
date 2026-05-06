import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateInstallId } from "./install-id.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("install-id", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bops-iid-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a new file with a valid UUID on first call", async () => {
    const path = join(dir, "install-id");
    const r = await loadOrCreateInstallId(path);
    expect(r.created).toBe(true);
    expect(r.volatile).toBe(false);
    expect(UUID_RE.test(r.id)).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe(r.id);
  });

  it("reuses an existing valid UUID", async () => {
    const path = join(dir, "install-id");
    const first = await loadOrCreateInstallId(path);
    const second = await loadOrCreateInstallId(path);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("regenerates on malformed contents", async () => {
    const path = join(dir, "install-id");
    writeFileSync(path, "not-a-uuid\n", "utf8");
    const r = await loadOrCreateInstallId(path);
    expect(r.created).toBe(true);
    expect(UUID_RE.test(r.id)).toBe(true);
  });

  it("creates parent directory if missing", async () => {
    const path = join(dir, "nested", "deeper", "install-id");
    const r = await loadOrCreateInstallId(path);
    expect(r.created).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe(r.id);
  });
});
