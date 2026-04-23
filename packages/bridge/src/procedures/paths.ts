import * as os from "node:os";
import * as path from "node:path";

/**
 * Root directory for all procedure storage.
 * Overridable via BROWSEROPS_PROCEDURES_DIR environment variable.
 * Defaults to ~/browserops/procedures/ (not under ~/.browserops/).
 */
const ROOT =
  process.env.BROWSEROPS_PROCEDURES_DIR ??
  path.join(os.homedir(), "browserops", "procedures");

/**
 * Converts a procedure name to a safe directory-name component.
 * Replaces any character outside [a-z0-9._-] with an underscore.
 */
export function dirName(name: string): string {
  return name.replace(/[^a-z0-9._-]/g, "_");
}

/** Absolute path to the procedures root directory. */
export const proceduresRoot = (): string => ROOT;

/** Absolute path to the shared/ subdirectory inside the procedures root. */
export const sharedDir = (): string => path.join(ROOT, "shared");

/** Absolute path to the index.json manifest file. */
export const indexPath = (): string => path.join(ROOT, "index.json");

/**
 * Resolves the absolute path to a procedure's procedure.yaml file.
 *
 * @param owner - null for shared/top-level procedures; the composite name for sub-procedures.
 * @param name  - the procedure's canonical name field.
 */
export const procedureYamlPath = (
  owner: string | null,
  name: string,
): string =>
  owner === null
    ? path.join(ROOT, "shared", dirName(name), "procedure.yaml")
    : path.join(ROOT, dirName(owner), "subs", dirName(name), "procedure.yaml");
