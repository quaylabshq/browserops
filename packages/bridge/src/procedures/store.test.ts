import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodedError,
  deleteProcedureDir,
  moveProcedureDir,
  readProcedureYaml,
  writeProcedureYamlAtomic,
} from "./store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".store-test-"),
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function absPath(...parts: string[]): string {
  return path.join(tmpDir, ...parts);
}

// ---------------------------------------------------------------------------
// readProcedureYaml
// ---------------------------------------------------------------------------

describe("readProcedureYaml", () => {
  it("throws PROC_NOT_FOUND for missing file", async () => {
    const p = absPath("nope", "procedure.yaml");
    await expect(readProcedureYaml(p)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_NOT_FOUND",
    );
  });

  it("returns file contents for an existing file", async () => {
    const dir = absPath("myproc");
    await fs.mkdir(dir, { recursive: true });
    const yamlPath = path.join(dir, "procedure.yaml");
    const content = "schema_version: 1\nname: test\n";
    await fs.writeFile(yamlPath, content, "utf8");
    expect(await readProcedureYaml(yamlPath)).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// writeProcedureYamlAtomic
// ---------------------------------------------------------------------------

describe("writeProcedureYamlAtomic", () => {
  it("round-trip: write then read returns identical text", async () => {
    const yamlPath = absPath("a", "b", "procedure.yaml");
    const text = "schema_version: 1\nname: round.trip\ndescription: test\n";
    await writeProcedureYamlAtomic(yamlPath, text);
    const read = await readProcedureYaml(yamlPath);
    expect(read).toBe(text);
  });

  it("creates parent directories that do not exist", async () => {
    const nested = absPath("deep", "nested", "dir", "procedure.yaml");
    await writeProcedureYamlAtomic(nested, "hello");
    const read = await fs.readFile(nested, "utf8");
    expect(read).toBe("hello");
  });

  it("no tmp files remain in the directory after a successful write", async () => {
    const yamlPath = absPath("proc", "procedure.yaml");
    await writeProcedureYamlAtomic(yamlPath, "content");

    const dir = path.dirname(yamlPath);
    const entries = await fs.readdir(dir);
    const tmpFiles = entries.filter((e) => e.includes(".tmp-"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("overwrites an existing file", async () => {
    const yamlPath = absPath("overwrite", "procedure.yaml");
    await writeProcedureYamlAtomic(yamlPath, "first");
    await writeProcedureYamlAtomic(yamlPath, "second");
    expect(await readProcedureYaml(yamlPath)).toBe("second");
  });
});

// ---------------------------------------------------------------------------
// deleteProcedureDir
// ---------------------------------------------------------------------------

describe("deleteProcedureDir", () => {
  it("throws PROC_NOT_FOUND when directory does not exist", async () => {
    const missing = absPath("nonexistent");
    await expect(deleteProcedureDir(missing, false)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_NOT_FOUND",
    );
  });

  it("cascade=false: fails when subs/ has children", async () => {
    const procDir = absPath("composite");
    const subDir = path.join(procDir, "subs", "child");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, "procedure.yaml"), "sub", "utf8");

    await expect(deleteProcedureDir(procDir, false)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_IN_USE",
    );

    // Directory must still exist.
    await expect(fs.access(procDir)).resolves.toBeUndefined();
  });

  it("cascade=false: succeeds when there is no subs/ directory", async () => {
    const procDir = absPath("leafproc");
    await fs.mkdir(procDir, { recursive: true });
    await fs.writeFile(
      path.join(procDir, "procedure.yaml"),
      "leaf yaml",
      "utf8",
    );

    await deleteProcedureDir(procDir, false);

    await expect(fs.access(procDir)).rejects.toThrow();
  });

  it("cascade=true: removes the directory and its subs/", async () => {
    const procDir = absPath("composite2");
    const subDir = path.join(procDir, "subs", "sub1");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(
      path.join(procDir, "procedure.yaml"),
      "composite",
      "utf8",
    );
    await fs.writeFile(path.join(subDir, "procedure.yaml"), "sub", "utf8");

    await deleteProcedureDir(procDir, true);

    await expect(fs.access(procDir)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// moveProcedureDir
// ---------------------------------------------------------------------------

describe("moveProcedureDir", () => {
  it("moves files correctly", async () => {
    const srcDir = absPath("src_proc");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(
      path.join(srcDir, "procedure.yaml"),
      "yaml content",
      "utf8",
    );

    const dstDir = absPath("dst_proc");
    await moveProcedureDir(srcDir, dstDir);

    // Source no longer exists.
    await expect(fs.access(srcDir)).rejects.toThrow();

    // Destination exists with same content.
    const content = await fs.readFile(
      path.join(dstDir, "procedure.yaml"),
      "utf8",
    );
    expect(content).toBe("yaml content");
  });

  it("throws PROC_NOT_FOUND when source does not exist", async () => {
    const src = absPath("missing_src");
    const dst = absPath("any_dst");
    await expect(moveProcedureDir(src, dst)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_NOT_FOUND",
    );
  });

  it("throws PROC_ALREADY_EXISTS when target exists", async () => {
    const src = absPath("mv_src");
    const dst = absPath("mv_dst");
    await fs.mkdir(src, { recursive: true });
    await fs.mkdir(dst, { recursive: true });

    await expect(moveProcedureDir(src, dst)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_ALREADY_EXISTS",
    );

    // Both directories must still exist.
    await expect(fs.access(src)).resolves.toBeUndefined();
    await expect(fs.access(dst)).resolves.toBeUndefined();
  });
});
