/**
 * Seeds bundled procedure examples into the user's procedures directory on
 * first start.
 *
 * Behaviour:
 *   - For each bundled procedure under <bundledDir>/<name>/procedure.yaml
 *     that does NOT exist under <userRoot>/shared/<name>/procedure.yaml,
 *     copy it. Never overwrite.
 *   - If the user copy exists, log a one-line notice with the bundled
 *     procedure's meta.version (if present) so the user can opt to refresh
 *     by hand.
 *
 * Resolution of the bundled dir:
 *   - In dev (running source via tsx): <repoRoot>/examples/procedures
 *   - In a published install: <packageRoot>/dist/seed (populated by tsup
 *     copy step, Phase 4.3)
 *
 * Failures are logged to stderr and swallowed — a broken seed must not
 * prevent the bridge from starting.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { sharedDir } from "./paths.js";

/** Candidate locations for the bundled examples dir, in priority order. */
function bundledDirCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    // Published layout: dist/seed/  (this file is at dist/index.js after bundling)
    path.resolve(here, "seed"),
    // Dev layout: packages/bridge/src/procedures/ → repoRoot/examples/procedures
    path.resolve(here, "..", "..", "..", "..", "examples", "procedures"),
    // Dist dev layout: packages/bridge/dist/ → repoRoot/examples/procedures
    path.resolve(here, "..", "..", "..", "examples", "procedures"),
  ];
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveBundledDir(): Promise<string | null> {
  for (const c of bundledDirCandidates()) {
    if (await dirExists(c)) return c;
  }
  return null;
}

async function readBundledVersion(yamlPath: string): Promise<number | null> {
  try {
    const text = await fs.readFile(yamlPath, "utf8");
    const parsed = YAML.parse(text) as { meta?: { version?: number } } | null;
    return parsed?.meta?.version ?? null;
  } catch {
    return null;
  }
}

export interface SeedReport {
  copied: string[];
  skipped: string[];
  bundledDir: string | null;
}

/**
 * Copy any bundled procedure not already present under <userRoot>/shared/.
 * Returns a report describing what was copied vs skipped.
 */
export async function seedBundledProcedures(): Promise<SeedReport> {
  const bundledDir = await resolveBundledDir();
  if (bundledDir === null) {
    return { copied: [], skipped: [], bundledDir: null };
  }

  const userSharedDir = sharedDir();
  await fs.mkdir(userSharedDir, { recursive: true });

  const entries = await fs.readdir(bundledDir, { withFileTypes: true });
  const copied: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const srcYaml = path.join(bundledDir, name, "procedure.yaml");
    if (!(await fileExists(srcYaml))) continue;

    const destDir = path.join(userSharedDir, name);
    const destYaml = path.join(destDir, "procedure.yaml");

    if (await fileExists(destYaml)) {
      const version = await readBundledVersion(srcYaml);
      const versionStr = version !== null ? `v${version}` : "(unversioned)";
      process.stderr.write(
        `[seed] bundled "${name}" ${versionStr} available; local copy unchanged\n`,
      );
      skipped.push(name);
      continue;
    }

    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(srcYaml, destYaml);
    copied.push(name);
  }

  return { copied, skipped, bundledDir };
}
