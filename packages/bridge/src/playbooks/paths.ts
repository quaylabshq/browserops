import * as os from "node:os";
import * as path from "node:path";

/**
 * Root directory for all playbook storage.
 * Overridable via BROWSEROPS_PLAYBOOKS_DIR environment variable.
 * Defaults to ~/browserops/playbooks/ (not under ~/.browserops/).
 *
 * Read at call time (not module load time) so that tests can set the env var
 * in beforeAll/beforeEach and have it take effect.
 */
function getRoot(): string {
  return (
    process.env["BROWSEROPS_PLAYBOOKS_DIR"] ??
    path.join(os.homedir(), "browserops", "playbooks")
  );
}

/**
 * Converts a playbook name to a safe directory-name component.
 * Replaces any character outside [a-z0-9._-] with an underscore.
 */
export function dirName(name: string): string {
  return name.replace(/[^a-z0-9._-]/g, "_");
}

/** Absolute path to the playbooks root directory. */
export const playbooksRoot = (): string => getRoot();

/** Absolute path to the shared/ subdirectory inside the playbooks root. */
export const sharedDir = (): string => path.join(getRoot(), "shared");

/** Absolute path to the index.json manifest file. */
export const indexPath = (): string => path.join(getRoot(), "index.json");

/**
 * Resolves the absolute path to a playbook's playbook.yaml file.
 *
 * @param owner - null for shared/top-level playbooks; the composite name for sub-playbooks.
 * @param name  - the playbook's canonical name field.
 */
export const playbookYamlPath = (
  owner: string | null,
  name: string,
): string => {
  const root = getRoot();
  return owner === null
    ? path.join(root, "shared", dirName(name), "playbook.yaml")
    : path.join(root, dirName(owner), "subs", dirName(name), "playbook.yaml");
};

/** Absolute path to a composite owner's top-level directory. */
export const compositeOwnerDir = (ownerName: string): string =>
  path.join(getRoot(), dirName(ownerName));

/** Absolute path to a composite owner's subs/ subdirectory. */
export const subsDir = (ownerName: string): string =>
  path.join(getRoot(), dirName(ownerName), "subs");
