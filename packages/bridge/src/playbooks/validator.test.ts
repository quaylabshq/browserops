import { describe, expect, it } from "vitest";
import { validatePlaybook } from "./validator.js";

const baseLeaf = {
  schema_version: 1,
  name: "demo.leaf",
  description: "Demo leaf playbook.",
  kind: "leaf",
  steps: [{ id: "s1", do: "navigate", with: { url: "https://example.com" } }],
};

describe("validatePlaybook", () => {
  it("accepts a minimal valid leaf", () => {
    const r = validatePlaybook(baseLeaf);
    expect(r.valid).toBe(true);
    expect(r.errors).toBeUndefined();
  });

  it("rejects missing name", () => {
    const r = validatePlaybook({ ...baseLeaf, name: undefined });
    expect(r.valid).toBe(false);
    expect(r.errors?.[0]).toMatch(/required/);
  });

  it("rejects bad name pattern", () => {
    const r = validatePlaybook({ ...baseLeaf, name: "BAD_Name" });
    expect(r.valid).toBe(false);
    expect(r.errors?.[0]).toMatch(/pattern/);
  });

  it("rejects unknown step action", () => {
    const r = validatePlaybook({
      ...baseLeaf,
      steps: [{ id: "s1", do: "fly" }],
    });
    expect(r.valid).toBe(false);
  });

  it("requires uses on composite kind", () => {
    const r = validatePlaybook({
      schema_version: 1,
      name: "comp.x",
      description: "x",
      kind: "composite",
      steps: [{ id: "s1", do: "navigate", with: { url: "x" } }],
    });
    expect(r.valid).toBe(false);
    expect(r.errors?.join(" ")).toMatch(/uses/);
  });

  it("caps error count", () => {
    const baddSteps = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      do: "no-such-action",
    }));
    const r = validatePlaybook({ ...baseLeaf, steps: baddSteps });
    expect(r.valid).toBe(false);
    expect((r.errors ?? []).length).toBeLessThanOrEqual(10);
  });

  it("rejects extra top-level fields", () => {
    const r = validatePlaybook({ ...baseLeaf, what_is_this: 1 });
    expect(r.valid).toBe(false);
  });
});
