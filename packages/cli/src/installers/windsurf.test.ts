import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("windsurfInstaller.install idempotency", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "browserops-windsurf-"));
    prevHome = process.env["HOME"];
    process.env["HOME"] = home;
    vi.resetModules();
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("returns changed:false when the browserops entry already matches", async () => {
    const { windsurfInstaller } = await import("./windsurf.js");
    const spec = { command: "browserops-shim", args: [] as string[] };

    const first = await windsurfInstaller.install(spec);
    expect(first.changed).toBe(true);

    const second = await windsurfInstaller.install(spec);
    expect(second.changed).toBe(false);
    expect(second.message).toBe("no change");

    const dir = path.join(home, ".codeium", "windsurf");
    const entries = await fs.readdir(dir);
    expect(entries.filter((name) => name.includes(".bak."))).toEqual([]);
  });
});
