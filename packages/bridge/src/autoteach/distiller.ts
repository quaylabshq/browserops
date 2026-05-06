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
  InputFieldDef,
  ProcedureDef,
  ProcedureFragility,
  SideEffectClass,
} from "@browserops/shared";
import { normalize, type IRStep, type IRLeaf } from "./distiller-ir.js";
import { collapseRetries } from "./stage-collapse.js";
import { removeDeadReads } from "./stage-dead-reads.js";
import { liftBinds } from "./stage-binds.js";
import { tuneWaits } from "./stage-waits.js";
import { splitLeaves } from "./stage-leaves.js";

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
  // Pipeline: normalize → collapse retries → drop dead reads →
  //           lift binds → tune waits → split into leaves → emit.
  const ir0 = normalize(records);
  const ir1 = collapseRetries(ir0);
  const ir2 = removeDeadReads(ir1);
  const lifted = liftBinds(ir2);
  const ir3 = tuneWaits(lifted.steps);
  const leaves = splitLeaves(ir3);

  const baseName = deriveName(opts.goal, ir3);
  const domain = deriveDomain(ir3);
  const description = opts.goal.slice(0, 200);

  const validation_errors: string[] = [];
  if (ir3.length === 0) {
    validation_errors.push(
      "no browser_* calls in trace after normalization — distiller emitted a placeholder leaf",
    );
    return {
      yaml: headerComment(opts.goal, ir0.length, 0) + YAML.stringify(placeholderLeaf(baseName, description, domain), { lineWidth: 0 }),
      leaves: [{ name: baseName, draft_status: "draft", side_effects: [], fragility: "low" }],
      composite_name: null,
      validation_errors,
    };
  }

  // Single leaf — emit just the leaf, no composite.
  if (leaves.length === 1) {
    const leaf = leaves[0] as IRLeaf;
    const draft = buildLeafProc({
      name: baseName,
      description,
      domain,
      leaf,
      allInputs: lifted.inputs,
    });
    return {
      yaml: headerComment(opts.goal, ir0.length, ir3.length) + YAML.stringify(draft.proc, { lineWidth: 0 }),
      leaves: [draft.summary],
      composite_name: null,
      validation_errors: draft.validation_errors,
    };
  }

  // Multi-leaf — emit each leaf, then a composite that uses() them.
  const leafProcs: Array<{ proc: ProcedureDef; summary: AutoTeachLeafSummary }> = [];
  const allErrors: string[] = [...validation_errors];
  leaves.forEach((leaf, idx) => {
    const leafName = leafNameFor(baseName, leaf, idx);
    const draft = buildLeafProc({
      name: leafName,
      description: leafDescriptionFor(leaf, description, idx, leaves.length),
      domain,
      leaf,
      allInputs: lifted.inputs,
    });
    leafProcs.push({ proc: draft.proc, summary: draft.summary });
    allErrors.push(...draft.validation_errors);
  });

  const compositeProc = buildCompositeProc({
    name: baseName,
    description,
    domain,
    leafProcs: leafProcs.map((lp) => lp.proc),
    allInputs: lifted.inputs,
  });

  const docs = [
    ...leafProcs.map((lp) => YAML.stringify(lp.proc, { lineWidth: 0 })),
    YAML.stringify(compositeProc, { lineWidth: 0 }),
  ];
  const yaml =
    headerComment(opts.goal, ir0.length, ir3.length) +
    docs.join("---\n");

  return {
    yaml,
    leaves: leafProcs.map((lp) => lp.summary),
    composite_name: baseName,
    validation_errors: allErrors,
  };
}

interface BuildLeafArgs {
  name: string;
  description: string;
  domain: string | undefined;
  leaf: IRLeaf;
  /** Session-wide input plan from liftBinds. We project to inputs this leaf actually references. */
  allInputs: Record<string, InputFieldDef>;
}

function buildLeafProc(args: BuildLeafArgs): {
  proc: ProcedureDef;
  summary: AutoTeachLeafSummary;
  validation_errors: string[];
} {
  const steps = emitSteps(args.leaf.steps);
  const sideEffects = classifySideEffects(args.leaf.steps);
  const fragility = scoreFragility(args.leaf.steps);
  const usedInputs = projectInputsForSteps(args.leaf.steps, args.allInputs);
  const proc: ProcedureDef = {
    schema_version: 1,
    name: args.name,
    description: args.description,
    kind: "leaf",
    ...(args.domain !== undefined ? { domain: args.domain } : {}),
    ...(Object.keys(usedInputs).length > 0 ? { inputs: usedInputs } : {}),
    steps,
    fragility,
    ...(sideEffects.length > 0 ? { side_effects: sideEffects } : {}),
  };
  const validation_errors: string[] = [];
  // Each leaf must have at least one expected_effect or success_criteria.
  const hasEffect = steps.some(
    (s) => (s as ActionStepDef).expected_effect !== undefined,
  );
  if (!hasEffect) {
    validation_errors.push(
      `${args.name}: no step declares expected_effect — leaf has no observable post-condition`,
    );
  }
  return {
    proc,
    summary: {
      name: args.name,
      draft_status: "draft",
      side_effects: sideEffects,
      fragility,
    },
    validation_errors,
  };
}

