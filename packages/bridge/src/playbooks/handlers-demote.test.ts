/**
 * Auto-demote on save: when overwriting an existing playbook with a
 * meta.health block that shouldDemoteFromHealth flags, the save handler
 * must refuse the bump_success=trusted flip and instead persist as
 * status:draft with `demoted: true` in the result.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { handleSave, handleGet } from "./handlers.js";

let tmpDir: string;
const ORIGINAL_ENV = process.env["BROWSEROPS_PLAYBOOKS_DIR"];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".pbdemote-test-"),
  );
  process.env["BROWSEROPS_PLAYBOOKS_DIR"] = tmpDir;
});

afterEach(async () => {
  if (ORIGINAL_ENV === undefined) delete process.env["BROWSEROPS_PLAYBOOKS_DIR"];
  else process.env["BROWSEROPS_PLAYBOOKS_DIR"] = ORIGINAL_ENV;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const baseYaml = `schema_version: 1
name: gmail.demote_test
description: Save flow that gets demoted by drift health.
kind: leaf
steps:
  - id: open_compose
    do: click
    locator: { role: button, name: Compose }
`;

async function writeWithHealth(opts: {
  runs: number;
  relocates: number;
  target_changed: number;
  last_tier?: 1 | 2 | 3;
}): Promise<void> {
  // Save once as draft.
  await handleSave({ name: "gmail.demote_test", yaml: baseYaml });

  // Write health directly into the YAML on disk, then save again with
  // overwrite + bump_success — the handler should see the bad health
  // and refuse to mark trusted.
  const filePath = path.join(tmpDir, "shared", "gmail.demote_test", "playbook.yaml");
  const text = await fs.readFile(filePath, "utf8");
  const doc = YAML.parse(text) as Record<string, unknown>;
  const meta = (doc["meta"] as Record<string, unknown>) ?? {};
  meta["health"] = {
    updated: new Date().toISOString(),
    steps: {
      open_compose: {
        runs: opts.runs,
        relocates: opts.relocates,
        ambiguous_resolves: 0,
        target_changed: opts.target_changed,
        avg_match_count: 1,
        last_tier: opts.last_tier ?? 2,
        last_ref: 12,
      },
    },
  };
  doc["meta"] = meta;
  await fs.writeFile(filePath, YAML.stringify(doc), "utf8");
}

describe("handleSave — auto-demote on drift health", () => {
  it("refuses bump_success when prior health has high relocate-rate", async () => {
    await writeWithHealth({ runs: 10, relocates: 5, target_changed: 0 });
    const res = await handleSave({
      name: "gmail.demote_test",
      yaml: baseYaml,
      overwrite: true,
      bump_success: true,
    });
    expect(res.demoted).toBe(true);
    const got = await handleGet({ name: "gmail.demote_test" });
    expect(got.meta.status).toBe("draft");
  });

  it("refuses bump_success when prior health shows target drift", async () => {
    await writeWithHealth({ runs: 5, relocates: 0, target_changed: 2 });
    const res = await handleSave({
      name: "gmail.demote_test",
      yaml: baseYaml,
      overwrite: true,
      bump_success: true,
    });
    expect(res.demoted).toBe(true);
  });

  it("allows bump_success when health is clean", async () => {
    await writeWithHealth({ runs: 10, relocates: 0, target_changed: 0 });
    const res = await handleSave({
      name: "gmail.demote_test",
      yaml: baseYaml,
      overwrite: true,
      bump_success: true,
    });
    expect(res.demoted).toBeUndefined();
    const got = await handleGet({ name: "gmail.demote_test" });
    expect(got.meta.status).toBe("trusted");
  });

  it("allows bump_success when there is no prior health (fresh save)", async () => {
    await handleSave({ name: "gmail.demote_test", yaml: baseYaml });
    const res = await handleSave({
      name: "gmail.demote_test",
      yaml: baseYaml,
      overwrite: true,
      bump_success: true,
    });
    expect(res.demoted).toBeUndefined();
    const got = await handleGet({ name: "gmail.demote_test" });
    expect(got.meta.status).toBe("trusted");
  });
});

describe("handleSave — preserves meta.health across overwrite", () => {
  it("a save without bump_success does not wipe the existing health block", async () => {
    await writeWithHealth({ runs: 10, relocates: 0, target_changed: 0 });
    await handleSave({
      name: "gmail.demote_test",
      yaml: baseYaml,
      overwrite: true,
    });
    const filePath = path.join(tmpDir, "shared", "gmail.demote_test", "playbook.yaml");
    const text = await fs.readFile(filePath, "utf8");
    const doc = YAML.parse(text);
    expect(doc.meta.health).toBeDefined();
    expect(doc.meta.health.steps.open_compose.runs).toBe(10);
  });
});
