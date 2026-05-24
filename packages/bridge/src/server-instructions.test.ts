import { describe, expect, it } from "vitest";
import type { FeatureName } from "@browserops/shared";
import { buildServerInstructions } from "./server-instructions.js";

const set = (...names: FeatureName[]) =>
  new Set<FeatureName>(names) as ReadonlySet<FeatureName>;

describe("buildServerInstructions — procedures gating", () => {
  it("includes the Procedure runtime section when procedures is enabled", () => {
    const out = buildServerInstructions(set("procedures"));
    expect(out).toContain("Procedures:");
    expect(out).toContain("procedures_search");
    expect(out).toContain("procedures_get");
    expect(out).toContain("procedures_save");
  });

  it("omits the Procedures section when procedures is disabled", () => {
    const out = buildServerInstructions(set());
    expect(out).not.toContain("Procedures:\n");
    expect(out).toContain("Procedures are opt-in");
    expect(out).toContain("browserops feature enable procedures");
  });

  it("references procedures_* in the skill callout only when enabled", () => {
    const on = buildServerInstructions(set("procedures"));
    expect(on).toContain("browser_* or procedures_* call");

    const off = buildServerInstructions(set());
    expect(off).not.toContain("browser_* or procedures_* call");
    expect(off).toContain("browser_* call");
  });

  it("uses procedures_search in the tool-invocation example only when enabled", () => {
    const on = buildServerInstructions(set("procedures"));
    expect(on).toMatch(/procedures_search needs \{"query":/);

    const off = buildServerInstructions(set());
    expect(off).not.toContain("procedures_search needs");
    expect(off).toMatch(/browser_quick_read\n? *needs/);
  });

  it("includes the procedure-brief example in orchestration only when enabled", () => {
    const on = buildServerInstructions(set("procedures"));
    // Match the unique orchestration-bullet phrasing — `the delegate / calls
    // procedures_get itself` only appears in this bullet, not in the
    // Procedure runtime section, so the test pinpoints the right block.
    expect(on).toMatch(/the delegate[\s\S]*?procedures_get/);
    expect(on).toContain("Run gmail.send_email on tab t_3");

    const off = buildServerInstructions(set());
    expect(off).not.toMatch(/the delegate[\s\S]*?procedures_get/);
    expect(off).not.toContain("Run gmail.send_email on tab t_3");
  });
});

describe("buildServerInstructions — lore gating", () => {
  it("emits a Cross-agent lore section when lore is enabled", () => {
    const out = buildServerInstructions(set("lore"));
    expect(out).toContain("Cross-agent lore:");
    expect(out).toContain("lore_save");
    expect(out).toContain("lore_search");
    expect(out).toContain("lore_get");
    expect(out).toContain("lore_delete");
  });

  it("omits any lore_* mention when lore is disabled", () => {
    const out = buildServerInstructions(set());
    expect(out).not.toContain("lore_save");
    expect(out).not.toContain("Cross-agent lore:");
  });
});

describe("buildServerInstructions — procedures resume gating", () => {
  it("describes procedures_resume + drift health when procedures is enabled", () => {
    const out = buildServerInstructions(set("procedures"));
    expect(out).toContain("Procedures:");
    expect(out).toContain("procedures_search");
    expect(out).toContain("procedures_execute");
    expect(out).toContain("procedures_resume");
    expect(out).toContain("browser_propose_locator");
    expect(out).toContain("meta.health");
  });
});

describe("buildServerInstructions — invariants", () => {
  it("always includes the autonomous-by-default rule and click ladder", () => {
    for (const features of [set(), set("procedures"), set("lore"), set("procedures", "lore")]) {
      const out = buildServerInstructions(features);
      expect(out).toContain("AUTONOMOUS BY DEFAULT");
      expect(out).toContain("Clicking (escalation ladder");
      expect(out).toContain("browser_click_at");
    }
  });

  it("returns a non-empty string for every feature combination", () => {
    for (const features of [set(), set("procedures"), set("lore"), set("procedures", "lore")]) {
      const out = buildServerInstructions(features);
      expect(out.length).toBeGreaterThan(500);
    }
  });

  it("disabled-feature build is shorter than fully-enabled build", () => {
    const minimal = buildServerInstructions(set());
    const full = buildServerInstructions(set("procedures", "lore"));
    expect(full.length).toBeGreaterThan(minimal.length);
  });
});
