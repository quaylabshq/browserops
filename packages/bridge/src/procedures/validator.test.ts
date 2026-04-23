import { describe, expect, it } from "vitest";
import { validateProcedure } from "./validator.js";

// ---------------------------------------------------------------------------
// Canonical §5 example (leaf) — same object proven valid in procedures.test.ts
// ---------------------------------------------------------------------------

const EXAMPLE_LEAF = {
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
};

// ---------------------------------------------------------------------------
// Valid cases
// ---------------------------------------------------------------------------

describe("validateProcedure — valid", () => {
  it("accepts the §5 canonical leaf example", () => {
    const result = validateProcedure(EXAMPLE_LEAF);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("accepts a minimal leaf (only required fields)", () => {
    const result = validateProcedure({
      schema_version: 1,
      name: "my.proc",
      description: "A minimal procedure",
      kind: "leaf",
      steps: [{ id: "s1", action: "browser_click", with: { ref: 1 } }],
    });
    expect(result.valid).toBe(true);
  });

  it("accepts a composite with uses", () => {
    const result = validateProcedure({
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
          do: [{ action: "gmail.send_email", with: { to: "{{user.email}}" } }],
        },
      ],
    });
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shape violations
// ---------------------------------------------------------------------------

describe("validateProcedure — shape violations", () => {
  it("rejects missing required field: description", () => {
    const result = validateProcedure({
      schema_version: 1,
      name: "my.proc",
      // description: intentionally omitted
      kind: "leaf",
      steps: [{ id: "s1", action: "browser_click" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("rejects invalid kind value", () => {
    const result = validateProcedure({
      schema_version: 1,
      name: "my.proc",
      description: "A procedure",
      kind: "script", // invalid
      steps: [{ id: "s1", action: "browser_click" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("rejects name that violates the regex (uppercase)", () => {
    const result = validateProcedure({
      schema_version: 1,
      name: "Gmail.SendEmail", // uppercase — violates ^[a-z][a-z0-9_.-]{0,79}$
      description: "A procedure",
      kind: "leaf",
      steps: [{ id: "s1", action: "browser_click" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("rejects composite without uses", () => {
    const result = validateProcedure({
      schema_version: 1,
      name: "bad.composite",
      description: "A composite missing uses",
      kind: "composite",
      // uses: intentionally omitted
      steps: [{ id: "s1", action: "sub.proc" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("errors array entries are human-readable strings", () => {
    const result = validateProcedure({
      schema_version: 1,
      name: "BadName", // violates pattern
      description: "x".repeat(201), // exceeds maxLength
      kind: "leaf",
      steps: [], // violates minItems
    });
    expect(result.valid).toBe(false);
    for (const e of result.errors!) {
      expect(typeof e).toBe("string");
      expect(e.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Error count cap (≤10)
// ---------------------------------------------------------------------------

describe("validateProcedure — error count cap", () => {
  it("returns at most 10 errors even when many violations exist", () => {
    // Construct an object with many simultaneous violations:
    // - missing all required fields (name, description, kind, steps → 4 errors)
    // - steps is empty (minItems violation)
    // - lots of unknown additional properties on a schema with additionalProperties:false
    //   → each unknown key fires a separate error
    const manyViolations: Record<string, unknown> = {
      // schema_version omitted → missing required
      // name omitted → missing required
      // description omitted → missing required
      // kind omitted → missing required
      // steps omitted → missing required
      // Add many unknown extra properties to fire additionalProperties errors
      extra1: 1,
      extra2: 2,
      extra3: 3,
      extra4: 4,
      extra5: 5,
      extra6: 6,
      extra7: 7,
      extra8: 8,
      extra9: 9,
      extra10: 10,
      extra11: 11,
      extra12: 12,
    };

    const result = validateProcedure(manyViolations);
    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBeLessThanOrEqual(10);
    expect(result.errors!.length).toBeGreaterThan(0);
  });
});
