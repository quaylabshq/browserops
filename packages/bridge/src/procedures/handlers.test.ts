/**
 * Tests for the six procedures.* MCP handlers.
 *
 * Each describe block gets its own fresh temp directory to avoid cross-test
 * state pollution. The BROWSEROPS_PROCEDURES_DIR env var is set per-suite
 * using vitest's test context.
 *
 * Note: proceduresRoot() reads the env var at call-time (not module load),
 * so setting process.env before each suite works correctly.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { CodedError } from "./store.js";
import {
  handleSearch,
  handleGet,
  handleSave,
  handleDelete,
  PROCEDURE_HANDLERS,
} from "./handlers.js";

// ---------------------------------------------------------------------------
// Fixture YAML constants
// ---------------------------------------------------------------------------

const SHARED_LEAF_YAML = `\
schema_version: 1
name: gmail.send_email
description: Compose and send a Gmail email via the web UI
kind: leaf
domain: gmail
triggers:
  - email users who did
  - send an email to
  - message someone about
tags:
  - email
  - outreach
inputs:
  to: { type: string, required: true, description: Recipient email }
  subject: { type: string, required: true }
  body: { type: string, required: true }
steps:
  - id: open_compose
    action: browser_click_by_text
    with:
      tab_id: "{{tab_id}}"
      text: Compose
`;

const SHARED_LEAF2_YAML = `\
schema_version: 1
name: posthog.export_cohort
description: Export a PostHog cohort to CSV
kind: leaf
domain: posthog
tags:
  - posthog
  - analytics
inputs:
  cohort_id: { type: string, required: true }
steps:
  - id: export
    action: browser_navigate
    with:
      url: "https://app.posthog.com/cohorts/{{input.cohort_id}}/export"
`;

const SUB_FIND_YAML = `\
schema_version: 1
name: find_users_by_event
description: Find PostHog users by event
kind: leaf
tags:
  - posthog
inputs:
  event_filter: { type: string, required: true }
steps:
  - id: filter
    action: browser_click
    with:
      ref: 1
`;

const SUB_CRAFT_YAML = `\
schema_version: 1
name: craft_email_body
description: Craft an email body based on a template
kind: leaf
inputs:
  template: { type: string, required: true }
steps:
  - id: craft
    action: browser_type
    with:
      ref: 2
      text: "{{input.template}}"
`;

const COMPOSITE_YAML = `\
schema_version: 1
name: email_posthog_users
description: Find PostHog users by behavior and email them
kind: composite
uses:
  - find_users_by_event
  - craft_email_body
  - gmail.send_email
tags:
  - posthog
  - email
inputs:
  event_filter: { type: string, required: true }
  email_template: { type: string, required: true }
steps:
  - id: find_users
    action: find_users_by_event
    with:
      event_filter: "{{input.event_filter}}"
  - id: craft_email
    action: craft_email_body
    with:
      template: "{{input.email_template}}"
  - id: send_email
    action: gmail.send_email
    with:
      to: "{{find_users.email}}"
      subject: Campaign email
      body: "{{craft_email.body}}"
`;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

// Appended to every fixture YAML so the index loads them as `status: trusted`
// and search returns them by default (drafts are filtered out under the
// status:draft default introduced alongside bump_success).
const TRUSTED_META = `
meta:
  version: 1
  created: 2026-01-01T00:00:00.000Z
  last_verified: 2026-01-01T00:00:00.000Z
  success_count: 1
  failure_count: 0
  status: trusted
`;

async function writeFixture(root: string): Promise<void> {
  async function writeFile(relParts: string[], content: string): Promise<void> {
    const abs = path.join(root, ...relParts);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content + TRUSTED_META, "utf8");
  }

  await writeFile(["shared", "gmail.send_email", "procedure.yaml"], SHARED_LEAF_YAML);
  await writeFile(["shared", "posthog.export_cohort", "procedure.yaml"], SHARED_LEAF2_YAML);
  await writeFile(["email_posthog_users", "procedure.yaml"], COMPOSITE_YAML);
  await writeFile(["email_posthog_users", "subs", "find_users_by_event", "procedure.yaml"], SUB_FIND_YAML);
  await writeFile(["email_posthog_users", "subs", "craft_email_body", "procedure.yaml"], SUB_CRAFT_YAML);
}

/**
 * Creates a fresh temp dir, writes fixture, sets the env var, returns cleanup fn.
 * Call this in beforeAll/beforeEach, call cleanup in afterAll/afterEach.
 */
