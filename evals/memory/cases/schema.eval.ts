/**
 * Capability A — schema & validation (+ redaction).
 * Phase 1 ships the proof case (A1); Phase 2 fills in A2/A3.
 */
import { validateMemory, type MemoryRecord } from "@browserops/shared";
import { checkRedaction } from "../../../packages/bridge/src/memory/store.js";
import { check, defineEval } from "../harness.js";

defineEval({
  id: "A1",
  capability: "schema",
  title: "a well-formed site blocker validates",
  run() {
    const rec: MemoryRecord = {
      schema_version: 1,
      name: "www-notion-so.blocker.consent-modal",
      scope: "site",
      kind: "blocker",
      title: "consent modal intercepts clicks until dismissed",
      origin: "https://www.notion.so",
      severity: "high",
      detail: {
        wall: "all clicks no-op until the cookie consent modal is dismissed",
        door: "press Escape, or click [data-testid=consent-accept], before interacting",
      },
    };
    const errors = validateMemory(rec);
    check(
      errors.length === 0,
      `expected no validation errors, got: ${JSON.stringify(errors)}`,
    );
  },
});

defineEval({
  id: "A2",
  capability: "schema",
  title: "site-without-origin, blocker-without-door, selector-without-locator are REJECTED",
  run() {
    // site scope without origin
    const siteNoOrigin: MemoryRecord = {
      schema_version: 1,
      name: "global-lesson-test",
      scope: "site",
      kind: "lesson",
      title: "site record with no origin",
      detail: { note: "test note" },
    };
    const errs1 = validateMemory(siteNoOrigin);
    check(
      errs1.some((e) => e.field === "origin"),
      `expected origin error for site-without-origin, got: ${JSON.stringify(errs1)}`,
    );

    // blocker without door
    const blockerNoDoor: MemoryRecord = {
      schema_version: 1,
      name: "example-com.blocker.no-door",
      scope: "site",
      kind: "blocker",
      title: "a blocker with no door",
      origin: "https://example.com",
      detail: { wall: "something is blocking" /* door missing */ },
    };
    const errs2 = validateMemory(blockerNoDoor);
    check(
      errs2.some((e) => e.field === "detail.door"),
      `expected detail.door error for blocker-without-door, got: ${JSON.stringify(errs2)}`,
    );

    // selector without locator
    const selectorNoLocator: MemoryRecord = {
      schema_version: 1,
      name: "example-com.selector.no-locator",
      scope: "site",
      kind: "selector",
      title: "a selector with no locator",
      origin: "https://example.com",
      detail: { /* locator missing */ },
    };
    const errs3 = validateMemory(selectorNoLocator);
    check(
      errs3.some((e) => e.field === "detail.locator"),
      `expected detail.locator error for selector-without-locator, got: ${JSON.stringify(errs3)}`,
    );
  },
});

defineEval({
  id: "A3",
  capability: "schema",
  title: "checkRedaction rejects email / ≥7-digit runs / secret strings; passes a clean record",
  run() {
    // Clean record — should pass
    const clean: MemoryRecord = {
      schema_version: 1,
      name: "example-com.blocker.consent",
      scope: "site",
      kind: "blocker",
      title: "consent modal blocks interaction",
      origin: "https://example.com",
      detail: {
        wall: "modal blocks all clicks",
        door: "click accept button to dismiss",
      },
    };
    const cleanResult = checkRedaction(clean);
    check(cleanResult === null, `clean record should pass redaction, got: ${cleanResult}`);

    // Email in detail.wall
    const withEmail: MemoryRecord = {
      ...clean,
      name: "example-com.blocker.email-in-wall",
      detail: {
        wall: "send to user@example.com to resolve",
        door: "click accept button",
      },
    };
    const emailResult = checkRedaction(withEmail);
    check(emailResult !== null, "record with email in detail should be rejected");
    check(
      emailResult!.includes("email"),
      `rejection message should mention email, got: ${emailResult}`,
    );

    // Long digit run (≥7 digits) in detail
    const withLongDigits: MemoryRecord = {
      ...clean,
      name: "example-com.blocker.digits-in-wall",
      detail: {
        wall: "phone number 1234567890 is required",
        door: "click accept button",
      },
    };
    const digitsResult = checkRedaction(withLongDigits);
    check(digitsResult !== null, "record with long digit run should be rejected");
    check(
      digitsResult!.includes("digit"),
      `rejection message should mention digit, got: ${digitsResult}`,
    );

    // Secret-ish string (bearer token)
    const withSecret: MemoryRecord = {
      ...clean,
      name: "example-com.blocker.token-in-door",
      detail: {
        wall: "auth required",
        door: "use Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9token to authenticate",
      },
    };
    const secretResult = checkRedaction(withSecret);
    check(secretResult !== null, "record with secret token should be rejected");
    check(
      secretResult!.includes("secret") || secretResult!.includes("token") || secretResult!.includes("credential"),
      `rejection message should mention secret/token/credential, got: ${secretResult}`,
    );
  },
});
