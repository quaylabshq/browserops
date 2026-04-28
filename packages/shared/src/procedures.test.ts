import Ajv from "ajv";
import { describe, expect, it, beforeAll } from "vitest";
import { PROCEDURE_SCHEMA, STOP_WORDS, tokenize } from "./procedures.js";
import type { ValidateFunction } from "ajv";

// ---------------------------------------------------------------------------
// Ajv setup
// ---------------------------------------------------------------------------

let validate: ValidateFunction;

beforeAll(() => {
  const ajv = new Ajv({ strict: false });
  validate = ajv.compile(PROCEDURE_SCHEMA);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function valid(obj: unknown): boolean {
  const ok = validate(obj);
  return ok as boolean;
}

function invalid(obj: unknown): boolean {
  return !valid(obj);
}

// ---------------------------------------------------------------------------
// example procedure (constructed literally — no YAML file read)
// ---------------------------------------------------------------------------

const EXAMPLE_LEAF_PROCEDURE = {
  schema_version: 1,
  name: "gmail.send_email",
  description: "Compose and send a Gmail email via the web UI",
  kind: "leaf",
  domain: "gmail",
  triggers: [
    "email users who did",
    "send an email to",
    "message someone about",
  ],
  tags: ["email", "outreach"],
  inputs: {
    to: { type: "string", required: true, description: "Recipient email address" },
    subject: { type: "string", required: true },
    body: { type: "string", required: true },
  },
  preconditions: [
    {
      url_matches: "^https://mail\\.google\\.com/",
      fallback: {
        action: "browser_navigate",
        with: { url: "https://mail.google.com/mail/u/0/" },
      },
    },
  ],
  steps: [
    {
      id: "open_compose",
      action: "browser_click_by_text",
      with: {
        tab_id: "{{tab_id}}",
        text: "Compose",
      },
      wait_for: { selector: ".compose-dialog" },
      bind: "compose_ref",
      on_fail: [{ action: "browser_click", with: { tab_id: "{{tab_id}}", ref: 1 } }],
    },
  ],
  success_criteria: [{ toast_text: "Message sent" }],
  meta: {
    version: 3,
    created: "2026-04-01T10:00:00Z",
    last_verified: "2026-04-20T14:22:00Z",
    success_count: 12,
    failure_count: 1,
  },
} as const;

const EXAMPLE_COMPOSITE_PROCEDURE = {
  schema_version: 1,
  name: "email_posthog_users",
  description: "Find PostHog users by behavior and email them",
  kind: "composite",
  uses: ["find_users_by_event", "gmail.send_email"],
  steps: [
    {
      id: "send_all",
      for_each: "{{users}}",
      as: "user",
      do: [
        {
          action: "gmail.send_email",
          with: {
            to: "{{user.email}}",
            subject: "{{input.subject}}",
            body: "{{input.body}}",
          },
        },
      ],
    },
  ],
} as const;

// ---------------------------------------------------------------------------
// Schema: valid cases
// ---------------------------------------------------------------------------

describe("PROCEDURE_SCHEMA — valid cases", () => {
  it("accepts the leaf example", () => {
    expect(valid(EXAMPLE_LEAF_PROCEDURE)).toBe(true);
  });

  it("accepts a composite procedure with uses", () => {
    expect(valid(EXAMPLE_COMPOSITE_PROCEDURE)).toBe(true);
  });

  it("accepts a minimal leaf (only required fields)", () => {
    expect(
      valid({
        schema_version: 1,
        name: "my.proc",
        description: "A minimal procedure",
        kind: "leaf",
        steps: [{ id: "s1", action: "browser_click", with: { ref: 1 } }],
      }),
    ).toBe(true);
  });

  it("accepts a step with a fully-populated expected_effect", () => {
    expect(
      valid({
        schema_version: 1,
        name: "my.proc",
        description: "A procedure with expected_effect on a step",
        kind: "leaf",
        steps: [
          {
            id: "s1",
            action: "browser_navigate",
            with: { tab_id: "t_1", url: "https://example.com" },
            expected_effect: {
              dom: {
                any: true,
                added_min: 5,
                removed_min: 0,
                attr_changes_min: 2,
                text_changes_min: 1,
              },
              url: { changed: true },
              focus: { changed: false },
              network: { requests_started_min: 3, requests_completed_min: 2 },
              console_errors_max: 0,
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts a step with a partial expected_effect (only url.changed)", () => {
    expect(
      valid({
        schema_version: 1,
        name: "my.proc",
        description: "Partial expected_effect",
        kind: "leaf",
        steps: [
          {
            id: "s1",
            action: "browser_navigate",
            with: { tab_id: "t_1", url: "https://example.com" },
            expected_effect: { url: { changed: true } },
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts a step with selector_tier", () => {
    for (const tier of ["id", "testid", "role_name", "text", "css", "xpath"]) {
      expect(
        valid({
          schema_version: 1,
          name: "my.proc",
          description: "with selector_tier",
          kind: "leaf",
          steps: [
            {
              id: "s1",
              action: "browser_click",
              with: { tab_id: "t_1", ref: 1 },
              selector_tier: tier,
            },
          ],
        }),
      ).toBe(true);
    }
  });

  it("accepts top-level fragility and side_effects", () => {
    expect(
      valid({
        schema_version: 1,
        name: "my.proc",
        description: "with fragility and side_effects",
        kind: "leaf",
        steps: [{ id: "s1", action: "browser_click" }],
        fragility: "low",
        side_effects: ["send_message", "post_public"],
      }),
    ).toBe(true);
  });

  it("accepts an input flagged destructive", () => {
    expect(
      valid({
        schema_version: 1,
        name: "my.proc",
        description: "with destructive input",
        kind: "leaf",
        inputs: {
          recipient: { type: "string", destructive: true, required: true },
        },
        steps: [{ id: "s1", action: "browser_click" }],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema: rejection cases
// ---------------------------------------------------------------------------

describe("PROCEDURE_SCHEMA — rejection cases", () => {
  it("rejects composite without uses", () => {
    expect(
      invalid({
        schema_version: 1,
        name: "my.composite",
        description: "A composite without uses",
        kind: "composite",
        steps: [{ id: "s1", action: "my.sub" }],
        // uses: intentionally omitted
      }),
    ).toBe(true);
  });

  it("rejects name violating the pattern (uppercase)", () => {
    expect(
      invalid({
        schema_version: 1,
        name: "Gmail.SendEmail",
        description: "Bad name",
        kind: "leaf",
        steps: [{ id: "s1", action: "browser_click" }],
      }),
    ).toBe(true);
  });

  it("rejects name starting with a digit", () => {
    expect(
      invalid({
        schema_version: 1,
        name: "1proc",
        description: "Bad name",
        kind: "leaf",
        steps: [{ id: "s1", action: "browser_click" }],
      }),
    ).toBe(true);
  });

  it("rejects steps array exceeding maxItems (40)", () => {
    const manySteps = Array.from({ length: 41 }, (_, i) => ({
      id: `s${i}`,
      action: "browser_click",
    }));
    expect(
      invalid({
        schema_version: 1,
        name: "my.proc",
        description: "Too many steps",
        kind: "leaf",
        steps: manySteps,
      }),
    ).toBe(true);
  });

  it("rejects tags array exceeding maxItems (10)", () => {
    expect(
      invalid({
        schema_version: 1,
        name: "my.proc",
        description: "Too many tags",
        kind: "leaf",
        steps: [{ id: "s1", action: "browser_click" }],
        tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
      }),
    ).toBe(true);
  });

  it("rejects missing required top-level field (name)", () => {
    expect(
      invalid({
        schema_version: 1,
        description: "Missing name",
        kind: "leaf",
        steps: [{ id: "s1", action: "browser_click" }],
      }),
    ).toBe(true);
  });

  it("rejects steps array with zero items (minItems: 1)", () => {
    expect(
      invalid({
        schema_version: 1,
        name: "my.proc",
        description: "Empty steps",
        kind: "leaf",
        steps: [],
      }),
    ).toBe(true);
  });

  it("rejects description longer than 200 chars", () => {
    expect(
      invalid({
        schema_version: 1,
        name: "my.proc",
        description: "x".repeat(201),
        kind: "leaf",
        steps: [{ id: "s1", action: "browser_click" }],
      }),
    ).toBe(true);
  });

  it("rejects an unknown selector_tier value", () => {
    expect(
      invalid({
        schema_version: 1,
        name: "my.proc",
        description: "bad selector_tier",
        kind: "leaf",
        steps: [
          {
            id: "s1",
            action: "browser_click",
            selector_tier: "made_up",
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects an unknown side_effects entry", () => {
    expect(
      invalid({
        schema_version: 1,
        name: "my.proc",
        description: "bad side_effects",
        kind: "leaf",
        steps: [{ id: "s1", action: "browser_click" }],
        side_effects: ["send_message", "made_up_class"],
      }),
    ).toBe(true);
  });

  it("rejects expected_effect with an unknown sub-field (e.g. dom.unknown_field)", () => {
    expect(
      invalid({
        schema_version: 1,
        name: "my.proc",
        description: "Bad expected_effect",
        kind: "leaf",
        steps: [
          {
            id: "s1",
            action: "browser_click",
            with: { tab_id: "t_1", ref: 1 },
            expected_effect: { dom: { unknown_field: true } },
          },
        ],
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// STOP_WORDS
// ---------------------------------------------------------------------------

describe("STOP_WORDS", () => {
  it("contains canonical words from", () => {
    const expected = [
      "a", "an", "the", "and", "or", "for", "in", "to", "with",
      "is", "are", "was", "be", "been", "has", "have", "do",
      "me", "my", "you", "they", "we", "it",
      "this", "that", "what", "who", "where", "when", "how",
      "not", "no", "please", "want", "need",
    ];
    for (const w of expected) {
      expect(STOP_WORDS.has(w)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// tokenize()
// ---------------------------------------------------------------------------

describe("tokenize()", () => {
  it("lowercases input", () => {
    expect(tokenize("GMAIL")).toEqual(["gmail"]);
  });

  it("splits on non-alphanumeric delimiters", () => {
    const result = tokenize("hello-world_foo.bar");
    expect(result).toContain("hello");
    expect(result).toContain("world");
    expect(result).toContain("foo");
    expect(result).toContain("bar");
  });

  it("drops single-character tokens", () => {
    expect(tokenize("a b c hello")).not.toContain("b");
    expect(tokenize("a b c hello")).not.toContain("c");
    expect(tokenize("a b c hello")).toContain("hello");
  });

  it("drops stop words — 'send me an email' → ['send', 'email']", () => {
    const result = tokenize("send me an email");
    expect(result).toEqual(["send", "email"]);
  });

  it("drops stop words — 'please want need' → []", () => {
    expect(tokenize("please want need")).toEqual([]);
  });

  it("applies stemming — strips trailing 's' (users → user)", () => {
    const result = tokenize("users");
    expect(result).toEqual(["user"]);
  });

  it("applies stemming — strips trailing 'ing' (clicking → click)", () => {
    const result = tokenize("clicking");
    expect(result).toEqual(["click"]);
  });

  it("applies stemming — strips trailing 'ed' (buttons pressed → button press)", () => {
    const result = tokenize("buttons pressed");
    expect(result).toContain("button");
    expect(result).toContain("press");
  });

  it("stemming: 'users clicking buttons' → ['user', 'click', 'button']", () => {
    const result = tokenize("users clicking buttons");
    expect(result).toEqual(["user", "click", "button"]);
  });

  it("does not over-stem short tokens (≥3 chars required after strip)", () => {
    // "dos" → strip 's' → "do" which is 2 chars — should NOT strip
    // "is" → already a stop word, dropped
    // "ads" → strip 's' → "ad" (2 chars) → should NOT strip
    const result = tokenize("ads");
    expect(result).toEqual(["ads"]);
  });

  it("does not strip 's' from tokens that are already ≤3 chars (keep 'gas')", () => {
    // "gas" → strip 's' → "ga" (2 chars) — should NOT strip
    const result = tokenize("gas");
    expect(result).toEqual(["gas"]);
  });

  it("handles empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("handles a real-world trigger phrase", () => {
    const result = tokenize("email posthog users who clicked the button");
    // "email" → not a stop word, "s" stripped from "users" → "user"
    // "who", "the" are stop words
    // "clicked" → "click" (strip "ed": 5 chars → 3 chars, ≥3 ok)
    // "button" → no strip (doesn't end in s/ing/ed)... wait "buttons" would strip
    expect(result).toContain("email");
    expect(result).toContain("posthog");
    expect(result).toContain("user");
    expect(result).toContain("click");
    expect(result).toContain("button");
    expect(result).not.toContain("who");
    expect(result).not.toContain("the");
  });

  it("procedure name dot-split tokens are indexed", () => {
    const result = tokenize("gmail.send_email");
    expect(result).toContain("gmail");
    expect(result).toContain("send");
    expect(result).toContain("email");
  });
});
