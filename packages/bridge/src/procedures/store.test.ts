import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CodedError,
  atomicWriteFile,
  deleteProcedureDir,
  readProcedureYaml,
  writeProcedureYamlAtomic,
} from "./store.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".pbstore-test-"),
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function absPath(...parts: string[]): string {
  return path.join(tmpDir, ...parts);
}

describe("readProcedureYaml", () => {
  it("throws PROCEDURE_NOT_FOUND for missing file", async () => {
    const p = absPath("nope", "procedure.yaml");
    await expect(readProcedureYaml(p)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROCEDURE_NOT_FOUND",
    );
  });

  it("returns file contents for an existing file", async () => {
    const dir = absPath("mypb");
    await fs.mkdir(dir, { recursive: true });
    const yamlPath = path.join(dir, "procedure.yaml");
    const content = "schema_version: 1\nname: test\n";
    await fs.writeFile(yamlPath, content, "utf8");
    expect(await readProcedureYaml(yamlPath)).toBe(content);
  });
});

describe("writeProcedureYamlAtomic", () => {
  it("round-trip: write then read returns identical text", async () => {
    const yamlPath = absPath("a", "b", "procedure.yaml");
    const text = "schema_version: 1\nname: round.trip\ndescription: test\n";
    await writeProcedureYamlAtomic(yamlPath, text);
    const read = await readProcedureYaml(yamlPath);
    expect(read).toBe(text);
  });

  it("creates parent directories", async () => {
    const nested = absPath("deep", "nested", "dir", "procedure.yaml");
    await writeProcedureYamlAtomic(nested, "hello");
    expect(await fs.readFile(nested, "utf8")).toBe("hello");
  });

  it("no tmp files remain after a successful write", async () => {
    const yamlPath = absPath("pb", "procedure.yaml");
    await writeProcedureYamlAtomic(yamlPath, "content");
    const dir = path.dirname(yamlPath);
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.includes(".tmp-"))).toHaveLength(0);
  });

  it("overwrites an existing file", async () => {
    const yamlPath = absPath("overwrite", "procedure.yaml");
    await writeProcedureYamlAtomic(yamlPath, "first");
    await writeProcedureYamlAtomic(yamlPath, "second");
    expect(await readProcedureYaml(yamlPath)).toBe("second");
  });
});

describe("deleteProcedureDir", () => {
  it("throws PROCEDURE_NOT_FOUND for missing dir", async () => {
    await expect(deleteProcedureDir(absPath("missing"), false)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROCEDURE_NOT_FOUND",
    );
  });

  it("cascade=false: fails when subs/ has children", async () => {
    const pbDir = absPath("composite");
    const subDir = path.join(pbDir, "subs", "child");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, "procedure.yaml"), "sub", "utf8");

    await expect(deleteProcedureDir(pbDir, false)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROCEDURE_IN_USE",
    );

    await expect(fs.access(pbDir)).resolves.toBeUndefined();
  });

  it("cascade=false: succeeds when no subs/ exists", async () => {
    const pbDir = absPath("leafpb");
    await fs.mkdir(pbDir, { recursive: true });
    await fs.writeFile(path.join(pbDir, "procedure.yaml"), "leaf", "utf8");

    await deleteProcedureDir(pbDir, false);

    await expect(fs.access(pbDir)).rejects.toThrow();
  });

  it("cascade=true: removes dir and subs/", async () => {
    const pbDir = absPath("composite2");
    const subDir = path.join(pbDir, "subs", "sub1");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(pbDir, "procedure.yaml"), "composite", "utf8");
    await fs.writeFile(path.join(subDir, "procedure.yaml"), "sub", "utf8");

    await deleteProcedureDir(pbDir, true);

    await expect(fs.access(pbDir)).rejects.toThrow();
  });
});

describe("atomicWriteFile", () => {
  it("writes text to a new file, creating parent dirs", async () => {
    const target = absPath("deep", "file.json");
    await atomicWriteFile(target, '{"ok":true}');
    expect(await fs.readFile(target, "utf8")).toBe('{"ok":true}');
  });

  it("overwrites an existing file", async () => {
    const target = absPath("ov.json");
    await atomicWriteFile(target, "first");
    await atomicWriteFile(target, "second");
    expect(await fs.readFile(target, "utf8")).toBe("second");
  });
});
