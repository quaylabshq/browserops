import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// Copy examples/procedures/** into dist/seed/ so the published npm package
// can seed first-start users without a separate post-install step. seed.ts
// resolves dist/seed/ as its highest-priority bundled-dir candidate.
const here = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(here, "..", "..", "examples", "procedures");
const seedDir = path.resolve(here, "dist", "seed");

async function copyExamplesIntoDist(): Promise<void> {
  try {
    await fs.access(examplesDir);
  } catch {
    return; // examples dir absent — nothing to seed
  }
  await fs.rm(seedDir, { recursive: true, force: true });
  await fs.cp(examplesDir, seedDir, { recursive: true });
}

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  clean: true,
  sourcemap: true,
  dts: false,
  noExternal: ["@browserops/shared"],
  onSuccess: async () => {
    await copyExamplesIntoDist();
  },
});
