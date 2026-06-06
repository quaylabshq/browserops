/**
 * Filesystem store for procedure.yaml files.
 *
 * Mirrors procedures/store.ts shape. All reads/writes go through this
 * module — callers must not manipulate the procedure tree directly.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Write mutex — same serialisation discipline as procedures.
// ---------------------------------------------------------------------------

let writeChain: Promise<void> = Promise.resolve();
function withWriteLock<T>(op: () => Promise<T>): Promise<T> {
  const prev = writeChain;
  let release!: () => void;
  writeChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  return prev.then(async () => {
    try {
      return await op();
    } finally {
      release();
    }
  });
}

// ---------------------------------------------------------------------------
// Coded error
// ---------------------------------------------------------------------------

export class CodedError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "CodedError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// atomicWriteFile
// ---------------------------------------------------------------------------

export async function atomicWriteFile(
  absPath: string,
  text: string,
): Promise<void> {
  return withWriteLock(async () => {
    const dir = path.dirname(absPath);
    const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;

    await fs.mkdir(dir, { recursive: true });

    try {
      await fs.writeFile(tmpPath, text, "utf8");
      await fs.rename(tmpPath, absPath);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => undefined);
      const nodeErr = err as NodeJS.ErrnoException;
      throw new CodedError(
        "INTERNAL",
        `failed to write file: ${absPath}: ${nodeErr.message}`,
        { path: absPath, cause: nodeErr.code },
      );
    }
  });
}

// ---------------------------------------------------------------------------
// readProcedureYaml
// ---------------------------------------------------------------------------

export async function readProcedureYaml(absPath: string): Promise<string> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      throw new CodedError(
        "PROCEDURE_NOT_FOUND",
        `procedure.yaml not found: ${absPath}`,
        { path: absPath },
      );
    }
    throw new CodedError(
      "INTERNAL",
      `failed to read procedure.yaml: ${absPath}: ${nodeErr.message}`,
      { path: absPath, cause: nodeErr.code },
    );
  }
}

// ---------------------------------------------------------------------------
// writeProcedureYamlAtomic
// ---------------------------------------------------------------------------

export async function writeProcedureYamlAtomic(
  absPath: string,
  yamlText: string,
): Promise<void> {
  return withWriteLock(async () => {
    const dir = path.dirname(absPath);
    const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;

    await fs.mkdir(dir, { recursive: true });

    try {
      await fs.writeFile(tmpPath, yamlText, "utf8");
      await fs.rename(tmpPath, absPath);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => undefined);
      const nodeErr = err as NodeJS.ErrnoException;
      throw new CodedError(
        "INTERNAL",
        `failed to write procedure.yaml: ${absPath}: ${nodeErr.message}`,
        { path: absPath, cause: nodeErr.code },
      );
    }
  });
}

// ---------------------------------------------------------------------------
// deleteProcedureDir
// ---------------------------------------------------------------------------

export async function deleteProcedureDir(
  absDirPath: string,
  cascade: boolean,
): Promise<void> {
  return withWriteLock(async () => {
    try {
      await fs.access(absDirPath);
    } catch {
      throw new CodedError(
        "PROCEDURE_NOT_FOUND",
        `procedure directory not found: ${absDirPath}`,
        { path: absDirPath },
      );
    }

    const subsPath = path.join(absDirPath, "subs");

    if (!cascade) {
      let subsEntries: string[] = [];
      try {
        const entries = await fs.readdir(subsPath);
        subsEntries = entries;
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code !== "ENOENT") {
          throw new CodedError(
            "INTERNAL",
            `failed to read subs directory: ${subsPath}: ${nodeErr.message}`,
            { path: subsPath, cause: nodeErr.code },
          );
        }
      }

      if (subsEntries.length > 0) {
        throw new CodedError(
          "PROCEDURE_IN_USE",
          `cannot delete procedure with non-empty subs/ (use cascade=true): ${absDirPath}`,
          { path: absDirPath, subs: subsEntries },
        );
      }
    }

    await fs.rm(absDirPath, { recursive: true });
  });
}
