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
  const records_clean = records.filter((r) => r.method.startsWith("browser_"));
  const baseName = deriveName(opts.goal, records_clean);

  // Phase 1: single-leaf, one step per browser_* call. Dead reads are not
  // dropped yet, retries are not collapsed, selectors are not tiered. The
  // tests for those live with their implementation in Phase 2.
  const steps: ActionStepDef[] = [];
  for (let i = 0; i < records_clean.length; i++) {
    const rec = records_clean[i] as AutoTeachTraceRecord;
    const params = stripTabId(rec.params);
    const step: ActionStepDef = {
      id: `step_${String(i + 1).padStart(2, "0")}_${slugVerb(rec.method)}`,
      action: rec.method,
      with: { tab_id: "{{tab_id}}", ...params },
    };
    if (rec.duration_ms > 0) {
      // Conservative wait_for: only set when the page_effect implies an
      // async settle — DOM mutation, URL change, or focus change.
      if (rec.page_effect && hasObservableEffect(rec.page_effect)) {
        step.expected_effect = { dom: { any: true } };
      }
    }
    steps.push(step);
  }

  if (steps.length === 0) {
    steps.push({
      id: "placeholder",
      action: "browser_navigate",
      with: { tab_id: "{{tab_id}}", url: "https://example.com" },
    });
  }

  const sideEffects = classifySideEffects(records_clean);
  const fragility = scoreFragility(records_clean);

  const draft: ProcedureDef = {
    schema_version: 1,
    name: baseName,
    description: opts.goal.slice(0, 200),
    kind: "leaf",
    domain: deriveDomain(records_clean),
    steps,
    fragility,
    ...(sideEffects.length > 0 ? { side_effects: sideEffects } : {}),
  };

  const yaml = headerComment(opts.goal, records_clean.length) + YAML.stringify(draft, { lineWidth: 0 });

  const leafSummary: AutoTeachLeafSummary = {
    name: baseName,
    draft_status: "draft",
    side_effects: sideEffects,
    fragility,
  };

  const validation_errors: string[] = [];
  if (records_clean.length === 0) {
    validation_errors.push(
      "no browser_* calls in trace — distiller emitted a placeholder leaf",
    );
  }

  return {
    yaml,
    leaves: [leafSummary],
    composite_name: null,
    validation_errors,
  };
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

function deriveName(goal: string, records: AutoTeachTraceRecord[]): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 50);
  const safe = /^[a-z]/.test(slug) ? slug : "recorded";
  const domain = deriveDomain(records);
  if (domain !== undefined) return `${domain}.${safe}`.slice(0, 80);
  return safe;
}

function deriveDomain(records: AutoTeachTraceRecord[]): string | undefined {
  for (const rec of records) {
    if (rec.method !== "browser_navigate") continue;
    const url = typeof rec.params["url"] === "string" ? (rec.params["url"] as string) : "";
    const host = hostnameFrom(url);
    if (host !== undefined) return hostToDomain(host);
  }
  // Fall back to URL change in any page_effect snapshot.
  for (const rec of records) {
    const after = rec.page_effect?.url?.after;
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

function hasObservableEffect(effect: NonNullable<AutoTeachTraceRecord["page_effect"]>): boolean {
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

function classifySideEffects(
  records: AutoTeachTraceRecord[],
): SideEffectClass[] {
  const classes = new Set<SideEffectClass>();
  for (const rec of records) {
    if (rec.method === "browser_click_by_text") {
      const text = typeof rec.params["text"] === "string" ? (rec.params["text"] as string) : "";
      if (SEND_BUTTON_TEXT.test(text)) classes.add("send_message");
      if (PAY_BUTTON_TEXT.test(text)) classes.add("payment");
      if (DELETE_BUTTON_TEXT.test(text)) classes.add("delete");
    }
    if (rec.method === "browser_navigate" || rec.page_effect?.url?.changed) {
      const after = rec.page_effect?.url?.after ?? "";
      if (typeof after === "string" && CONFIRM_URL.test(after)) {
        // Confirmation URL alone is weak signal — only mark when paired with
        // a network burst (i.e. an actual POST happened).
        if ((rec.page_effect?.network?.requests_started ?? 0) > 0) {
          classes.add("send_message");
        }
      }
    }
  }
  return [...classes];
}

function scoreFragility(records: AutoTeachTraceRecord[]): ProcedureFragility {
  // Phase 1 heuristic: if any click/type uses raw selectors via execute_js,
  // call it medium. xpath / nth-child specifically aren't observable yet
  // (Phase 2 brings selector tiering); for now, default to medium when
  // the trace contains any execute_js click and low otherwise.
  for (const rec of records) {
    if (rec.method !== "browser_execute_js") continue;
    const code = typeof rec.params["code"] === "string" ? (rec.params["code"] as string) : "";
    if (/nth-child|::nth|@xpath|querySelectorAll/.test(code)) return "high";
    return "medium";
  }
  return "low";
}

function headerComment(goal: string, recordCount: number): string {
  return [
    `# Auto-teach draft`,
    `# Goal: ${goal.slice(0, 200)}`,
    `# Records: ${recordCount} browser_* calls in source trace`,
    `#`,
    `# DRAFT — replay through procedures_autoteach loop before saving.`,
    "",
  ].join("\n");
}
