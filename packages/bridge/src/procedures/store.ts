/**
 * Filesystem store for procedure.yaml files.
 *
 * All reads/writes go through this module — callers must not manipulate
 * the procedure tree directly. Enforces index freshness by being the sole
 * mutator of the on-disk layout.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Coded error
// ---------------------------------------------------------------------------

/**
 * An error that carries a machine-readable `code` string.
 * The bridge's `extractErrorCode` helper reads `.code` directly, so we
 * surface it as a plain property rather than overriding `name`.
 */
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
// readProcedureYaml
// ---------------------------------------------------------------------------

/**
 * Reads a `procedure.yaml` file and returns its raw text.
 *
 * @throws {CodedError} with code `"PROC_NOT_FOUND"` if the file does not exist.
 * @throws {CodedError} with code `"INTERNAL"` for other I/O errors.
 */
export async function readProcedureYaml(absPath: string): Promise<string> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "ENOENT") {
      throw new CodedError(
        "PROC_NOT_FOUND",
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

/**
 * Atomically writes `yamlText` to `absPath`.
 *
 * Algorithm:
 *  1. mkdir -p the parent directory.
 *  2. Write to a temporary file `<absPath>.tmp-<pid>-<timestamp>`.
 *  3. Rename the temp file over `absPath` (atomic on POSIX).
 *  4. On any error, attempt to clean up the temp file.
 */
export async function writeProcedureYamlAtomic(
  absPath: string,
  yamlText: string,
): Promise<void> {
  const dir = path.dirname(absPath);
  const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;

  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.writeFile(tmpPath, yamlText, "utf8");
    await fs.rename(tmpPath, absPath);
  } catch (err) {
    // Best-effort cleanup — ignore secondary error.
    await fs.unlink(tmpPath).catch(() => undefined);
    const nodeErr = err as NodeJS.ErrnoException;
    throw new CodedError(
      "INTERNAL",
      `failed to write procedure.yaml: ${absPath}: ${nodeErr.message}`,
      { path: absPath, cause: nodeErr.code },
    );
  }
}

// ---------------------------------------------------------------------------
// deleteProcedureDir
// ---------------------------------------------------------------------------

/**
 * Removes a procedure's directory from the tree.
 *
 * @param absDirPath - Absolute path to the procedure directory (not the yaml file).
 * @param cascade    - If `true`, also deletes any `subs/` subdirectory.
 *                     If `false`, errors when `subs/` exists and is non-empty.
 *
 * @throws {CodedError} with code `"PROC_NOT_FOUND"` if the directory does not exist.
 * @throws {CodedError} with code `"PROC_IN_USE"` when `cascade=false` and `subs/` is non-empty.
 */
export async function deleteProcedureDir(
  absDirPath: string,
  cascade: boolean,
): Promise<void> {
  // Verify the directory exists first.
  try {
    await fs.access(absDirPath);
  } catch {
    throw new CodedError(
      "PROC_NOT_FOUND",
      `procedure directory not found: ${absDirPath}`,
      { path: absDirPath },
    );
  }

  const subsPath = path.join(absDirPath, "subs");

  if (!cascade) {
    // Check whether subs/ exists and is non-empty.
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
      // ENOENT → subs/ doesn't exist, safe to proceed.
    }

    if (subsEntries.length > 0) {
      throw new CodedError(
        "PROC_IN_USE",
        `cannot delete procedure with non-empty subs/ (use cascade=true): ${absDirPath}`,
        { path: absDirPath, subs: subsEntries },
      );
    }
  }

  await fs.rm(absDirPath, { recursive: true });
}

// ---------------------------------------------------------------------------
// moveProcedureDir
// ---------------------------------------------------------------------------

/**
 * Moves a procedure directory from `fromAbs` to `toAbs`.
 *
 * Uses `fs.rename` which is atomic on the same filesystem (POSIX).
 *
 * @throws {CodedError} with code `"PROC_NOT_FOUND"` if `fromAbs` does not exist.
 * @throws {CodedError} with code `"PROC_ALREADY_EXISTS"` if `toAbs` already exists.
 */
export async function moveProcedureDir(
  fromAbs: string,
  toAbs: string,
): Promise<void> {
  // Verify source exists.
  try {
    await fs.access(fromAbs);
  } catch {
    throw new CodedError(
      "PROC_NOT_FOUND",
      `source procedure directory not found: ${fromAbs}`,
      { path: fromAbs },
    );
  }

  // Verify target does not exist.
  try {
    await fs.access(toAbs);
    // If we reach here, the target exists — that's an error.
    throw new CodedError(
      "PROC_ALREADY_EXISTS",
      `target procedure directory already exists: ${toAbs}`,
      { path: toAbs },
    );
  } catch (err) {
    if (err instanceof CodedError) {
      throw err;
    }
    // ENOENT on the access check → target doesn't exist, safe to proceed.
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== "ENOENT") {
      throw new CodedError(
        "INTERNAL",
        `failed to check target directory: ${toAbs}: ${nodeErr.message}`,
        { path: toAbs, cause: nodeErr.code },
      );
    }
  }

  // Ensure the parent of the target exists.
  await fs.mkdir(path.dirname(toAbs), { recursive: true });

  try {
    await fs.rename(fromAbs, toAbs);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    throw new CodedError(
      "INTERNAL",
      `failed to move procedure directory: ${fromAbs} → ${toAbs}: ${nodeErr.message}`,
      { from: fromAbs, to: toAbs, cause: nodeErr.code },
    );
  }
}
