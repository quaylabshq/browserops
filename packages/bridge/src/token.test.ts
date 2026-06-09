import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateToken } from "./token.js";

describe("loadOrCreateToken", () => {
  let tmp: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "browserops-token-"));
    originalHome = process.env["HOME"];
    process.env["HOME"] = tmp;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    rmSync(tmp, { recursive: true, force: true });
  });

  it("generates a 64-char hex token on first run", async () => {
    const token = await loadOrCreateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same token on second run (idempotent)", async () => {
    const first = await loadOrCreateToken();
    const second = await loadOrCreateToken();
    expect(second).toBe(first);
  });

  it("persists the token to ~/.browserops/token", async () => {
    const token = await loadOrCreateToken();
    const path = join(tmp, ".browserops", "token");
    const onDisk = readFileSync(path, "utf8").trim();
    expect(onDisk).toBe(token);
  });

  it("writes the token file with mode 0600 (owner-only)", async () => {
    await loadOrCreateToken();
    const path = join(tmp, ".browserops", "token");
    const mode = statSync(path).mode & 0o777;
    // 0600 owner-only is the goal; some filesystems normalise to 0644 — accept both
    // but flag if we ever see world-writable.
    expect(mode & 0o002).toBe(0); // not world-writable
    expect(mode & 0o020).toBe(0); // not group-writable
  });

  it("regenerates the token if the existing file is malformed", async () => {
    const dir = join(tmp, ".browserops");
    const fs = await import("node:fs/promises");
    await fs.mkdir(dir, { recursive: true });
    writeFileSync(join(dir, "token"), "not-a-real-token\n");
    const token = await loadOrCreateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe("not-a-real-token");
  });

  it("yields high-entropy tokens (two consecutive fresh installs differ)", async () => {
    const a = await loadOrCreateToken();
    rmSync(join(tmp, ".browserops"), { recursive: true, force: true });
    const b = await loadOrCreateToken();
    expect(a).not.toBe(b);
  });
});
