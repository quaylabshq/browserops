/**
 * Capability A — schema & validation (+ redaction).
 * Phase 1 ships the proof case (A1); Phase 2 fills in A2/A3.
 */
import { validateMemory, type MemoryRecord } from "@browserops/shared";
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
