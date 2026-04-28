#!/usr/bin/env node
/**
 * Sync the browserops version across every place it lives.
 *
 * Usage:
 *   pnpm bump <new-version>     # explicit, e.g. 0.0.2 or 1.0.0-rc.1
 *   pnpm bump patch             # bump patch from current root version
 *   pnpm bump minor
 *   pnpm bump major
 *
 * Updates:
 *   - package.json                                (root, private)
 *   - packages/{shared,bridge,extension,cli}/package.json
 *   - packages/bridge/src/daemon.ts               (const VERSION)
 *   - packages/cli/src/lib/version.ts             (export const CLI_VERSION)
 *   - packages/extension/src/manifest.ts          (version: "...")
 *
 * Does NOT git-add or tag — the user reviews the diff and commits manually.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const PACKAGE_JSONS = [
  "package.json",
  "packages/shared/package.json",
  "packages/bridge/package.json",
  "packages/extension/package.json",
  "packages/cli/package.json",
];

const SOURCE_PATCHES = [
  {
    file: "packages/bridge/src/daemon.ts",
    pattern: /const VERSION = "[^"]+"/,
    replace: (v) => `const VERSION = "${v}"`,
  },
  {
    file: "packages/cli/src/lib/version.ts",
    pattern: /export const CLI_VERSION = "[^"]+"/,
    replace: (v) => `export const CLI_VERSION = "${v}"`,
  },
  {
    file: "packages/extension/src/manifest.ts",
    pattern: /version: "[^"]+"/,
    replace: (v) => `version: "${v}"`,
  },
];

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BUMP_KINDS = new Set(["patch", "minor", "major"]);

function fail(msg) {
  process.stderr.write(`bump: ${msg}\n`);
  process.exit(1);
}

function bumpSemver(current, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(current);
  if (!m) fail(`current version "${current}" is not a basic x.y.z semver — pass an explicit version instead`);
  let [, major, minor, patch] = m.map(Number);
  if (kind === "major") {
    major += 1; minor = 0; patch = 0;
  } else if (kind === "minor") {
    minor += 1; patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

async function readText(rel) {
  return readFile(join(repoRoot, rel), "utf8");
}

async function readJson(rel) {
  const text = await readText(rel);
  return { text, json: JSON.parse(text) };
}

async function writeText(rel, text) {
  await writeFile(join(repoRoot, rel), text, "utf8");
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    fail("usage: pnpm bump <version|patch|minor|major>");
  }

  let target;
  if (BUMP_KINDS.has(arg)) {
    const { json } = await readJson("package.json");
    target = bumpSemver(json.version, arg);
  } else if (SEMVER_RE.test(arg)) {
    target = arg;
  } else {
    fail(`"${arg}" is not a valid semver and not one of patch|minor|major`);
  }

  process.stdout.write(`bumping → ${target}\n\n`);
  let changed = 0;

  for (const rel of PACKAGE_JSONS) {
    const { text, json } = await readJson(rel);
    if (json.version === target) {
      process.stdout.write(`  · ${rel.padEnd(42)} already at ${target}\n`);
      continue;
    }
    const before = json.version;
    json.version = target;
    // Preserve trailing newline if the original file had one.
    const trailing = text.endsWith("\n") ? "\n" : "";
    await writeText(rel, JSON.stringify(json, null, 2) + trailing);
    process.stdout.write(`  ✓ ${rel.padEnd(42)} ${before} → ${target}\n`);
    changed++;
  }

  for (const patch of SOURCE_PATCHES) {
    const text = await readText(patch.file);
    const next = text.replace(patch.pattern, patch.replace(target));
    if (next === text) {
      const m = patch.pattern.exec(text);
      if (m && m[0].includes(target)) {
        process.stdout.write(`  · ${patch.file.padEnd(42)} already at ${target}\n`);
        continue;
      }
      fail(`could not find ${patch.pattern} in ${patch.file}`);
    }
    await writeText(patch.file, next);
    process.stdout.write(`  ✓ ${patch.file.padEnd(42)} → ${target}\n`);
    changed++;
  }

  process.stdout.write(`\n${changed} file${changed === 1 ? "" : "s"} updated.\n`);
  if (changed > 0) {
    process.stdout.write("\nNext: pnpm install (refresh lockfile), then commit.\n");
  }
}

main().catch((e) => {
  process.stderr.write(`bump: fatal: ${e?.stack ?? e?.message ?? e}\n`);
  process.exit(1);
});