interface BuildCompositeArgs {
  name: string;
  description: string;
  domain: string | undefined;
  leafProcs: ProcedureDef[];
  allInputs: Record<string, InputFieldDef>;
}

function buildCompositeProc(args: BuildCompositeArgs): ProcedureDef {
  const compositeInputs: Record<string, InputFieldDef> = {};
  for (const lp of args.leafProcs) {
    for (const [k, v] of Object.entries(lp.inputs ?? {})) {
      compositeInputs[k] = v;
    }
  }
  const steps: ActionStepDef[] = args.leafProcs.map((lp, idx) => {
    const withParams: Record<string, unknown> = { tab_id: "{{tab_id}}" };
    for (const inputName of Object.keys(lp.inputs ?? {})) {
      withParams[inputName] = `{{input.${inputName}}}`;
    }
    return {
      id: `step_${String(idx + 1).padStart(2, "0")}_${slugForId(lp.name)}`,
      action: lp.name,
      with: withParams,
    };
  });
  const sideEffects = uniqueSideEffects(args.leafProcs);
  const fragility = worstFragility(args.leafProcs);
  return {
    schema_version: 1,
    name: args.name,
    description: args.description,
    kind: "composite",
    ...(args.domain !== undefined ? { domain: args.domain } : {}),
    ...(Object.keys(compositeInputs).length > 0 ? { inputs: compositeInputs } : {}),
    uses: args.leafProcs.map((lp) => lp.name),
    steps,
    fragility,
    ...(sideEffects.length > 0 ? { side_effects: sideEffects } : {}),
  };
}

function uniqueSideEffects(procs: ProcedureDef[]): SideEffectClass[] {
  const set = new Set<SideEffectClass>();
  for (const p of procs) {
    for (const se of p.side_effects ?? []) set.add(se);
  }
  return [...set];
}

function worstFragility(procs: ProcedureDef[]): ProcedureFragility {
  const order: ProcedureFragility[] = ["low", "medium", "high"];
  let worst = 0;
  for (const p of procs) {
    const f = p.fragility ?? "low";
    const idx = order.indexOf(f);
    if (idx > worst) worst = idx;
  }
  return order[worst] ?? "low";
}

function projectInputsForSteps(
  steps: IRStep[],
  allInputs: Record<string, InputFieldDef>,
): Record<string, InputFieldDef> {
  const used = new Set<string>();
  for (const s of steps) {
    for (const v of Object.values(s.params)) {
      if (typeof v !== "string") continue;
      const m = v.match(/{{input\.([a-z][a-z0-9_]*)}}/);
      if (m && m[1]) used.add(m[1]);
    }
  }
  const out: Record<string, InputFieldDef> = {};
  for (const k of used) {
    const def = allInputs[k];
    if (def !== undefined) out[k] = def;
  }
  return out;
}

function leafNameFor(baseName: string, leaf: IRLeaf, idx: number): string {
  const reasonSlug = leaf.reason === "first" ? "open" : leaf.reason;
  // Use first step's verb when more discriminating than the reason alone.
  const firstStep = leaf.steps[0];
  const verbHint =
    firstStep !== undefined ? slugVerb(firstStep.method).slice(0, 16) : null;
  const slug =
    verbHint !== null
      ? `${reasonSlug}_${verbHint}_${idx + 1}`
      : `${reasonSlug}_${idx + 1}`;
  const sep = baseName.includes(".") ? "__" : "_";
  return `${baseName}${sep}${slug}`.slice(0, 80);
}

function leafDescriptionFor(
  leaf: IRLeaf,
  fallback: string,
  idx: number,
  total: number,
): string {
  const firstStep = leaf.steps[0];
  const hint =
    firstStep?.method === "browser_navigate" &&
    typeof firstStep.params["url"] === "string"
      ? ` (visits ${firstStep.params["url"]})`
      : "";
  return `${fallback} — leaf ${idx + 1}/${total}${hint}`.slice(0, 200);
}

function placeholderLeaf(
  baseName: string,
  description: string,
  domain: string | undefined,
): ProcedureDef {
  return {
    schema_version: 1,
    name: baseName,
    description,
    kind: "leaf",
    ...(domain !== undefined ? { domain } : {}),
    steps: [
      {
        id: "placeholder",
        action: "browser_navigate",
        with: { tab_id: "{{tab_id}}", url: "https://example.com" },
      },
    ],
    fragility: "low",
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

function slugForId(s: string): string {
  return s.replace(/[^a-z0-9]+/g, "_").slice(0, 30);
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
