import { describe, it, expect } from "vitest";
import YAML from "yaml";
import { mergeHealthIntoProcedureYaml } from "./health-merge.js";
import type { HealthDef } from "@browserops/shared";

const baseYaml = `schema_version: 1
name: demo.minimal
description: Minimal leaf procedure.
kind: leaf
steps:
  - id: s1
    do: navigate
    with:
      url: https://example.com
`;

const healthFromOneRun: HealthDef = {
  updated: "2026-05-24T00:00:00Z",
  steps: {
    s1: {
      runs: 1,
      relocates: 0,
      ambiguous_resolves: 0,
      target_changed: 0,
      avg_match_count: 1,
      last_tier: 1,
      last_ref: 12,
    },
  },
};

describe("mergeHealthIntoProcedureYaml", () => {
  it("inserts a new meta.health block when meta is absent", () => {
    const out = mergeHealthIntoProcedureYaml(baseYaml, healthFromOneRun);
    const parsed = YAML.parse(out);
    expect(parsed.meta).toBeDefined();
    expect(parsed.meta.health).toEqual(healthFromOneRun);
    expect(parsed.meta.version).toBe(1);
    expect(typeof parsed.meta.created).toBe("string");
  });

  it("preserves existing meta fields when merging health", () => {
    const yamlWithMeta = `${baseYaml}meta:
  version: 1
  created: "2026-04-01T00:00:00Z"
  last_verified: "2026-04-02T00:00:00Z"
  status: trusted
`;
    const out = mergeHealthIntoProcedureYaml(yamlWithMeta, healthFromOneRun);
    const parsed = YAML.parse(out);
    expect(parsed.meta.created).toBe("2026-04-01T00:00:00Z");
    expect(parsed.meta.last_verified).toBe("2026-04-02T00:00:00Z");
    expect(parsed.meta.status).toBe("trusted");
    expect(parsed.meta.health).toEqual(healthFromOneRun);
  });

  it("overwrites prior health with the merged accumulator (the recorder folds in-flight)", () => {
    const yamlWithHealth = `${baseYaml}meta:
  version: 1
  created: "2026-04-01T00:00:00Z"
  health:
    updated: "2026-04-01T00:00:00Z"
    steps:
      s1:
        runs: 5
        relocates: 0
        ambiguous_resolves: 0
        target_changed: 0
        avg_match_count: 1
        last_tier: 1
        last_ref: 12
`;
    const newHealth: HealthDef = {
      updated: "2026-05-24T00:00:00Z",
      steps: {
        s1: {
          runs: 7,
          relocates: 1,
          ambiguous_resolves: 0,
          target_changed: 0,
          avg_match_count: 1.2,
          last_tier: 2,
          last_ref: 13,
        },
      },
    };
    const out = mergeHealthIntoProcedureYaml(yamlWithHealth, newHealth);
    const parsed = YAML.parse(out);
    expect(parsed.meta.health).toEqual(newHealth);
  });

  it("preserves all step entries (does not drop steps not present in the new health)", () => {
    const yamlMulti = `${baseYaml}meta:
  version: 1
  created: "2026-04-01T00:00:00Z"
  health:
    updated: "2026-04-01T00:00:00Z"
    steps:
      s1:
        runs: 5
        relocates: 0
        ambiguous_resolves: 0
        target_changed: 0
      s2:
        runs: 3
        relocates: 0
        ambiguous_resolves: 0
        target_changed: 0
`;
    const newHealth: HealthDef = {
      updated: "2026-05-24T00:00:00Z",
      steps: {
        s1: {
          runs: 6,
          relocates: 0,
          ambiguous_resolves: 0,
          target_changed: 0,
        },
        // s2 not updated in this run
      },
    };
    const out = mergeHealthIntoProcedureYaml(yamlMulti, newHealth);
    const parsed = YAML.parse(out);
    expect(parsed.meta.health.steps.s1.runs).toBe(6);
    expect(parsed.meta.health.steps.s2.runs).toBe(3); // preserved
  });

  it("is a no-op when the new health has zero step updates", () => {
    const out = mergeHealthIntoProcedureYaml(baseYaml, {
      updated: "2026-05-24T00:00:00Z",
      steps: {},
    });
    expect(out).toBe(baseYaml);
  });
});
