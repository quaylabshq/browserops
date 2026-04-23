/**
 * Tests for index-builder: scanTree, buildIndex, writeIndex, readIndex, ensureIndex.
 *
 * Each test operates on a temp directory created in beforeAll/beforeEach so
 * the real ~/browserops/procedures/ is never touched.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildIndex,
  ensureIndex,
  readIndex,
  scanTree,
  writeIndex,
} from "./index-builder.js";

// ---------------------------------------------------------------------------
// Fixture YAML content
// ---------------------------------------------------------------------------

const LEAF_A_YAML = `\
schema_version: 1
name: leaf_a
description: A simple leaf procedure for testing
kind: leaf
triggers:
  - test the leaf
  - run leaf_a now
tags: [testing, leaf]
inputs:
  url: { type: string, required: true }
steps:
  - id: step1
    action: browser_navigate
    with:
      url: "{{input.url}}"
`;

const LEAF_B_DOMAIN_YAML = `\
schema_version: 1
name: leaf_b.domain
description: A leaf with domain prefix
kind: leaf
domain: b
triggers:
  - trigger for b
tags: [domain, b]
steps:
  - id: step1
    action: browser_click
    with:
      ref: 1
`;

const COMPOSITE_X_YAML = `\
schema_version: 1
name: composite_x
description: A composite procedure that uses sub_one and leaf_a
kind: composite
uses:
  - sub_one
  - leaf_a
tags: [composite, multi]
steps:
  - id: run_sub
    action: sub_one
    with: {}
  - id: run_leaf
    action: leaf_a
    with:
      url: "https://example.com"
`;

const SUB_ONE_YAML = `\
schema_version: 1
name: sub_one
description: First sub-procedure owned by composite_x
kind: leaf
triggers:
  - run sub one
tags: [sub]
steps:
  - id: step1
    action: browser_click
    with:
      ref: 2
`;

const SUB_TWO_YAML = `\
schema_version: 1
name: sub_two
description: Second sub-procedure owned by composite_x not referenced
kind: leaf
tags: [sub, orphan]
steps:
  - id: step1
    action: browser_click
    with:
      ref: 3
`;

// Intentionally malformed YAML (unclosed bracket)
const BROKEN_C_YAML = `\
name: [unclosed
description: this will fail YAML parsing
`;

// Valid YAML but fails schema (composite without uses)
const BAD_SCHEMA_D_YAML = `\
schema_version: 1
name: bad_schema_d
description: This composite lacks required uses field
kind: composite
steps:
  - id: step1
    action: browser_click
    with:
      ref: 1
`;

// ---------------------------------------------------------------------------
// Fixture tree builder
// ---------------------------------------------------------------------------

async function writeFixture(root: string): Promise<void> {
  async function writeFile(relParts: string[], content: string): Promise<void> {
    const abs = path.join(root, ...relParts);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  // Shared procedures
  await writeFile(["shared", "leaf_a", "procedure.yaml"], LEAF_A_YAML);
  await writeFile(["shared", "leaf_b.domain", "procedure.yaml"], LEAF_B_DOMAIN_YAML);
  await writeFile(["shared", "broken_c", "procedure.yaml"], BROKEN_C_YAML);
  await writeFile(["shared", "bad_schema_d", "procedure.yaml"], BAD_SCHEMA_D_YAML);

  // Composite and its subs
  await writeFile(["composite_x", "procedure.yaml"], COMPOSITE_X_YAML);
  await writeFile(["composite_x", "subs", "sub_one", "procedure.yaml"], SUB_ONE_YAML);
  await writeFile(["composite_x", "subs", "sub_two", "procedure.yaml"], SUB_TWO_YAML);

  // Wrong-named file (should be ignored by scanner)
  await writeFile(["composite_x", "procedure.yaml.malformed"], "this is not a yaml\n");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("scanTree", () => {
  let tmpDir: string;
  let manifest: Awaited<ReturnType<typeof scanTree>>;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(import.meta.dirname ?? __dirname, ".index-builder-test-"),
    );
    await writeFixture(tmpDir);
    // Capture stderr during scan (broken + bad_schema entries produce warnings)
    manifest = await scanTree(tmpDir);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns exactly 5 valid procedures (skips broken_c and bad_schema_d)", () => {
    const names = Object.keys(manifest.procedures);
    expect(names).toHaveLength(5);
    expect(names).toContain("leaf_a");
    expect(names).toContain("leaf_b.domain");
    expect(names).toContain("composite_x");
    expect(names).toContain("sub_one");
    expect(names).toContain("sub_two");
    // Broken ones must be absent
    expect(names).not.toContain("broken_c");
    expect(names).not.toContain("bad_schema_d");
  });

  it("usedBy: leaf_a is used by composite_x", () => {
    const entry = manifest.procedures["leaf_a"]!;
    expect(entry).toBeDefined();
    expect(entry.usedBy).toContain("composite_x");
  });

  it("usedBy: sub_one is used by composite_x", () => {
    const entry = manifest.procedures["sub_one"]!;
    expect(entry).toBeDefined();
    expect(entry.usedBy).toContain("composite_x");
  });

  it("usedBy: sub_two is not referenced (empty usedBy)", () => {
    const entry = manifest.procedures["sub_two"]!;
    expect(entry).toBeDefined();
    expect(entry.usedBy).toHaveLength(0);
  });

  it("composite_x has correct uses and subs", () => {
    const entry = manifest.procedures["composite_x"]!;
    expect(entry).toBeDefined();
    expect(entry.kind).toBe("composite");
    expect(entry.uses).toEqual(expect.arrayContaining(["sub_one", "leaf_a"]));
    expect(entry.subs).toEqual(expect.arrayContaining(["sub_one", "sub_two"]));
  });

  it("sub entries have owner: composite_x", () => {
    expect(manifest.procedures["sub_one"]!.owner).toBe("composite_x");
    expect(manifest.procedures["sub_two"]!.owner).toBe("composite_x");
  });

  it("top-level shared entries have owner: null", () => {
    expect(manifest.procedures["leaf_a"]!.owner).toBeNull();
    expect(manifest.procedures["leaf_b.domain"]!.owner).toBeNull();
  });

  it("tokens field is populated with expected stems for leaf_a", () => {
    const tokens = manifest.procedures["leaf_a"]!.tokens;
    expect(tokens).toBeDefined();
    expect(tokens.length).toBeGreaterThan(0);
    // "leaf_a" name parts → "leaf" (after stemming strip 's'→ leaf stays "leaf")
    // description "A simple leaf procedure for testing" → simple, leaf, procedure, test
    // triggers → "test", "leaf", "run"
    // tags → "test" (from "testing" after -ing strip → "test"), "leaf"
    // inputs → "url"
    expect(tokens).toContain("leaf");
    expect(tokens).toContain("url");
    // "testing" → "test" (strip -ing, 4 chars remain ≥ 3)
    expect(tokens).toContain("test");
  });

  it("tokens field is deduplicated", () => {
    const tokens = manifest.procedures["leaf_a"]!.tokens;
    const unique = [...new Set(tokens)];
    expect(tokens).toHaveLength(unique.length);
  });

  it("composite_x tokens contain composite-related terms", () => {
    const tokens = manifest.procedures["composite_x"]!.tokens;
    // "composite" → doesn't end in 's', 'ing', 'ed' so stays "composite"
    expect(tokens).toContain("composite");
  });

  it("manifest has version 1 and an ISO updated timestamp", () => {
    expect(manifest.version).toBe(1);
    expect(typeof manifest.updated).toBe("string");
    expect(new Date(manifest.updated).toISOString()).toBe(manifest.updated);
  });

  it("paths are relative to proceduresRoot", () => {
    const entry = manifest.procedures["leaf_a"]!;
    expect(entry.path).toBe(path.join("shared", "leaf_a", "procedure.yaml"));
    const sub = manifest.procedures["sub_one"]!;
    expect(sub.path).toBe(path.join("composite_x", "subs", "sub_one", "procedure.yaml"));
  });

  it("leaf_b.domain has domain set from the YAML field", () => {
    const entry = manifest.procedures["leaf_b.domain"]!;
    expect(entry.domain).toBe("b");
  });
});

// ---------------------------------------------------------------------------
// writeIndex / readIndex roundtrip
// ---------------------------------------------------------------------------

describe("writeIndex + readIndex", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(import.meta.dirname ?? __dirname, ".index-rw-test-"),
    );
    await writeFixture(tmpDir);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("roundtrip: writeIndex then readIndex returns equivalent manifest", async () => {
    const manifest = await buildIndex(tmpDir);
    await writeIndex(tmpDir, manifest);
    const read = await readIndex(tmpDir);

    expect(read).not.toBeNull();
    expect(read!.version).toBe(manifest.version);
    expect(Object.keys(read!.procedures)).toEqual(
      expect.arrayContaining(Object.keys(manifest.procedures)),
    );
    // Spot-check one entry
    const entryOrig = manifest.procedures["leaf_a"]!;
    const entryRead = read!.procedures["leaf_a"]!;
    expect(entryRead).toBeDefined();
    expect(entryRead.description).toBe(entryOrig.description);
    expect(entryRead.tokens).toEqual(entryOrig.tokens);
  });

  it("readIndex returns null for missing index.json", async () => {
    const emptyDir = await fs.mkdtemp(
      path.join(import.meta.dirname ?? __dirname, ".index-missing-test-"),
    );
    try {
      const result = await readIndex(emptyDir);
      expect(result).toBeNull();
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("readIndex returns null for malformed index.json", async () => {
    const badDir = await fs.mkdtemp(
      path.join(import.meta.dirname ?? __dirname, ".index-bad-test-"),
    );
    try {
      await fs.writeFile(path.join(badDir, "index.json"), "{not valid json", "utf8");
      const result = await readIndex(badDir);
      expect(result).toBeNull();
    } finally {
      await fs.rm(badDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ensureIndex
// ---------------------------------------------------------------------------

describe("ensureIndex", () => {
  it("creates root dir and builds index when starting fresh", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(import.meta.dirname ?? __dirname, ".ensure-fresh-"),
    );
    // Start from a subdirectory that doesn't exist yet
    const root = path.join(tmpDir, "nonexistent", "procedures");
    try {
      const manifest = await ensureIndex(root);
      expect(manifest.version).toBe(1);
      // Empty tree → no procedures
      expect(Object.keys(manifest.procedures)).toHaveLength(0);

      // index.json should now exist
      const stat = await fs.stat(path.join(root, "index.json"));
      expect(stat.isFile()).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns existing index without rebuilding when tree is up-to-date", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(import.meta.dirname ?? __dirname, ".ensure-uptodate-"),
    );
    try {
      await writeFixture(tmpDir);

      // First call: builds the index
      await ensureIndex(tmpDir);

      const indexFile = path.join(tmpDir, "index.json");
      const statBefore = await fs.stat(indexFile);

      // Small sleep to ensure mtime would differ if file were rewritten
      await new Promise((r) => setTimeout(r, 20));

      // Second call: tree hasn't changed → should return existing index
      await ensureIndex(tmpDir);

      const statAfter = await fs.stat(indexFile);

      // mtime must not have changed (no rebuild)
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rebuilds index when a procedure.yaml is newer than the index", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(import.meta.dirname ?? __dirname, ".ensure-stale-"),
    );
    try {
      await writeFixture(tmpDir);

      // Initial build
      await ensureIndex(tmpDir);

      const indexFile = path.join(tmpDir, "index.json");
      const statBefore = await fs.stat(indexFile);

      // Wait so the next write has a definitely newer mtime
      await new Promise((r) => setTimeout(r, 50));

      // Touch a procedure.yaml to make it newer than the index
      const leafAYaml = path.join(tmpDir, "shared", "leaf_a", "procedure.yaml");
      await fs.writeFile(leafAYaml, LEAF_A_YAML, "utf8");

      // ensureIndex must detect the stale index and rebuild
      await ensureIndex(tmpDir);

      const statAfter = await fs.stat(indexFile);

      // index.json should have been rewritten (newer mtime)
      expect(statAfter.mtimeMs).toBeGreaterThan(statBefore.mtimeMs);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
