/**
 * Distiller stage: lift literal values to procedure inputs.
 *
 * Walks every IRStep with a typed-in value or a navigation URL and
 * surfaces it as a procedure input. The step's params get rewritten to
 * `{{input.<name>}}` references so the procedure is parameterised
 * rather than hardcoded.
 *
 * Heuristics for naming:
 *   - browser_type with value matching the email regex → `to` (or
 *     `email` if `to`/`recipient` already taken)
 *   - browser_type with value matching a URL → `url`
 *   - browser_type otherwise → snake-cased label of the target if
 *     available, else `value` (with a numeric suffix for collisions)
 *   - browser_navigate URL → `start_url` (only when not already set as
 *     a precondition fallback in a future stage)
 *
 * Input metadata:
 *   - destructive=true when the step's method is on a side-effect
 *     surface (browser_click_by_text against Send/Pay/etc)
 *   - description includes the source step + label hint
 */
import type { InputFieldDef } from "@browserops/shared";
import type { IRStep } from "./distiller-ir.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;

const SEND_LIKE = /\b(send|submit|post|publish|tweet|share|pay|delete)\b/i;

export interface LiftBindsResult {
  steps: IRStep[];
  inputs: Record<string, InputFieldDef>;
}

export function liftBinds(steps: IRStep[]): LiftBindsResult {
  const inputs: Record<string, InputFieldDef> = {};
  const used = new Set<string>();

  function reserve(base: string): string {
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let n = 2;
    while (used.has(`${base}_${n}`)) n++;
    const name = `${base}_${n}`;
    used.add(name);
    return name;
  }

  // Two-pass: first collect side-effect targets so type values feeding
  // them get marked destructive when lifted.
  const destructiveStepIdx = new Set<number>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] as IRStep;
    if (s.method !== "browser_click_by_text") continue;
    const text = typeof s.params["text"] === "string" ? (s.params["text"] as string) : "";
    if (SEND_LIKE.test(text)) destructiveStepIdx.add(i);
  }

  const out: IRStep[] = steps.map((s) => ({ ...s, params: { ...s.params } }));

  for (let i = 0; i < out.length; i++) {
    const s = out[i] as IRStep;
    if (s.method === "browser_type") {
      const value = s.params["value"];
      if (typeof value !== "string" || value === "") continue;
      const targetLabel = pickLabel(s.params);
      const baseName = pickTypeName(value, targetLabel);
      const name = reserve(baseName);
      const isDestructive = followsTo(out, i, destructiveStepIdx);
      inputs[name] = {
        type: "string",
        required: true,
        ...(isDestructive ? { destructive: true } : {}),
        description: describeInput(value, targetLabel),
      };
      s.params["value"] = `{{input.${name}}}`;
      continue;
    }
    if (s.method === "browser_navigate") {
      const url = s.params["url"];
      if (typeof url !== "string" || url === "") continue;
      // Only lift if the URL changes between runs is plausible — heuristic:
      // any URL with a path beyond `/` (e.g. /search?q=...) is more likely
      // to be parameterised. Bare hostnames probably stay constant.
      if (!hasInterestingPath(url)) continue;
      const name = reserve("start_url");
      inputs[name] = {
        type: "string",
        required: true,
        description: `Navigation URL — ${url}`,
      };
      s.params["url"] = `{{input.${name}}}`;
      continue;
    }
    if (s.method === "browser_click_by_text") {
      // Don't lift the text by default — it's a stable button label, not
      // a free-form input. Lifting Send/Submit etc would break replay.
      continue;
    }
  }

  return { steps: out, inputs };
}

function pickTypeName(value: string, label: string | undefined): string {
  if (EMAIL_RE.test(value)) {
    if (label !== undefined) {
      const lower = label.toLowerCase();
      if (/(to|recipient|toaddress)/.test(lower)) return "to";
      if (/(from|sender)/.test(lower)) return "from";
      if (/(cc)/.test(lower)) return "cc";
      if (/(bcc)/.test(lower)) return "bcc";
    }
    return "email";
  }
  if (URL_RE.test(value)) return "url";
  if (label !== undefined) {
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 24);
    if (slug.length > 0 && /^[a-z]/.test(slug)) return slug;
  }
  return "value";
}

function pickLabel(params: Record<string, unknown>): string | undefined {
  for (const k of ["label", "name", "field", "placeholder"]) {
    const v = params[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function describeInput(value: string, label: string | undefined): string {
  if (EMAIL_RE.test(value)) {
    return label !== undefined ? `Email — ${label}` : "Email address";
  }
  if (URL_RE.test(value)) return "URL value";
  return label !== undefined ? `Text — ${label}` : "Free-text input";
}

function hasInterestingPath(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.length > 1 || u.search.length > 0;
  } catch {
    return false;
  }
}

function followsTo(
  steps: IRStep[],
  fromIdx: number,
  destructiveStepIdx: Set<number>,
): boolean {
  // Type events that feed a destructive click within ~30s after typing
  // are themselves destructive inputs (the value is the payload).
  const HORIZON_MS = 30_000;
  const fromTs = (steps[fromIdx] as IRStep).ts;
  for (let j = fromIdx + 1; j < steps.length; j++) {
    if ((steps[j] as IRStep).ts - fromTs > HORIZON_MS) break;
    if (destructiveStepIdx.has(j)) return true;
  }
  return false;
}
