import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSync } from "./sync.js";

let assetsDir: string;
let homeDir: string;
let originalHome: string | undefined;

async function writeFixtureSkill(name: string, body: string): Promise<void> {
  const dir = path.join(assetsDir, "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body, "utf8");
}

async function writeFixtureExtension(): Promise<void> {
  const dir = path.join(assetsDir, "extension");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "manifest.json"), '{"name":"test"}', "utf8");
}

beforeEach(async () => {
  assetsDir = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".sync-test-assets-"),
  );
  homeDir = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".sync-test-home-"),
  );
  process.env["BROWSEROPS_ASSETS_DIR"] = assetsDir;
  originalHome = process.env["HOME"];
  process.env["HOME"] = homeDir;
});

afterEach(async () => {
  delete process.env["BROWSEROPS_ASSETS_DIR"];
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  await fs.rm(assetsDir, { recursive: true, force: true });
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe("runSync default targets", () => {
  it("runs skills + extension + mcp when no target is supplied", async () => {
    await writeFixtureSkill("browserops", "# main");
    await writeFixtureExtension();
    const report = await runSync();
    expect(report.skills).toBeDefined();
    expect(report.extension).toBeDefined();
    expect(report.mcp).toBeDefined();
  });

  it("runs only the targets explicitly listed", async () => {
    await writeFixtureSkill("browserops", "# main");
    await writeFixtureExtension();
    const report = await runSync({ targets: ["skills"] });
    expect(report.skills).toBeDefined();
    expect(report.extension).toBeUndefined();
    expect(report.mcp).toBeUndefined();
  });

  it("expands `all` to skills + extension + mcp", async () => {
    await writeFixtureSkill("browserops", "# main");
    await writeFixtureExtension();
    const report = await runSync({ targets: ["all"] });
    expect(report.skills).toBeDefined();
    expect(report.extension).toBeDefined();
    expect(report.mcp).toBeDefined();
  });
});

describe("runSync skills target", () => {
  it("installs every bundled skill on a fresh home", async () => {
    await writeFixtureSkill("browserops", "# main");
    await writeFixtureSkill("browserops-teach", "# teach");
    const report = await runSync({ targets: ["skills"] });
    const skillNames = (report.skills?.results ?? [])
      .map((r) => r.skillName)
      .sort();
    expect(skillNames).toEqual(["browserops", "browserops-teach"]);
    for (const r of report.skills?.results ?? []) {
      expect(r.changed).toBe(true);
      expect(r.targetPath.startsWith(homeDir)).toBe(true);
    }
  });

  it("is idempotent on a second run", async () => {
    await writeFixtureSkill("browserops", "# main");
    await runSync({ targets: ["skills"] });
    const second = await runSync({ targets: ["skills"] });
    for (const r of second.skills?.results ?? []) {
      expect(r.changed).toBe(false);
    }
  });

  it("dry-run reports without writing files", async () => {
    await writeFixtureSkill("browserops", "# main");
    const report = await runSync({ targets: ["skills"], dryRun: true });
    const target = report.skills?.results[0]?.targetPath ?? "";
    expect(target.length).toBeGreaterThan(0);
    await expect(fs.readFile(target, "utf8")).rejects.toBeDefined();
  });

  it("--force overwrites identical content", async () => {
    await writeFixtureSkill("browserops", "# main");
    await runSync({ targets: ["skills"] }); // first install
    const forced = await runSync({ targets: ["skills"], force: true });
    for (const r of forced.skills?.results ?? []) {
      expect(r.changed).toBe(true);
    }
  });
});

describe("runSync extension target", () => {
  it("copies bundled extension into <HOME>/.browserops/extension", async () => {
    await writeFixtureExtension();
    const report = await runSync({ targets: ["extension"] });
    expect(report.extension?.changed).toBe(true);
    const dest = report.extension?.dest ?? "";
    expect(
      await fs
        .readFile(path.join(dest, "manifest.json"), "utf8")
        .catch(() => null),
    ).toBe('{"name":"test"}');
  });

  it("warns when no bundled extension dir exists", async () => {
    const report = await runSync({ targets: ["extension"] });
    expect(report.extension?.changed).toBe(false);
    expect(report.extension?.message).toMatch(/bundled extension dir not found/);
  });

  it("dry-run reports a 'would refresh' message", async () => {
    await writeFixtureExtension();
    const report = await runSync({ targets: ["extension"], dryRun: true });
    expect(report.extension?.changed).toBe(true);
    expect(report.extension?.message).toMatch(/^would refresh /);
  });
});

describe("runSync mcp target", () => {
  it("returns a per-client array (shape contract)", async () => {
    // We can't fully isolate HOME here — paths.ts and the per-client
    // installers capture homedir() at module-load time, so MCP detection
    // sees whatever the test runner's real HOME has installed. The
    // contract worth asserting is that the target ran and produced an
    // array of {id, result} entries. Per-client behavior is exercised by
    // each installer's own tests (or, lacking those, by smoke runs).
    const report = await runSync({ targets: ["mcp"] });
    expect(Array.isArray(report.mcp)).toBe(true);
    for (const entry of report.mcp ?? []) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.result.changed).toBe("boolean");
      expect(typeof entry.result.message).toBe("string");
    }
  });
});
