import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { buildIndex } from "./index-builder.js";
import { search } from "./search.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".pbsearch-test-"),
  );
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeYaml(rel: string, doc: unknown): Promise<void> {
  const abs = path.join(tmpDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, YAML.stringify(doc), "utf8");
}

const trustedLeaf = (
  name: string,
  description: string,
  extras: Record<string, unknown> = {},
) => ({
  schema_version: 1,
  name,
  description,
  kind: "leaf",
  steps: [{ id: "s1", do: "navigate", with: { url: "https://example.com" } }],
  meta: { version: 1, created: "2026-05-21T00:00:00Z", status: "trusted" },
  ...extras,
});

describe("playbooks search", () => {
  it("scores name + description coverage", async () => {
    await writeYaml(
      "shared/gmail_send/playbook.yaml",
      trustedLeaf("gmail.send_email", "Send an email via Gmail."),
    );
    await writeYaml(
      "shared/slack_send/playbook.yaml",
      trustedLeaf("slack.dm", "Send a Slack direct message."),
    );

    const manifest = await buildIndex(tmpDir);
    const result = await search(tmpDir, manifest, "gmail send email");

    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0]?.name).toBe("gmail.send_email");
  });

  it("respects min_score", async () => {
    await writeYaml(
      "shared/gmail_send/playbook.yaml",
      trustedLeaf("gmail.send_email", "Send an email via Gmail."),
    );

    const manifest = await buildIndex(tmpDir);
    const result = await search(tmpDir, manifest, "totally unrelated topic", {
      min_score: 0.5,
    });
    expect(result.matches.length).toBe(0);
  });

  it("filters by domain", async () => {
    await writeYaml(
      "shared/gmail_send/playbook.yaml",
      trustedLeaf("gmail.send_email", "Send an email via Gmail.", {
        domain: "gmail",
      }),
    );
    await writeYaml(
      "shared/slack_send/playbook.yaml",
      trustedLeaf("slack.dm", "Send a Slack direct message.", {
        domain: "slack",
      }),
    );

    const manifest = await buildIndex(tmpDir);
    const result = await search(tmpDir, manifest, "send", { domain: "gmail" });
    expect(result.matches.every((m) => m.domain === "gmail")).toBe(true);
  });

  it("excludes drafts by default; falls back to drafts when no trusted match", async () => {
    await writeYaml("shared/dr/playbook.yaml", {
      schema_version: 1,
      name: "draft.only",
      description: "Draft only example flow",
      kind: "leaf",
      steps: [{ id: "s1", do: "navigate", with: { url: "x" } }],
      // no meta → defaults to draft
    });

    const manifest = await buildIndex(tmpDir);
    const result = await search(tmpDir, manifest, "draft only example");
    expect(result.matches.length).toBe(0);
    expect(result.drafts?.length).toBeGreaterThan(0);
  });

  it("includes drafts when include_drafts: true", async () => {
    await writeYaml("shared/dr/playbook.yaml", {
      schema_version: 1,
      name: "draft.only",
      description: "Draft flow",
      kind: "leaf",
      steps: [{ id: "s1", do: "navigate", with: { url: "x" } }],
    });

    const manifest = await buildIndex(tmpDir);
    const result = await search(tmpDir, manifest, "draft flow", {
      include_drafts: true,
    });
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("returns side_effects on matches", async () => {
    await writeYaml(
      "shared/pay/playbook.yaml",
      trustedLeaf("billing.pay", "Pay an invoice.", {
        side_effects: ["payment"],
      }),
    );

    const manifest = await buildIndex(tmpDir);
    const result = await search(tmpDir, manifest, "pay invoice");
    expect(result.matches[0]?.side_effects).toEqual(["payment"]);
  });

  it("rejects empty query", async () => {
    const manifest = await buildIndex(tmpDir);
    await expect(search(tmpDir, manifest, "  ")).rejects.toThrow(/empty/);
  });

  it("scope filter: composite:X surfaces only that composite + its subs", async () => {
    await writeYaml(
      "shared/standalone/playbook.yaml",
      trustedLeaf("standalone.send", "Standalone send"),
    );
    await writeYaml("comp/playbook.yaml", {
      schema_version: 1,
      name: "comp.root",
      description: "Composite root",
      kind: "composite",
      uses: ["comp.root.sub"],
      meta: { version: 1, created: "2026-05-21T00:00:00Z", status: "trusted" },
      steps: [
        { id: "s1", do: "playbook_call", with: { name: "comp.root.sub" } },
      ],
    });
    await writeYaml(
      "comp/subs/sub/playbook.yaml",
      trustedLeaf("comp.root.sub", "Composite sub send"),
    );

    const manifest = await buildIndex(tmpDir);
    const result = await search(tmpDir, manifest, "send composite", {
      scope: "composite:comp.root",
    });
    expect(
      result.matches.every(
        (m) => m.name === "comp.root" || m.name === "comp.root.sub",
      ),
    ).toBe(true);
  });
});
