/**
 * YAML-level merge of accumulated drift health back into a playbook
 * document. Keeps existing meta.* fields intact and merges per-step
 * health entries (any step not present in `incoming` keeps its prior
 * entry).
 *
 * Pure: takes YAML text + new PlaybookHealthDef → returns new YAML text.
 * The executor (Substep 3.7c) calls this with the playbook's on-disk
 * text and the run's accumulated health, then atomic-writes the result.
 *
 * Implementation note: we round-trip through JS (parse → mutate →
 * stringify) rather than mutating the YAML.Document. That drops comments
 * and reformats whitespace, which is acceptable because `meta` is
 * bridge-managed — the validator's `additionalProperties: false` already
 * prevents authors from hand-editing it meaningfully.
 */
import YAML from "yaml";
import type { PlaybookHealthDef, PlaybookStepHealth } from "@browserops/shared";

interface YamlDocShape {
  meta?: {
    version?: number;
    created?: string;
    last_verified?: string;
    status?: string;
    health?: {
      updated: string;
      steps: Record<string, PlaybookStepHealth>;
    };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export function mergeHealthIntoPlaybookYaml(
  yamlText: string,
  incoming: PlaybookHealthDef,
): string {
  // Fast-path: no per-step updates → don't touch the file.
  if (Object.keys(incoming.steps).length === 0) return yamlText;

  const parsed = YAML.parse(yamlText) as YamlDocShape | null;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return yamlText;
  }

  // Build merged steps: existing entries first, then overlay incoming.
  const mergedSteps: Record<string, PlaybookStepHealth> = {};
  const existing = parsed.meta?.health?.steps;
  if (existing && typeof existing === "object") {
    for (const [k, v] of Object.entries(existing)) {
      mergedSteps[k] = v as PlaybookStepHealth;
    }
  }
  for (const [k, v] of Object.entries(incoming.steps)) {
    mergedSteps[k] = v;
  }

  const meta = parsed.meta ?? {};
  parsed.meta = {
    ...meta,
    version: typeof meta.version === "number" ? meta.version : 1,
    created: typeof meta.created === "string" ? meta.created : incoming.updated,
    health: {
      updated: incoming.updated,
      steps: mergedSteps,
    },
  };

  return YAML.stringify(parsed);
}
