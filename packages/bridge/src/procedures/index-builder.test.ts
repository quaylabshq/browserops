import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { buildIndex, ensureIndex, readIndex, scanTree, writeIndex } from "./index-builder.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(import.meta.dirname ?? __dirname, ".pbidx-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeYaml(rel: string, doc: unknown): Promise<void> {
  const abs = path.join(tmpDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, YAML.stringify(doc), "utf8");
}

const leaf = (name: string, extras: Record<string, unknown> = {}) => ({
  schema_version: 1,
  name,
  description: `A leaf called ${name}`,
  kind: "leaf",
  steps: [{ id: "s1", do: "navigate", with: { url: "https://example.com" } }],
  ...extras,
});

describe("scanTree", () => {
  it("returns empty manifest on a missing tree", async () => {
    const manifest = await scanTree(path.join(tmpDir, "absent"));
    expect(manifest.procedures).toEqual({});
  });

  it("picks up shared leaves", async () => {
    await writeYaml("shared/demo_a/procedure.yaml", leaf("demo.a"));
    await writeYaml("shared/demo_b/procedure.yaml", leaf("demo.b"));

    const manifest = await scanTree(tmpDir);
    expect(Object.keys(manifest.procedures).sort()).toEqual(["demo.a", "demo.b"]);
    expect(manifest.procedures["demo.a"]!.kind).toBe("leaf");
    expect(manifest.procedures["demo.a"]!.path).toBe(
      path.join("shared", "demo_a", "procedure.yaml"),
    );
  });

  it("picks up composite + subs", async () => {
    await writeYaml("composite_x/procedure.yaml", {
      schema_version: 1,
      name: "composite.x",
      description: "x composite",
      kind: "composite",
      uses: ["composite.x.sub1"],
      steps: [{ id: "s1", do: "procedure_call", with: { name: "composite.x.sub1" } }],
    });
    await writeYaml("composite_x/subs/sub1/procedure.yaml", leaf("composite.x.sub1"));

    const manifest = await scanTree(tmpDir);
    expect(manifest.procedures["composite.x"]?.kind).toBe("composite");
    expect(manifest.procedures["composite.x"]?.subs).toEqual(["composite.x.sub1"]);
    expect(manifest.procedures["composite.x.sub1"]?.owner).toBe("composite.x");
    expect(manifest.procedures["composite.x.sub1"]?.usedBy).toEqual(["composite.x"]);
  });

  it("status defaults to draft", async () => {
    await writeYaml("shared/demo_draft/procedure.yaml", leaf("demo.draft"));
    const m = await scanTree(tmpDir);
    expect(m.procedures["demo.draft"]?.status).toBe("draft");
  });

  it("respects meta.status: trusted", async () => {
    await writeYaml(
      "shared/demo_trusted/procedure.yaml",
      leaf("demo.trusted", {
        meta: { version: 1, created: "2026-05-21T00:00:00Z", status: "trusted" },
      }),
    );
    const m = await scanTree(tmpDir);
    expect(m.procedures["demo.trusted"]?.status).toBe("trusted");
  });

  it("skips schema-invalid yaml with a warning", async () => {
    await writeYaml("shared/bad/procedure.yaml", { not: "valid" });
    const m = await scanTree(tmpDir);
    expect(m.procedures).toEqual({});
  });
});

describe("buildIndex / writeIndex / readIndex round-trip", () => {
  it("writes and reads the manifest", async () => {
    await writeYaml("shared/demo_a/procedure.yaml", leaf("demo.a"));
    const manifest = await buildIndex(tmpDir);
    await writeIndex(tmpDir, manifest);

    const read = await readIndex(tmpDir);
    expect(read).not.toBeNull();
    expect(read!.procedures["demo.a"]?.kind).toBe("leaf");
  });

  it("readIndex returns null for missing index", async () => {
    const read = await readIndex(tmpDir);
    expect(read).toBeNull();
  });
});

describe("ensureIndex", () => {
  it("builds + writes the index when none exists", async () => {
    await writeYaml("shared/demo_a/procedure.yaml", leaf("demo.a"));
    const m = await ensureIndex(tmpDir);
    expect(m.procedures["demo.a"]).toBeDefined();
    const onDisk = await readIndex(tmpDir);
    expect(onDisk).not.toBeNull();
  });

  it("rebuilds when a yaml is newer than the index", async () => {
    await writeYaml("shared/a/procedure.yaml", leaf("demo.a"));
    await ensureIndex(tmpDir);

    // Touch the yaml so its mtime is newer than the index's
    await new Promise((r) => setTimeout(r, 10));
    await writeYaml("shared/b/procedure.yaml", leaf("demo.b"));

    const m = await ensureIndex(tmpDir);
    expect(m.procedures["demo.a"]).toBeDefined();
    expect(m.procedures["demo.b"]).toBeDefined();
  });
});
