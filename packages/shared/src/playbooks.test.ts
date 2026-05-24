import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import { PLAYBOOK_SCHEMA, type PlaybookDef } from "./playbooks.js";

function makeAjv() {
  return new Ajv({ allErrors: true, strict: false });
}

const minimalLeaf: PlaybookDef = {
  schema_version: 1,
  name: "demo.minimal",
  description: "Minimal leaf playbook.",
  kind: "leaf",
  steps: [{ id: "s1", do: "navigate", with: { url: "https://example.com" } }],
};

const richLeaf: PlaybookDef = {
  schema_version: 1,
  name: "gmail.send_email",
  description: "Compose and send an email via Gmail web.",
  kind: "leaf",
  goal: "Send an email.",
  domain: "gmail",
  triggers: ["send email"],
  tags: ["email", "compose"],
  side_effects: ["send_message"],
  inputs: {
    to: { type: "string", required: true, destructive: true },
    subject: { type: "string", required: true },
    body: { type: "string", required: true },
  },
  forbidden: {
    locators: [{ name: "/^delete/i" }],
    actions: ["browser_execute_js"],
  },
  verify: { text_visible: "Message sent" },
  steps: [
    {
      id: "open_compose",
      goal: "Open the compose pane.",
      do: "click",
      locator: { role: "button", name: "/^compose/i" },
      auto_wait: { timeout_ms: 4000 },
      expect: { new_dialog: true, timeout_ms: 5000 },
      fallback: {
        strategy: "relocate_then_llm",
        budget: { tool_calls: 3 },
        retry: { attempts: 2, backoff_ms: 500 },
        relocate: { widen_role: true, widen_name: true },
      },
    },
    {
      id: "send",
      do: "click",
      locator: { role: "button", name: "/^send/i" },
      expect: { network_endpoint: "/sendmessage" },
      fallback: { strategy: "llm" },
    },
  ],
};

const minimalComposite: PlaybookDef = {
  schema_version: 1,
  name: "billing.pay_invoice",
  description: "Pay an invoice end-to-end.",
  kind: "composite",
  uses: ["billing.lookup_invoice", "billing.submit_payment"],
  steps: [
    { id: "lookup", do: "playbook_call", with: { name: "billing.lookup_invoice" } },
  ],
};

describe("PLAYBOOK_SCHEMA", () => {
  const ajv = makeAjv();
  const validate = ajv.compile(PLAYBOOK_SCHEMA);

  it("accepts a minimal leaf playbook", () => {
    const ok = validate(minimalLeaf);
    expect(ok).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("accepts a rich leaf playbook with all bells", () => {
    const ok = validate(richLeaf);
    expect(ok).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("accepts a composite playbook with uses", () => {
    const ok = validate(minimalComposite);
    expect(ok).toBe(true);
  });

  it("rejects a composite playbook missing uses", () => {
    const bad = { ...minimalComposite, uses: undefined };
    const ok = validate(bad);
    expect(ok).toBe(false);
  });

  it("rejects bad name pattern", () => {
    const bad = { ...minimalLeaf, name: "Bad-Name" };
    const ok = validate(bad);
    expect(ok).toBe(false);
  });

  it("rejects unknown step action", () => {
    const bad = {
      ...minimalLeaf,
      steps: [{ id: "s1", do: "explode" }],
    };
    const ok = validate(bad);
    expect(ok).toBe(false);
  });

  it("rejects unknown fallback strategy", () => {
    const bad = {
      ...minimalLeaf,
      steps: [
        {
          id: "s1",
          do: "click",
          fallback: { strategy: "ask_friend" },
        },
      ],
    };
    const ok = validate(bad);
    expect(ok).toBe(false);
  });

  it("rejects extra top-level fields", () => {
    const bad = { ...minimalLeaf, surprise: true } as unknown;
    const ok = validate(bad);
    expect(ok).toBe(false);
  });

  it("rejects steps > 60", () => {
    const steps = Array.from({ length: 61 }, (_, i) => ({
      id: `s${i}`,
      do: "navigate",
      with: { url: "https://example.com" },
    }));
    const bad = { ...minimalLeaf, steps };
    const ok = validate(bad);
    expect(ok).toBe(false);
  });

  it("rejects side_effects with duplicates", () => {
    const bad = { ...minimalLeaf, side_effects: ["send_message", "send_message"] };
    const ok = validate(bad);
    expect(ok).toBe(false);
  });

  it("rejects unknown side_effect classes", () => {
    const bad = { ...minimalLeaf, side_effects: ["nuke"] };
    const ok = validate(bad);
    expect(ok).toBe(false);
  });

  it("accepts a step with only a do field", () => {
    const ok = validate({
      ...minimalLeaf,
      steps: [{ id: "s1", do: "observe" }],
    });
    expect(ok).toBe(true);
  });

  it("rejects step missing id", () => {
    const bad = {
      ...minimalLeaf,
      steps: [{ do: "navigate", with: { url: "x" } }],
    };
    const ok = validate(bad);
    expect(ok).toBe(false);
  });

  describe("meta.health", () => {
    it("accepts a meta.health block with per-step locator drift entries", () => {
      const ok = validate({
        ...minimalLeaf,
        meta: {
          version: 1,
          created: "2026-05-24T00:00:00Z",
          health: {
            updated: "2026-05-24T00:00:00Z",
            steps: {
              s1: {
                runs: 10,
                relocates: 1,
                ambiguous_resolves: 0,
                target_changed: 0,
                avg_match_count: 1.1,
                last_tier: 1,
              },
            },
          },
        },
      });
      expect(ok).toBe(true);
    });

    it("rejects health.steps entries with negative counters", () => {
      const bad = {
        ...minimalLeaf,
        meta: {
          version: 1,
          created: "2026-05-24T00:00:00Z",
          health: {
            updated: "2026-05-24T00:00:00Z",
            steps: { s1: { runs: -1, relocates: 0, ambiguous_resolves: 0, target_changed: 0 } },
          },
        },
      };
      expect(validate(bad)).toBe(false);
    });

    it("rejects unknown fields under health.steps[stepId]", () => {
      const bad = {
        ...minimalLeaf,
        meta: {
          version: 1,
          created: "2026-05-24T00:00:00Z",
          health: {
            updated: "2026-05-24T00:00:00Z",
            steps: { s1: { runs: 1, junk: true } },
          },
        },
      };
      expect(validate(bad)).toBe(false);
    });

    it("accepts a health block with no per-step entries (freshly created)", () => {
      const ok = validate({
        ...minimalLeaf,
        meta: {
          version: 1,
          created: "2026-05-24T00:00:00Z",
          health: { updated: "2026-05-24T00:00:00Z", steps: {} },
        },
      });
      expect(ok).toBe(true);
    });
  });
});
