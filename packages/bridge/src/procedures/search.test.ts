/**
 * Unit tests for the search module.
 *
 * Most tests operate on an in-memory Manifest directly — no filesystem for
 * the shallow-mode tests. One deep-mode test writes a real YAML to a tmpdir.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { search } from "./search.js";
import { CodedError } from "./store.js";
import type { Manifest, ManifestEntry } from "./index-builder.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeEntry(
  name: string,
  partial: Partial<ManifestEntry> = {},
): ManifestEntry {
  return {
    path: `shared/${name}/procedure.yaml`,
    kind: "leaf",
    domain: null,
    description: `Description for ${name}`,
    inputs: [],
    triggers: [],
    tags: [],
    owner: null,
    usedBy: [],
    tokens: [],
    ...partial,
  };
}

function makeManifest(
  entries: Record<string, ManifestEntry>,
): Manifest {
  return {
    version: 1,
    updated: new Date().toISOString(),
    procedures: entries,
  };
}

// Sentinel: a root that doesn't exist on disk. Safe to pass in shallow mode.
const PHANTOM_ROOT = "/nonexistent/procedures/root";

// ---------------------------------------------------------------------------
// Basic scoring
// ---------------------------------------------------------------------------

describe("exact name match scores higher than description-only match", () => {
  const manifest = makeManifest({
    "gmail.send_email": makeEntry("gmail.send_email", {
      description: "Compose and send a Gmail email via the web UI",
      domain: "gmail",
    }),
    "other.compose": makeEntry("other.compose", {
      description: "Send an email using Gmail",
      domain: "other",
    }),
  });

  it("exact name match wins", async () => {
    const result = await search(PHANTOM_ROOT, manifest, "gmail send email");
    expect(result.matches.length).toBeGreaterThan(0);
    // The top match must be the one whose name contains the query tokens
    expect(result.matches[0]!.name).toBe("gmail.send_email");
  });
});

// ---------------------------------------------------------------------------
// Trigger vs description ranking
// ---------------------------------------------------------------------------

describe("trigger match beats description match", () => {
  const manifest = makeManifest({
    "proc_a": makeEntry("proc_a", {
      description: "Sends notifications",
      triggers: ["email campaign", "send bulk email"],
    }),
    "proc_b": makeEntry("proc_b", {
      description: "Manage email campaign records",
      triggers: ["open spreadsheet"],
    }),
  });

  it("trigger-matching proc_a ranks above description-matching proc_b", async () => {
    const result = await search(PHANTOM_ROOT, manifest, "email campaign");
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
    expect(result.matches[0]!.name).toBe("proc_a");
  });
});

// ---------------------------------------------------------------------------
// Stop-word stripping
// ---------------------------------------------------------------------------

describe("stop words are stripped before scoring", () => {
  const manifest = makeManifest({
    "send_email": makeEntry("send_email", {
      description: "Sends email messages",
    }),
  });

  it("query 'send me an email' reduces to [send, email] and matches", async () => {
    // "me", "an" are stop words → stripped
    const result = await search(PHANTOM_ROOT, manifest, "send me an email", {
      min_score: 0,
    });
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]!.name).toBe("send_email");
  });
});

// ---------------------------------------------------------------------------
// All-stop-word query → zero matches, no throw
// ---------------------------------------------------------------------------

describe("empty post-tokenisation query returns zero matches without throwing", () => {
  const manifest = makeManifest({
    "some_proc": makeEntry("some_proc"),
  });

  it("'send me an' → zero matches", async () => {
    // "send", "me", "an" — "send" is not a stop-word but let's use an all-stop query
    // All entries in STOP_WORDS list: "a an the and or"
    const result = await search(PHANTOM_ROOT, manifest, "a an the or and");
    expect(result.matches).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Empty raw query throws INVALID_PARAMS
// ---------------------------------------------------------------------------

describe("empty raw query throws INVALID_PARAMS", () => {
  const manifest = makeManifest({});

  it("whitespace-only query throws", async () => {
    await expect(
      search(PHANTOM_ROOT, manifest, "   "),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("empty string query throws", async () => {
    await expect(
      search(PHANTOM_ROOT, manifest, ""),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });
});

// ---------------------------------------------------------------------------
// min_score filtering
// ---------------------------------------------------------------------------

describe("min_score filters low-scoring candidates", () => {
  // proc_low has "xyzzy" in name — no overlap with "email"
  const manifest = makeManifest({
    "email_sender": makeEntry("email_sender", {
      description: "Sends email",
    }),
    "xyzzy_proc": makeEntry("xyzzy_proc", {
      description: "Totally unrelated xyzzy procedure",
    }),
  });

  it("xyzzy_proc is excluded with min_score: 0.3", async () => {
    const result = await search(PHANTOM_ROOT, manifest, "email", {
      min_score: 0.3,
    });
    const names = result.matches.map((m) => m.name);
    expect(names).not.toContain("xyzzy_proc");
  });
});

// ---------------------------------------------------------------------------
// limit truncation
// ---------------------------------------------------------------------------

describe("limit truncation", () => {
  // Build 15 procedures all matching "click"
  const entries: Record<string, ManifestEntry> = {};
  for (let i = 0; i < 15; i++) {
    const name = `click_proc_${i.toString().padStart(2, "0")}`;
    entries[name] = makeEntry(name, {
      description: `Click something ${i}`,
      triggers: ["click the button"],
    });
  }
  const manifest = makeManifest(entries);

  it("limit:5 returns 5 matches, truncated=true, total=15", async () => {
    const result = await search(PHANTOM_ROOT, manifest, "click", {
      limit: 5,
      min_score: 0,
    });
    expect(result.matches).toHaveLength(5);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(15);
  });

  it("limit clamped to 1 at minimum", async () => {
    const result = await search(PHANTOM_ROOT, manifest, "click", {
      limit: 0,
      min_score: 0,
    });
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches.length).toBeLessThanOrEqual(1);
  });

  it("limit clamped to 25 at maximum", async () => {
    // add 30 entries total
    const big: Record<string, ManifestEntry> = {};
    for (let i = 0; i < 30; i++) {
      const name = `widget_${i.toString().padStart(2, "0")}`;
      big[name] = makeEntry(name, {
        description: `Widget click action ${i}`,
        triggers: ["click widget"],
      });
    }
    const bigManifest = makeManifest(big);
    const result = await search(PHANTOM_ROOT, bigManifest, "click widget", {
      limit: 100,
      min_score: 0,
    });
    expect(result.matches.length).toBeLessThanOrEqual(25);
  });
});

// ---------------------------------------------------------------------------
// domain filter
// ---------------------------------------------------------------------------

describe("domain filter", () => {
  const manifest = makeManifest({
    "gmail.send": makeEntry("gmail.send", {
      domain: "gmail",
      description: "Send email via Gmail",
    }),
    "slack.notify": makeEntry("slack.notify", {
      domain: "slack",
      description: "Send notification via Slack",
    }),
    "no_domain": makeEntry("no_domain", {
      domain: null,
      description: "Send something general",
    }),
  });

  it("domain: 'gmail' only returns gmail procedures", async () => {
    const result = await search(PHANTOM_ROOT, manifest, "send", {
      domain: "gmail",
      min_score: 0,
    });
    expect(result.matches.every((m) => m.domain === "gmail")).toBe(true);
    const names = result.matches.map((m) => m.name);
    expect(names).toContain("gmail.send");
    expect(names).not.toContain("slack.notify");
    expect(names).not.toContain("no_domain");
  });
});

// ---------------------------------------------------------------------------
// scope: "shared"
// ---------------------------------------------------------------------------

describe("scope: 'shared' excludes composites and subs", () => {
  const manifest = makeManifest({
    "shared_leaf": makeEntry("shared_leaf", {
      path: "shared/shared_leaf/procedure.yaml",
      owner: null,
      description: "A shared leaf procedure for search",
    }),
    "composite_x": makeEntry("composite_x", {
      path: "composite_x/procedure.yaml",
      kind: "composite",
      owner: null,
      description: "A composite that does search-like things",
    }),
    "sub_one": makeEntry("sub_one", {
      path: "composite_x/subs/sub_one/procedure.yaml",
      owner: "composite_x",
      description: "Sub procedure for searching",
    }),
  });

  it("scope: 'shared' only returns the shared leaf", async () => {
    const result = await search(PHANTOM_ROOT, manifest, "search", {
      scope: "shared",
      min_score: 0,
    });
    const names = result.matches.map((m) => m.name);
    expect(names).toContain("shared_leaf");
    expect(names).not.toContain("composite_x");
    expect(names).not.toContain("sub_one");
  });
});

// ---------------------------------------------------------------------------
// scope: "composite:<name>"
// ---------------------------------------------------------------------------

describe("scope: composite:X returns X and its subs", () => {
  const manifest = makeManifest({
    "shared_leaf": makeEntry("shared_leaf", {
      path: "shared/shared_leaf/procedure.yaml",
      owner: null,
      description: "Shared email leaf procedure",
    }),
    "workflow_a": makeEntry("workflow_a", {
      path: "workflow_a/procedure.yaml",
      kind: "composite",
      owner: null,
      description: "Email workflow composite",
    }),
    "sub_step": makeEntry("sub_step", {
      path: "workflow_a/subs/sub_step/procedure.yaml",
      owner: "workflow_a",
      description: "Sub step for email workflow",
    }),
    "other_leaf": makeEntry("other_leaf", {
      path: "shared/other_leaf/procedure.yaml",
      owner: null,
      description: "Another email leaf",
    }),
  });

  it("scope: 'composite:workflow_a' returns workflow_a and sub_step", async () => {
    const result = await search(PHANTOM_ROOT, manifest, "email", {
      scope: "composite:workflow_a",
      min_score: 0,
    });
    const names = result.matches.map((m) => m.name);
    expect(names).toContain("workflow_a");
    expect(names).toContain("sub_step");
    expect(names).not.toContain("shared_leaf");
    expect(names).not.toContain("other_leaf");
  });
});

// ---------------------------------------------------------------------------
// deep: false — no YAML loaded even with non-existent path
// ---------------------------------------------------------------------------

describe("deep: false does not load any YAML files", () => {
  // Entry points to a file that doesn't exist — should not error in shallow mode
  const manifest = makeManifest({
    "phantom_proc": makeEntry("phantom_proc", {
      path: "shared/phantom_proc/procedure.yaml",
      description: "Phantom procedure for testing",
      triggers: ["phantom trigger"],
    }),
  });

  it("shallow search on non-existent path does not throw", async () => {
    await expect(
      search(PHANTOM_ROOT, manifest, "phantom", {
        deep: false,
        min_score: 0,
      }),
    ).resolves.toBeDefined();
  });

  it("returns match from shallow index data only", async () => {
    const result = await search(PHANTOM_ROOT, manifest, "phantom", {
      deep: false,
      min_score: 0,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.name).toBe("phantom_proc");
  });
});

// ---------------------------------------------------------------------------
// deep: true — finds step-body matches
// ---------------------------------------------------------------------------

describe("deep: true finds step-body matches that shallow misses", () => {
  let tmpDir: string;
  let root: string;

  const PROC_NAME = "stepper";

  // This YAML has a unique token "frobulate" only in the step body (with param),
  // not in name/description/triggers/tags/inputs.
  const STEPPER_YAML = `\
schema_version: 1
name: stepper
description: A procedure for testing deep search
kind: leaf
steps:
  - id: step1
    action: browser.execute_js
    with:
      script: "document.frobulate()"
`;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(import.meta.dirname ?? __dirname, ".search-deep-test-"),
    );
    root = tmpDir;

    const procDir = path.join(root, "shared", PROC_NAME);
    await fs.mkdir(procDir, { recursive: true });
    await fs.writeFile(path.join(procDir, "procedure.yaml"), STEPPER_YAML, "utf8");
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeStepperManifest(): Manifest {
    return makeManifest({
      [PROC_NAME]: makeEntry(PROC_NAME, {
        path: `shared/${PROC_NAME}/procedure.yaml`,
        description: "A procedure for testing deep search",
        // "frobulate" is NOT in any index field
        triggers: [],
        tags: [],
        inputs: [],
      }),
    });
  }

  it("shallow search misses 'frobulate'", async () => {
    const manifest = makeStepperManifest();
    // Use default min_score (0.2) — frobulate scores 0 in shallow mode so it is filtered out
    const result = await search(root, manifest, "frobulate", {
      deep: false,
    });
    expect(result.matches).toHaveLength(0);
  });

  it("deep search finds 'frobulate' in step body", async () => {
    const manifest = makeStepperManifest();
    // With deep:true, the step body contains "frobulate" → non-zero score
    const result = await search(root, manifest, "frobulate", {
      deep: true,
      min_score: 0,
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.name).toBe(PROC_NAME);
  });
});

// ---------------------------------------------------------------------------
// snippet logic
// ---------------------------------------------------------------------------

describe("snippet is set when match is trigger-driven; not set for pure name match", () => {
  const manifest = makeManifest({
    "email.send": makeEntry("email.send", {
      domain: "email",
      description: "Send an email message",
      triggers: ["send an email to user", "compose email message"],
    }),
    "pure_name_match": makeEntry("pure_name_match", {
      description: "Something unrelated",
      triggers: [],
    }),
  });

  it("trigger-driven match includes a snippet", async () => {
    // Query 'email send' — triggers contribute more than name for email.send
    // because triggers contain "email send" phrase
    const result = await search(PHANTOM_ROOT, manifest, "compose email", {
      min_score: 0,
    });
    const emailMatch = result.matches.find((m) => m.name === "email.send");
    expect(emailMatch).toBeDefined();
    // Should have snippet since trigger "compose email message" contains query tokens
    expect(emailMatch!.snippet).toBeDefined();
    if (emailMatch!.snippet !== undefined) {
      expect(emailMatch!.snippet.length).toBeLessThanOrEqual(60);
    }
  });

  it("pure name match does not include a snippet", async () => {
    // Query exactly matches "pure_name_match" name tokens → name score dominates
    const result = await search(PHANTOM_ROOT, manifest, "pure name match", {
      min_score: 0,
    });
    const nameMatch = result.matches.find((m) => m.name === "pure_name_match");
    expect(nameMatch).toBeDefined();
    // No triggers, no description match → name dominates → no snippet
    expect(nameMatch!.snippet).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SearchResult shape
// ---------------------------------------------------------------------------

describe("SearchResult shape is correct", () => {
  const manifest = makeManifest({
    "foo.bar": makeEntry("foo.bar", {
      domain: "foo",
      kind: "leaf",
      description: "Foo bar procedure",
      inputs: ["x", "y"],
      triggers: ["do foo bar"],
    }),
  });

  it("match has all required fields", async () => {
    const result = await search(PHANTOM_ROOT, manifest, "foo bar", {
      min_score: 0,
    });
    expect(result.matches.length).toBeGreaterThan(0);
    const m = result.matches[0]!;
    expect(typeof m.name).toBe("string");
    expect(m.kind === "leaf" || m.kind === "composite").toBe(true);
    expect(typeof m.description).toBe("string");
    expect(Array.isArray(m.inputs)).toBe(true);
    expect(Array.isArray(m.triggers)).toBe(true);
    expect(typeof m.score).toBe("number");
    expect(m.score).toBeGreaterThan(0);
    expect(m.score).toBeLessThanOrEqual(1);
  });

  it("non-truncated result has truncated=false", async () => {
    const result = await search(PHANTOM_ROOT, manifest, "foo", { min_score: 0 });
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(result.matches.length);
  });
});
