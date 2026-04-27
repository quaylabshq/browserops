import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const extensionDist = path.resolve(repoRoot, "packages", "extension", "dist");
const agentsMd = path.resolve(repoRoot, "AGENTS.md");
const assetsDir = path.resolve(here, "dist", "assets");

async function copyAssetsIntoDist(): Promise<void> {
  await fs.mkdir(assetsDir, { recursive: true });

  // Bundle extension/dist/ → cli/dist/assets/extension/ so `browserops init`
  // can copy it into ~/.browserops/extension/ for the user to load unpacked.
  try {
    await fs.access(extensionDist);
    const target = path.resolve(assetsDir, "extension");
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(extensionDist, target, { recursive: true });
  } catch {
    // extension hasn't been built yet — first install will need to rebuild
  }

  // Bundle AGENTS.md so `browserops install-rules` can write it into per-project
  // rules slots (.cursor/rules/, .windsurfrules, etc.).
  try {
    await fs.access(agentsMd);
    await fs.cp(agentsMd, path.resolve(assetsDir, "AGENTS.md"));
  } catch {
    // AGENTS.md missing — install-rules will warn at runtime
  }
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
  noExternal: ["@browserops/shared", "@browserops/bridge"],
  onSuccess: async () => {
    await copyAssetsIntoDist();
  },
});