async function setupTempRoot(): Promise<{ root: string; restore: () => void }> {
  const savedEnv = process.env["BROWSEROPS_PROCEDURES_DIR"];
  const root = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".handlers-test-"),
  );
  process.env["BROWSEROPS_PROCEDURES_DIR"] = root;
  await writeFixture(root);

  const restore = (): void => {
    if (savedEnv === undefined) {
      delete process.env["BROWSEROPS_PROCEDURES_DIR"];
    } else {
      process.env["BROWSEROPS_PROCEDURES_DIR"] = savedEnv;
    }
  };

  return { root, restore };
}

// ---------------------------------------------------------------------------
// PROCEDURE_HANDLERS map
// ---------------------------------------------------------------------------

describe("PROCEDURE_HANDLERS", () => {
  it("has an entry for each of the four sync tools (search/get/save/delete)", () => {
    const keys = Object.keys(PROCEDURE_HANDLERS);
    expect(keys).toContain("procedures_search");
    expect(keys).toContain("procedures_get");
    expect(keys).toContain("procedures_save");
    expect(keys).toContain("procedures_delete");
    expect(keys).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// handleSearch
// ---------------------------------------------------------------------------

describe("handleSearch", () => {
  let tmpRoot: string;
  let restoreEnv: () => void;

  beforeAll(async () => {
    const setup = await setupTempRoot();
    tmpRoot = setup.root;
    restoreEnv = setup.restore;
  });

  afterAll(async () => {
    restoreEnv();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns matches for a valid query", async () => {
    const result = await handleSearch({ query: "email" }) as {
      matches: unknown[];
      total: number;
      truncated: boolean;
    };
    expect(result.matches).toBeDefined();
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(typeof result.truncated).toBe("boolean");
  });

  it("returns matches for gmail query", async () => {
    const result = await handleSearch({ query: "gmail send email" }) as {
      matches: Array<{ name: string }>;
    };
    expect(result.matches.length).toBeGreaterThan(0);
    const names = result.matches.map((m) => m.name);
    expect(names).toContain("gmail.send_email");
  });

  it("limit=1 returns at most 1 match", async () => {
    const result = await handleSearch({ query: "email", limit: 1 }) as {
      matches: unknown[];
    };
    expect(result.matches.length).toBeLessThanOrEqual(1);
  });

  it("domain filter — domain=gmail narrows results", async () => {
    const result = await handleSearch({ query: "gmail email", domain: "gmail" }) as {
      matches: Array<{ name: string; domain: string | null }>;
    };
    for (const m of result.matches) {
      if (m.domain !== null) {
        expect(m.domain).toBe("gmail");
      }
    }
  });

  it("throws INVALID_PARAMS on empty query", async () => {
    await expect(handleSearch({ query: "" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("throws INVALID_PARAMS when query is not a string", async () => {
    await expect(handleSearch({ query: 42 })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("deep=true option is passed through (no error on valid fixture)", async () => {
    const result = await handleSearch({ query: "compose", deep: true }) as {
      matches: unknown[];
    };
    expect(Array.isArray(result.matches)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleGet
// ---------------------------------------------------------------------------

describe("handleGet", () => {
  let tmpRoot: string;
  let restoreEnv: () => void;

  beforeAll(async () => {
    const setup = await setupTempRoot();
    tmpRoot = setup.root;
    restoreEnv = setup.restore;
  });

  afterAll(async () => {
    restoreEnv();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("returns yaml text, relative path, and all five meta fields for an existing procedure", async () => {
    const result = await handleGet({ name: "gmail.send_email" });
    expect(typeof result.yaml).toBe("string");
    expect(result.yaml.length).toBeGreaterThan(0);
    expect(typeof result.path).toBe("string");
    expect(result.path).toContain("gmail.send_email");

    // All five meta fields must be present
    expect(typeof result.meta.version).toBe("number");
    expect(typeof result.meta.created).toBe("string");
    expect(typeof result.meta.last_verified).toBe("string");
    expect(typeof result.meta.success_count).toBe("number");
    expect(typeof result.meta.failure_count).toBe("number");
  });

  it("meta defaults are valid even when no meta block in YAML (fixture has none)", async () => {
    const result = await handleGet({ name: "gmail.send_email" });
    expect(result.meta.version).toBeGreaterThanOrEqual(1);
    expect(result.meta.success_count).toBeGreaterThanOrEqual(0);
    expect(result.meta.failure_count).toBeGreaterThanOrEqual(0);
    // created and last_verified must be valid ISO strings
    expect(new Date(result.meta.created).toISOString()).toBe(result.meta.created);
    expect(new Date(result.meta.last_verified).toISOString()).toBe(result.meta.last_verified);
  });

  it("throws PROC_NOT_FOUND for an unknown name", async () => {
    await expect(handleGet({ name: "nonexistent.procedure" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_NOT_FOUND",
    );
  });

  it("throws INVALID_PARAMS for an empty name", async () => {
    await expect(handleGet({ name: "" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("throws INVALID_PARAMS for a name that doesn't match pattern (uppercase)", async () => {
    await expect(handleGet({ name: "UPPERCASE_PROC" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });
});

// ---------------------------------------------------------------------------
// handleSave
// ---------------------------------------------------------------------------

const NEW_PROC_YAML = `\
schema_version: 1
name: my.new_proc
description: A brand new procedure for testing
kind: leaf
domain: my
inputs:
  url: { type: string, required: true }
steps:
  - id: navigate
    action: browser_navigate
    with:
      url: "{{input.url}}"
`;

describe("handleSave", () => {
  let tmpRoot: string;
  let restoreEnv: () => void;

  beforeAll(async () => {
    const setup = await setupTempRoot();
    tmpRoot = setup.root;
    restoreEnv = setup.restore;
  });

  afterAll(async () => {
    restoreEnv();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("happy path — creates a new procedure at version 1 and reindexes", async () => {
    const result = await handleSave({ name: "my.new_proc", yaml: NEW_PROC_YAML });
    expect(result.saved).toBe(true);
    expect(result.version).toBe(1);
    expect(typeof result.path).toBe("string");

    // File should exist on disk
    const absPath = path.join(tmpRoot, result.path);
    const stat = await fs.stat(absPath);
    expect(stat.isFile()).toBe(true);
  });

  it("second save with overwrite=false → PROC_ALREADY_EXISTS", async () => {
    // my.new_proc was just saved above — save again without overwrite
    await expect(
      handleSave({ name: "my.new_proc", yaml: NEW_PROC_YAML, overwrite: false }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_ALREADY_EXISTS",
    );
  });

  it("save with overwrite=true → version 2 and preserves created timestamp", async () => {
    // Get original meta first (set by previous test)
    const getResult = await handleGet({ name: "my.new_proc" });
    const originalCreated = getResult.meta.created;

    const result = await handleSave({
      name: "my.new_proc",
      yaml: NEW_PROC_YAML,
      overwrite: true,
    });
    expect(result.saved).toBe(true);
    expect(result.version).toBe(2);

    // Verify version bumped and created timestamp preserved
    const getResult2 = await handleGet({ name: "my.new_proc" });
    expect(getResult2.meta.version).toBe(2);
    expect(getResult2.meta.created).toBe(originalCreated);
  });

  it("uses: ref to nonexistent procedure → PROC_NOT_FOUND", async () => {
    const compositeWithBadRef = `\
schema_version: 1
name: bad.composite
description: A composite with bad uses reference
kind: composite
uses:
  - nonexistent_procedure_xyz
steps:
  - id: step1
    action: nonexistent_procedure_xyz
    with: {}
`;
    await expect(
      handleSave({ name: "bad.composite", yaml: compositeWithBadRef }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_NOT_FOUND",
    );
  });

  it("bad owner (nonexistent) → PROC_OWNER_INVALID", async () => {
    const subYaml = `\
schema_version: 1
name: orphan.sub
description: Orphan sub for testing
kind: leaf
inputs:
  x: { type: string, required: true }
steps:
  - id: step1
    action: browser_navigate
    with:
      url: "https://example.com"
`;
    await expect(
      handleSave({
        name: "orphan.sub",
        yaml: subYaml,
        owner: "nonexistent_composite",
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_OWNER_INVALID",
    );
  });

  it("bad owner (leaf procedure, not composite) → PROC_OWNER_INVALID", async () => {
    // gmail.send_email is a leaf, not a composite
    const subYaml = `\
schema_version: 1
name: my.sub_for_leaf_owner
description: A sub procedure to test
kind: leaf
inputs:
  url: { type: string, required: true }
steps:
  - id: navigate
    action: browser_navigate
    with:
      url: "{{input.url}}"
`;
    await expect(
      handleSave({
        name: "my.sub_for_leaf_owner",
        yaml: subYaml,
        owner: "gmail.send_email",
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_OWNER_INVALID",
    );
  });

  it("malformed YAML → PROC_SCHEMA_INVALID", async () => {
    await expect(
      handleSave({
        name: "gmail.send_email",
        yaml: "name: [unclosed bracket",
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_SCHEMA_INVALID",
    );
  });

  it("name mismatch between param and YAML → PROC_SCHEMA_INVALID", async () => {
    await expect(
      handleSave({ name: "different.name", yaml: NEW_PROC_YAML }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_SCHEMA_INVALID",
    );
  });

  it("YAML with invalid schema (missing required steps) → PROC_SCHEMA_INVALID", async () => {
    const badSchema = `\
schema_version: 1
name: bad.schema
description: Missing steps
kind: leaf
`;
    await expect(
      handleSave({ name: "bad.schema", yaml: badSchema }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_SCHEMA_INVALID",
    );
  });

  it("saves a sub-procedure under a valid composite owner", async () => {
    const subYaml = `\
schema_version: 1
name: new_sub_proc
description: A new sub procedure under the composite
kind: leaf
inputs:
  data: { type: string, required: true }
steps:
  - id: process
    action: browser_click
    with:
      ref: 5
`;
    const result = await handleSave({
      name: "new_sub_proc",
      yaml: subYaml,
      owner: "email_posthog_users",
    });
    expect(result.saved).toBe(true);
    expect(result.version).toBe(1);
    // Path should contain subs/
    expect(result.path).toContain("subs");
    expect(result.path).toContain("new_sub_proc");
  });
});

// ---------------------------------------------------------------------------
// handleSave → handleGet round-trip (end-to-end consistency)
// ---------------------------------------------------------------------------

describe("handleSave + handleGet round-trip", () => {
  let tmpRoot: string;
  let restoreEnv: () => void;

  beforeAll(async () => {
    const setup = await setupTempRoot();
    tmpRoot = setup.root;
    restoreEnv = setup.restore;
  });

  afterAll(async () => {
    restoreEnv();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("saved procedure can be retrieved via handleGet with correct meta", async () => {
    const rtYaml = `\
schema_version: 1
name: roundtrip.test
description: A procedure for round-trip testing
kind: leaf
inputs:
  query: { type: string, required: true }
steps:
  - id: search
    action: browser_navigate
    with:
      url: "https://example.com/search?q={{input.query}}"
`;
    const saveResult = await handleSave({ name: "roundtrip.test", yaml: rtYaml });
    expect(saveResult.version).toBe(1);

    const getResult = await handleGet({ name: "roundtrip.test" });
    expect(getResult.meta.version).toBe(1);
    expect(getResult.meta.success_count).toBe(0);
    expect(getResult.meta.failure_count).toBe(0);
    expect(typeof getResult.meta.created).toBe("string");
  });

  it("saved procedure is fetchable via handleGet", async () => {
    // Ensure roundtrip.test exists (saved in previous test)
    const getResult = await handleGet({ name: "roundtrip.test" });
    expect(getResult.yaml).toContain("roundtrip.test");
  });

  it("overwrite bumps version from 1 to 2", async () => {
    const rtYaml2 = `\
schema_version: 1
name: roundtrip.test
description: Updated description for round-trip testing
kind: leaf
inputs:
  query: { type: string, required: true }
steps:
  - id: search
    action: browser_navigate
    with:
      url: "https://example.com/search?q={{input.query}}"
`;
    const saveResult = await handleSave({ name: "roundtrip.test", yaml: rtYaml2, overwrite: true });
    expect(saveResult.version).toBe(2);

    // Verify via get that the description was updated
    const getResult = await handleGet({ name: "roundtrip.test" });
    expect(getResult.yaml).toContain("Updated description for round-trip testing");
  });
});

// ---------------------------------------------------------------------------
// handleDelete
// ---------------------------------------------------------------------------

describe("handleDelete", () => {
  let tmpRoot: string;
  let restoreEnv: () => void;

  beforeAll(async () => {
    const setup = await setupTempRoot();
    tmpRoot = setup.root;
    restoreEnv = setup.restore;
  });

  afterAll(async () => {
    restoreEnv();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("throws PROC_NOT_FOUND for unknown procedure", async () => {
    await expect(
      handleDelete({ name: "nonexistent.xyz" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_NOT_FOUND",
    );
  });

  it("refuses to delete when usedBy is non-empty without force (PROC_IN_USE with referrers in details)", async () => {
    // gmail.send_email is used by email_posthog_users
    await expect(
      handleDelete({ name: "gmail.send_email" }),
    ).rejects.toSatisfy(
      (err: unknown) => {
        if (!(err instanceof CodedError)) return false;
        if (err.code !== "PROC_IN_USE") return false;
        // Check that details include the referrers list
        const details = err.details as { referrers?: string[] } | undefined;
        return Array.isArray(details?.referrers) && details.referrers.length > 0;
      },
    );
  });

  it("deletes a procedure with no referrers", async () => {
    // Save a fresh proc with no referrers
    const deletableYaml = `\
schema_version: 1
name: deletable.proc
description: A procedure we will delete
kind: leaf
inputs:
  x: { type: string, required: true }
steps:
  - id: step1
    action: browser_click
    with:
      ref: 99
`;
    await handleSave({ name: "deletable.proc", yaml: deletableYaml });

    // Should delete without force (no referrers)
    const result = await handleDelete({ name: "deletable.proc" });
    expect(result.deleted).toBe(true);
    expect(typeof result.path).toBe("string");

    // Verify gone from index
    await expect(handleGet({ name: "deletable.proc" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_NOT_FOUND",
    );
  });

  it("force=true on a referenced procedure succeeds", async () => {
    // posthog.export_cohort has no usedBy in our fixture (email_posthog_users doesn't reference it)
    // Let's save a new proc and force-delete it
    const forceDeleteYaml = `\
schema_version: 1
name: force.delete_me
description: A procedure to force-delete
kind: leaf
inputs:
  x: { type: string, required: true }
steps:
  - id: step1
    action: browser_navigate
    with:
      url: "https://example.com"
`;
    await handleSave({ name: "force.delete_me", yaml: forceDeleteYaml });
    const result = await handleDelete({ name: "force.delete_me", force: true });
    expect(result.deleted).toBe(true);
    expect(typeof result.path).toBe("string");
  });

  it("throws INVALID_PARAMS when force is not boolean", async () => {
    await expect(handleDelete({ name: "gmail.send_email", force: "yes" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("deleting a composite also deletes its subs directory (cascade)", async () => {
    // Save a standalone composite with a sub
    const standaloneSubYaml = `\
schema_version: 1
name: cascade_sub
description: Sub of standalone composite
kind: leaf
inputs:
  x: { type: string, required: true }
steps:
  - id: step1
    action: browser_click
    with:
      ref: 1
`;
    const standaloneCompositeYaml = `\
schema_version: 1
name: cascade_composite
description: Standalone composite we will cascade-delete
kind: composite
uses:
  - cascade_sub
inputs:
  x: { type: string, required: true }
steps:
  - id: step1
    action: cascade_sub
    with:
      x: "{{input.x}}"
`;
    // Save the standalone sub first
    await handleSave({ name: "cascade_sub", yaml: standaloneSubYaml });
    // Save the standalone composite
    await handleSave({ name: "cascade_composite", yaml: standaloneCompositeYaml });
    // Save cascade_sub under the composite (as a subs/ entry)
    await handleSave({
      name: "cascade_sub",
      yaml: standaloneSubYaml,
      owner: "cascade_composite",
    });

    // Delete the composite — should cascade
    const result = await handleDelete({ name: "cascade_composite", force: true });
    expect(result.deleted).toBe(true);

    // Composite should be gone
    await expect(handleGet({ name: "cascade_composite" })).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "PROC_NOT_FOUND",
    );
  });
});
