/**
 * Auto-teach distiller — pure function over a captured trace.
 *
 * Phase 1 stub: emits a single-leaf draft that flat-mirrors the trace so
 * the loop end-to-end works. Phase 2 fills in dead-read elimination,
 * retry collapse, selector tiering, bind lifting, wait tuning, leaf
 * splitting, reuse detection, side-effect classification, fragility
 * scoring, and validation.
 *
 * Stable contract (callers can rely on it across phases):
 *   - input: AutoTeachTraceRecord[] for one run
 *   - output: { yaml, leaves, composite_name, validation_errors }
 *   - never mutates the input
 */
import * as YAML from "yaml";
import type {
  ActionStepDef,
  AutoTeachLeafSummary,
  AutoTeachTraceRecord,
  ProcedureDef,
  ProcedureFragility,
  SideEffectClass,
} from "@browserops/shared";
import { normalize, type IRStep } from "./distiller-ir.js";
import { collapseRetries } from "./stage-collapse.js";
import { removeDeadReads } from "./stage-dead-reads.js";

export interface DistillOptions {
  goal: string;
  /** Best-known procedure name from prior session iterations. */
  prior_best_name?: string;
}

export interface DistillResult {
  /** Multi-document YAML: composite first (when present), then leaves. */
  yaml: string;
  /** Per-leaf summary used by status. */
  leaves: AutoTeachLeafSummary[];
  /** Composite procedure name when leaves > 1; null otherwise. */
  composite_name: string | null;
  /** Non-fatal issues. Empty when the draft is fully validated. */
  validation_errors: string[];
}

const DEFAULT_DOMAIN_FALLBACK = "session";

export function distill(
  records: AutoTeachTraceRecord[],
  opts: DistillOptions,
): DistillResult {
  // Pipeline: normalize → collapse retries → drop dead reads → emit.
  // Phase 2b/c will add bind lifting, wait tuning, leaf splitting, and
  // selector tiering between dead-read elimination and emission.
  const ir0 = normalize(records);
  const ir1 = collapseRetries(ir0);
  const ir2 = removeDeadReads(ir1);

  const baseName = deriveName(opts.goal, ir2);
  const steps = emitSteps(ir2);

  if (steps.length === 0) {
    steps.push({
      id: "placeholder",
      action: "browser_navigate",
      with: { tab_id: "{{tab_id}}", url: "https://example.com" },
    });
  }

  const sideEffects = classifySideEffects(ir2);
  const fragility = scoreFragility(ir2);

  const draft: ProcedureDef = {
    schema_version: 1,
    name: baseName,
    description: opts.goal.slice(0, 200),
    kind: "leaf",
    domain: deriveDomain(ir2),
    steps,
    fragility,
    ...(sideEffects.length > 0 ? { side_effects: sideEffects } : {}),
  };

  const yaml = headerComment(opts.goal, ir0.length, ir2.length) + YAML.stringify(draft, { lineWidth: 0 });

  const leafSummary: AutoTeachLeafSummary = {
    name: baseName,
    draft_status: "draft",
    side_effects: sideEffects,
    fragility,
  };

  const validation_errors: string[] = [];
  if (ir2.length === 0) {
    validation_errors.push(
      "no browser_* calls in trace after normalization — distiller emitted a placeholder leaf",
    );
  }

  return {
    yaml,
    leaves: [leafSummary],
    composite_name: null,
    validation_errors,
  };
}

function emitSteps(ir: IRStep[]): ActionStepDef[] {
  const steps: ActionStepDef[] = [];
  for (let i = 0; i < ir.length; i++) {
    const s = ir[i] as IRStep;
    const params = stripTabId(s.params);
    const step: ActionStepDef = {
      id: `step_${String(i + 1).padStart(2, "0")}_${slugVerb(s.method)}`,
      action: s.method,
      with: { tab_id: "{{tab_id}}", ...params },
    };
    if (s.page_effect && hasObservableEffect(s.page_effect)) {
      step.expected_effect = { dom: { any: true } };
    }
    steps.push(step);
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Helpers shared across phases
// ---------------------------------------------------------------------------

function stripTabId(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === "tab_id") continue;
    out[k] = v;
  }
  return out;
}

