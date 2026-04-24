import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedBundledProcedures } from "./seed.js";

// The seeder resolves the bundled dir via candidate paths anchored at the
// module location. The dev candidate
// (packages/bridge/src/procedures/../../../../examples/procedures) lands on
// the real repo's examples dir. We point BROWSEROPS_PROCEDURES_DIR at a
// fresh tmpdir per test and exercise the real seeder against the real
// bundled examples.

const ENV_KEY = "BROWSEROPS_PROCEDURES_DIR";

async function makeTmpRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "seed-test-"));
}

describe("seedBundledProcedures", () => {
  let tmpRoot: string;
  let prevEnv: string | undefined;

  beforeEach(async () => {
    tmpRoot = await makeTmpRoot();
    prevEnv = process.env[ENV_KEY];
    process.env[ENV_KEY] = tmpRoot;
  });

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("copies bundled procedures into shared/ on first run", async () => {
    const report = await seedBundledProcedures();
    expect(report.bundledDir).not.toBeNull();
    // The repo's bundled gmail.send_email should land in shared/.
    expect(report.copied).toContain("gmail.send_email");
    const dest = path.join(tmpRoot, "shared", "gmail.send_email", "procedure.yaml");
    const exists = await fs
      .access(dest)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("does not overwrite an existing user copy", async () => {
    const userDir = path.join(tmpRoot, "shared", "gmail.send_email");
    await fs.mkdir(userDir, { recursive: true });
    const userYaml = path.join(userDir, "procedure.yaml");
    await fs.writeFile(userYaml, "name: gmail.send_email\n# user-edited\n", "utf8");

    const report = await seedBundledProcedures();
    expect(report.skipped).toContain("gmail.send_email");
    expect(report.copied).not.toContain("gmail.send_email");

    const after = await fs.readFile(userYaml, "utf8");
    expect(after).toContain("# user-edited");
  });
});
