import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// Copy skills/browserops.md into dist/assets/skill.md so the published npm
// package can serve the skill prompt without a separate post-install step.
// prompts.ts resolves dist/assets/skill.md as its highest-priority candidate.
const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(here, "dist", "assets");
const skillSrc = path.resolve(here, "..", "..", "skills", "browserops.md");
const skillDest = path.resolve(assetsDir, "skill.md");

async function copySkillIntoDist(): Promise<void> {
  try {
    await fs.access(skillSrc);
  } catch {
    process.stderr.write(
      `[tsup] warn: skills/browserops.md not found at ${skillSrc} — skill prompt will fall back to dev-layout resolution\n`,
    );
    return;
  }
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.copyFile(skillSrc, skillDest);
}

export default defineConfig({
  entry: ["src/daemon.ts", "src/shim.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  clean: true,
  sourcemap: true,
  dts: false,
  noExternal: ["@browserops/shared"],
  onSuccess: async () => {
    await copySkillIntoDist();
  },
});