function deriveName(goal: string, steps: IRStep[]): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 50);
  const safe = /^[a-z]/.test(slug) ? slug : "recorded";
  const domain = deriveDomain(steps);
  if (domain !== undefined) return `${domain}.${safe}`.slice(0, 80);
  return safe;
}

function deriveDomain(steps: IRStep[]): string | undefined {
  for (const s of steps) {
    if (s.method !== "browser_navigate") continue;
    const url = typeof s.params["url"] === "string" ? (s.params["url"] as string) : "";
    const host = hostnameFrom(url);
    if (host !== undefined) return hostToDomain(host);
  }
  for (const s of steps) {
    const after = s.page_effect?.url?.after;
    if (typeof after === "string") {
      const host = hostnameFrom(after);
      if (host !== undefined) return hostToDomain(host);
    }
  }
  return DEFAULT_DOMAIN_FALLBACK;
}

function hostnameFrom(url: string): string | undefined {
  if (url === "") return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostToDomain(host: string): string | undefined {
  const stripped = host.replace(/^www\./, "");
  const parts = stripped.split(".");
  let candidate: string | undefined = parts[parts.length - 2];
  if (candidate === undefined || candidate.length < 2) candidate = parts[0];
  if (candidate === undefined) return undefined;
  candidate = candidate.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!/^[a-z]/.test(candidate)) return undefined;
  return candidate.slice(0, 40);
}

function slugVerb(method: string): string {
  return method.replace(/^browser_/, "").slice(0, 30);
}

function hasObservableEffect(effect: NonNullable<IRStep["page_effect"]>): boolean {
  return (
    (effect.dom?.added ?? 0) > 0 ||
    (effect.dom?.removed ?? 0) > 0 ||
    (effect.dom?.attr_changes ?? 0) > 0 ||
    (effect.dom?.text_changes ?? 0) > 0 ||
    effect.url?.changed === true ||
    effect.focus?.changed === true
  );
}

const SEND_BUTTON_TEXT = /\b(send|submit|post|publish|tweet|share)\b/i;
const PAY_BUTTON_TEXT = /\b(pay|checkout|purchase|buy|charge)\b/i;
const DELETE_BUTTON_TEXT = /\b(delete|remove|trash|destroy)\b/i;
const CONFIRM_URL = /\/(confirm|success|thanks?|complete|sent|posted)\b/i;

function classifySideEffects(steps: IRStep[]): SideEffectClass[] {
  const classes = new Set<SideEffectClass>();
  for (const s of steps) {
    if (s.method === "browser_click_by_text") {
      const text = typeof s.params["text"] === "string" ? (s.params["text"] as string) : "";
      if (SEND_BUTTON_TEXT.test(text)) classes.add("send_message");
      if (PAY_BUTTON_TEXT.test(text)) classes.add("payment");
      if (DELETE_BUTTON_TEXT.test(text)) classes.add("delete");
    }
    if (s.method === "browser_navigate" || s.page_effect?.url?.changed) {
      const after = s.page_effect?.url?.after ?? "";
      if (typeof after === "string" && CONFIRM_URL.test(after)) {
        if ((s.page_effect?.network?.requests_started ?? 0) > 0) {
          classes.add("send_message");
        }
      }
    }
  }
  return [...classes];
}

function scoreFragility(steps: IRStep[]): ProcedureFragility {
  for (const s of steps) {
    if (s.method !== "browser_execute_js") continue;
    const code = typeof s.params["code"] === "string" ? (s.params["code"] as string) : "";
    if (/nth-child|::nth|@xpath|querySelectorAll/.test(code)) return "high";
    return "medium";
  }
  return "low";
}

function headerComment(goal: string, sourceCount: number, keptCount: number): string {
  const droppedNote =
    sourceCount > keptCount
      ? `# Records: ${sourceCount} browser_* calls; ${keptCount} kept after retry/dead-read collapse`
      : `# Records: ${sourceCount} browser_* calls in source trace`;
  return [
    `# Auto-teach draft`,
    `# Goal: ${goal.slice(0, 200)}`,
    droppedNote,
    `#`,
    `# DRAFT — replay through procedures_autoteach loop before saving.`,
    "",
  ].join("\n");
}
