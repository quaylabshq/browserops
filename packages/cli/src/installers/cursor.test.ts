import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Cursor installer resolves ~/.cursor/mcp.json from os.homedir() at
 * module load. Point HOME at a temp dir and re-import for each test so we
 * never touch the real user config.
 */
describe("cursorInstaller.install idempotency", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "browserops-cursor-"));
    prevHome = process.env["HOME"];
    process.env["HOME"] = home;
    vi.resetModules();
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  async function loadInstaller() {
    const mod = await import("./cursor.js");
    return mod.cursorInstaller;
  }

  it("writes mcp.json on first install", async () => {
    const installer = await loadInstaller();
    const result = await installer.install({ command: "browserops-shim", args: [] });
    expect(result.changed).toBe(true);

    const raw = await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    expect(parsed.mcpServers["browserops"]?.command).toBe("browserops-shim");
  });

  it("returns changed:false when the browserops entry already matches", async () => {
    const installer = await loadInstaller();
    const spec = { command: "browserops-shim", args: [] as string[] };

    const first = await installer.install(spec);
    expect(first.changed).toBe(true);

    const second = await installer.install(spec);
    expect(second.changed).toBe(false);
    expect(second.message).toBe("no change");
    expect(second.backupPath).toBeUndefined();

    // No .bak.* litter from the no-op second install.
    const entries = await fs.readdir(path.join(home, ".cursor"));
    expect(entries.filter((name) => name.includes(".bak."))).toEqual([]);
  });

  it("rewrites and backs up when the command drifts", async () => {
    const installer = await loadInstaller();

    await installer.install({ command: "browserops-shim", args: [] });
    const drifted = await installer.install({
      command: "/usr/bin/node",
      args: ["/tmp/shim.js"],
    });

    expect(drifted.changed).toBe(true);
    expect(drifted.backupPath).toMatch(/mcp\.json\.bak\./);

    const raw = await fs.readFile(path.join(home, ".cursor", "mcp.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      mcpServers: Record<string, { command: string; args?: string[] }>;
    };
    expect(parsed.mcpServers["browserops"]).toEqual({
      command: "/usr/bin/node",
      args: ["/tmp/shim.js"],
    });
  });
});
