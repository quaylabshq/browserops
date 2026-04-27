/**
 * Distill a recorded teach session into draft procedure YAML(s).
 *
 * Behaviour:
 *   - Splits the timeline into one or more leaves on hard/soft boundaries
 *     (user markers, tab change, URL host change, idle gap > 4s, form
 *     submit). When the result is a single leaf, no composite is emitted.
 *     Otherwise an extra composite procedure is emitted that uses each
 *     leaf in order.
 *   - Infers procedure inputs from typed values: redacted typing always
 *     becomes a required input; non-redacted typing that matches an
 *     email or URL pattern is auto-parameterised; everything else is
 *     surfaced as a parameter_candidate the agent can choose to lift.
 *   - Step mapping: navigate → browser_navigate, click →
 *     browser_click_by_text or browser_execute_js, type →
 *     browser_execute_js with a unified <input>/contenteditable handler,
 *     key → browser_press with Meta/Control normalised to Primary.
 *
 * Output is always a DRAFT — replay before calling procedures_save.
 */

import * as YAML from "yaml";
import type {
  TeachClickStep,
  TeachEvent,
  TeachKeyStep,
  TeachNavigateStep,
  TeachTargetRef,
  TeachTypeStep,
  ProcedureDef,
  ActionStepDef,
  InputFieldDef,
} from "@browserops/shared";
import type { TeachSessionStore } from "./session-store.js";
import { CodedError } from "../procedures/store.js";

const PROCEDURE_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/;
const MAX_STEPS_PER_LEAF = 40;
const READ_BATCH = 500;
const IDLE_GAP_MS = 4_000;
const FORM_SUBMIT_NAMES = new Set([
  "submit",
  "send",
  "save",
  "post",
  "continue",
  "next",
  "sign in",
  "log in",
  "search",
  "create",
  "confirm",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s]+$/;

export interface DistilledProcedure {
  name: string;
  kind: "leaf" | "composite";
  yaml: string;
  draft: ProcedureDef;
}

export interface ParameterCandidate {
  /** Event seq the value came from. */
  seq: number;
  /** The literal value the user typed. */
  value: string;
  /** Distiller's guess at a procedure-input name (snake_case, fits the pattern). */
  suggested_name: string;
  /** Always "string" in v1. */
  suggested_type: "string";
  /** True when the distiller already lifted this into the procedure inputs. */
  auto_parameterized: boolean;
  /** Best-effort field label or selector hint to help the agent decide. */
  target_field_label?: string;
}

export interface DistillResult {
  /** Leaves in execution order; composite (if any) is the last entry. */
  procedures: DistilledProcedure[];
  warnings: string[];
  /** Names of inputs created from redacted typing events. */
  redacted_inputs: string[];
  parameter_candidates: ParameterCandidate[];
}

export interface DistillOptions {
  /** Override the auto-derived procedure (or composite) name. */
  name?: string;
  /** Override the auto-derived description. */
  description?: string;
}

export async function distillSession(
  sessionId: string,
  store: TeachSessionStore,
  opts: DistillOptions = {},
): Promise<DistillResult> {
  const meta = await store.getMeta(sessionId);
  if (meta === null) {
    throw new CodedError("PROC_NOT_FOUND", `teach session not found: ${sessionId}`, {
      session_id: sessionId,
    });
  }

  // Drain all events.
  const events: TeachEvent[] = [];
  let sinceSeq = 0;
  for (;;) {
    const chunk = await store.observe(sessionId, sinceSeq, 0, READ_BATCH);
    if (chunk.events.length === 0) break;
    events.push(...chunk.events);
    sinceSeq = chunk.next_seq;
  }

  const warnings: string[] = [];

  if (events.length === 0) {
    warnings.push("session has 0 events — emitting placeholder leaf");
  }

  // Split into leaf groups. Markers and narrations live in the "popup"
  // pseudo-tab and act as boundary signals; we don't emit a step for them.
  const groups = splitIntoLeafGroups(events, warnings);

  // Build a session-wide input plan: walk every typing event in advance
  // so that redacted + auto-parameterised inputs get stable names that
  // both leaves and the composite can reference.
  const inputPlan = planInputs(groups, warnings);

  // Derive the composite/single-leaf base name.
  const firstUrl = events.find((ev) => ev.url !== "")?.url ?? "";
  const host = hostFromUrl(firstUrl);
  const domain = host !== null ? hostToDomain(host) : undefined;
  const baseName =
    opts.name !== undefined && opts.name !== ""
      ? assertProcedureName(opts.name)
      : deriveName(meta.narration_hint, domain, events);

  const description =
    opts.description !== undefined && opts.description !== ""
      ? opts.description.slice(0, 200)
      : meta.narration_hint !== undefined && meta.narration_hint !== ""
        ? meta.narration_hint.slice(0, 200)
        : `Recorded teach session ${sessionId}`;

  // Render each leaf.
  const leafProcedures: DistilledProcedure[] = [];
  groups.forEach((group, idx) => {
    const leafName =
      groups.length === 1 ? baseName : leafNameFor(baseName, group, idx + 1);
    const draft = buildLeafDraft({
      name: leafName,
      description: leafDescriptionFor(group, description, idx + 1, groups.length),
      domain,
      events: group.events,
      inputPlan,
      warnings,
    });
    const yaml =
      sessionHeaderComment(sessionId, meta, "leaf", group.events.length) +
      YAML.stringify(draft, { lineWidth: 0 });
    leafProcedures.push({ name: leafName, kind: "leaf", yaml, draft });
  });

  if (leafProcedures.length === 0) {
    // Empty session — emit a single placeholder leaf so callers have
    // something to feed into procedures_save (if they really want).
    const placeholder: ProcedureDef = {
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
    };
    leafProcedures.push({
      name: baseName,
      kind: "leaf",
      yaml:
        sessionHeaderComment(sessionId, meta, "leaf", 0) +
        YAML.stringify(placeholder, { lineWidth: 0 }),
      draft: placeholder,
    });
  }

  const procedures: DistilledProcedure[] = [...leafProcedures];

  if (leafProcedures.length > 1) {
    const composite = buildCompositeDraft({
      name: baseName,
      description,
      domain,
      leafProcedures,
      inputPlan,
    });
    const yaml =
      sessionHeaderComment(sessionId, meta, "composite", leafProcedures.length) +
      YAML.stringify(composite, { lineWidth: 0 });
    procedures.push({ name: baseName, kind: "composite", yaml, draft: composite });
  }

  return {
    procedures,
    warnings,
    redacted_inputs: inputPlan.redactedNames,
    parameter_candidates: inputPlan.candidates,
  };
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

interface LeafGroup {
  events: TeachEvent[];
  /** Reason this group was started, for warning text and naming hints. */
  reason: "first" | "marker" | "tab_change" | "host_change" | "idle_gap" | "form_submit";
  /** Optional label from a marker event that started this group. */
  marker_label?: string;
}

function splitIntoLeafGroups(events: TeachEvent[], warnings: string[]): LeafGroup[] {
  const groups: LeafGroup[] = [];
  let current: LeafGroup = { events: [], reason: "first" };
  let prevTab: string | null = null;
  let prevHost: string | null = null;
  let prevTs = 0;

  function close(reason: LeafGroup["reason"], markerLabel?: string): void {
    if (current.events.length > 0) groups.push(current);
    current = { events: [], reason };
    if (markerLabel !== undefined) current.marker_label = markerLabel;
    prevTab = null;
    prevHost = null;
    prevTs = 0;
  }

  for (const ev of events) {
    if (ev.tab_id === "popup") {
      // Synthetic events from the popup or the agent.
      if (ev.step.kind === "marker") {
        const label = ev.step.label;
        close("marker", label);
      }
      // Narrations are dropped from the leaf body (they're hints used for
      // naming + descriptions, see leafNameFor / leafDescriptionFor).
      continue;
    }

    let boundary = false;
    let reason: LeafGroup["reason"] = "first";
    if (prevTab !== null && ev.tab_id !== prevTab) {
      boundary = true;
      reason = "tab_change";
    }
    const host = hostFromUrl(ev.url);
    if (!boundary && prevHost !== null && host !== null && host !== prevHost) {
      boundary = true;
      reason = "host_change";
    }
    if (!boundary && prevTs > 0 && ev.ts - prevTs > IDLE_GAP_MS) {
      boundary = true;
      reason = "idle_gap";
    }

    if (boundary && current.events.length > 0) {
      groups.push(current);
      current = { events: [], reason };
    }

    current.events.push(ev);
    prevTab = ev.tab_id;
    if (host !== null) prevHost = host;
    prevTs = ev.ts;

    // Form submit closes the current group AFTER the submit step itself
    // is appended — the submit belongs to the leaf that performed it.
    if (isFormSubmit(ev)) {
      groups.push(current);
      current = { events: [], reason: "form_submit" };
      prevTab = null;
      prevHost = null;
      prevTs = 0;
    }
  }
  if (current.events.length > 0) groups.push(current);

  if (groups.length > 1) {
    warnings.push(
      `Split into ${groups.length} leaves on: ${groups
        .slice(1)
        .map((g) => g.reason)
        .join(", ")}.`,
    );
  }
  return groups;
}

function isFormSubmit(ev: TeachEvent): boolean {
  if (ev.step.kind === "key") {
    const last = ev.step.keys[ev.step.keys.length - 1];
    if (last === "Enter") return true;
  }
  if (ev.step.kind === "click") {
    const name = (ev.step.target.name ?? "").toLowerCase().trim();
    if (FORM_SUBMIT_NAMES.has(name)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Input planning (redacted + auto-parameterised + candidates)
// ---------------------------------------------------------------------------

interface InputPlan {
  /** Map from "<group_index>:<event_seq>" → input name to use in that step. */
  paramByEventKey: Map<string, string>;
  /** Aggregated input definitions across the whole session. */
  inputs: Record<string, InputFieldDef>;
  /** Names of redacted inputs (subset of inputs). */
  redactedNames: string[];
  /** Candidates surfaced for the agent to consider. */
  candidates: ParameterCandidate[];
}

function planInputs(groups: LeafGroup[], _warnings: string[]): InputPlan {
  const paramByEventKey = new Map<string, string>();
  const inputs: Record<string, InputFieldDef> = {};
  const redactedNames: string[] = [];
  const candidates: ParameterCandidate[] = [];
  const nameCounts = new Map<string, number>();

  function reserve(base: string): string {
    const n = (nameCounts.get(base) ?? 0) + 1;
    nameCounts.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  }

  groups.forEach((group, gi) => {
    for (const ev of group.events) {
      if (ev.step.kind !== "type") continue;
      const key = `${gi}:${ev.seq}`;
      const target = ev.step.target;
      const fieldLabel =
        (target.name ?? "").trim() || target.input_type || target.tag || undefined;

      if (ev.step.redacted) {
        const base = redactionParamName(ev.step.redaction_reason);
        const name = reserve(base);
        inputs[name] = {
          type: "string",
          required: true,
          description: redactionDescription(ev.step.redaction_reason, target),
        };
        redactedNames.push(name);
        paramByEventKey.set(key, name);
        continue;
      }

      // Non-redacted typing — try to auto-parameterise common shapes.
      const value = ev.step.value;
      if (EMAIL_RE.test(value)) {
        const base = pickEmailParamName(target);
        const name = reserve(base);
        inputs[name] = { type: "string", required: true, description: `Email — ${fieldLabel ?? "field"}` };
        paramByEventKey.set(key, name);
        candidates.push({
          seq: ev.seq,
          value,
          suggested_name: name,
          suggested_type: "string",
          auto_parameterized: true,
          ...(fieldLabel !== undefined ? { target_field_label: fieldLabel } : {}),
        });
        continue;
      }
      if (URL_RE.test(value)) {
        const name = reserve("url");
        inputs[name] = { type: "string", required: true, description: `URL — ${fieldLabel ?? "field"}` };
        paramByEventKey.set(key, name);
        candidates.push({
          seq: ev.seq,
          value,
          suggested_name: name,
          suggested_type: "string",
          auto_parameterized: true,
          ...(fieldLabel !== undefined ? { target_field_label: fieldLabel } : {}),
        });
        continue;
      }

      // Otherwise: surface as a candidate but inline the value. The agent
      // can choose to lift it during replay.
      if (value.length >= 4 && value.length <= 200) {
        const suggested = suggestNameForFreeText(target);
        candidates.push({
          seq: ev.seq,
          value,
          suggested_name: suggested,
          suggested_type: "string",
          auto_parameterized: false,
          ...(fieldLabel !== undefined ? { target_field_label: fieldLabel } : {}),
        });
      }
    }
  });

  return { paramByEventKey, inputs, redactedNames, candidates };
}

function pickEmailParamName(target: TeachTargetRef): string {
  const name = (target.name ?? "").toLowerCase();
  if (/(to|recipient)/.test(name)) return "to";
  if (/(from|sender)/.test(name)) return "from";
  if (/(cc)/.test(name)) return "cc";
  if (/(bcc)/.test(name)) return "bcc";
  return "email";
}

function suggestNameForFreeText(target: TeachTargetRef): string {
  const name = (target.name ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  if (name.length === 0) return "value";
  const slug = name.split(/\s+/).slice(0, 3).join("_").slice(0, 24);
  return /^[a-z]/.test(slug) ? slug : "value";
}

function redactionParamName(reason: string | undefined): string {
  switch (reason) {
    case "password":
      return "password";
    case "otp":
      return "otp_code";
    case "secret_pattern":
    case "user_marked":
    default:
      return "secret";
  }
}

function redactionDescription(
  reason: string | undefined,
  target: TeachTargetRef,
): string {
  const label =
    (target.name ?? "").trim() ||
    target.input_type ||
    target.tag ||
    "field";
  const why =
    reason === "password"
      ? "redacted at capture (password field)"
      : reason === "otp"
        ? "redacted at capture (autocomplete=one-time-code)"
        : "redacted at capture (matched a known secret pattern)";
  return `${label} — ${why}`;
}

// ---------------------------------------------------------------------------
// Leaf rendering
// ---------------------------------------------------------------------------

interface BuildLeafArgs {
  name: string;
  description: string;
  domain: string | undefined;
  events: TeachEvent[];
  inputPlan: InputPlan;
  warnings: string[];
}

function buildLeafDraft(args: BuildLeafArgs): ProcedureDef {
  const dominantTab = pickDominantTab(args.events);
  const droppedOtherTab = args.events.filter(
    (ev) => dominantTab !== null && ev.tab_id !== dominantTab,
  ).length;
  if (dominantTab !== null && droppedOtherTab > 0) {
    args.warnings.push(
      `${args.name}: ${droppedOtherTab} event(s) on tabs other than ${dominantTab} dropped (single-leaf flatten within a group).`,
    );
  }
  const onTab = args.events.filter((ev) => ev.tab_id === dominantTab);

  const groupKey = `${args.name}`; // approximate — paramByEventKey was keyed on group index+seq, but seq is unique per session, so we look up by seq alone.
  void groupKey;

  const steps: ActionStepDef[] = [];
  let stepIdx = 0;
  let truncated = false;
  for (const ev of onTab) {
    if (steps.length >= MAX_STEPS_PER_LEAF) {
      truncated = true;
      break;
    }
    const inputName = lookupInputName(args.inputPlan, ev.seq);
    const mapped = stepFromEvent(ev, ++stepIdx, inputName);
    if (mapped !== null) steps.push(mapped);
  }
  if (truncated) {
    args.warnings.push(
      `${args.name}: leaf truncated to ${MAX_STEPS_PER_LEAF} steps (session had more interactive events).`,
    );
  }
  if (steps.length === 0) {
    steps.push({
      id: "placeholder",
      action: "browser_navigate",
      with: { tab_id: "{{tab_id}}", url: "https://example.com" },
    });
  }

  // Inputs scoped to this leaf — only include inputs whose typing events
  // actually appear here, plus tab_id is implicit via the well-known {{tab_id}}.
  const usedInputs: Record<string, InputFieldDef> = {};
  for (const ev of onTab) {
    if (ev.step.kind !== "type") continue;
    const name = lookupInputName(args.inputPlan, ev.seq);
    if (name !== undefined) {
      const def = args.inputPlan.inputs[name];
      if (def !== undefined) usedInputs[name] = def;
    }
  }

  const draft: ProcedureDef = {
    schema_version: 1,
    name: args.name,
    description: args.description,
    kind: "leaf",
    ...(args.domain !== undefined ? { domain: args.domain } : {}),
    ...(Object.keys(usedInputs).length > 0 ? { inputs: usedInputs } : {}),
    steps,
  };
  return draft;
}

function lookupInputName(plan: InputPlan, seq: number): string | undefined {
  for (const [key, name] of plan.paramByEventKey) {
    if (key.endsWith(`:${seq}`)) return name;
  }
  return undefined;
}

function pickDominantTab(events: TeachEvent[]): string | null {
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (ev.tab_id === "popup") continue;
    counts.set(ev.tab_id, (counts.get(ev.tab_id) ?? 0) + 1);
  }
  let best: { tab: string; n: number } | null = null;
  for (const [tab, n] of counts) {
    if (best === null || n > best.n) best = { tab, n };
  }
  return best === null ? null : best.tab;
}

function stepFromEvent(
  ev: TeachEvent,
  ord: number,
  inputName: string | undefined,
): ActionStepDef | null {
  switch (ev.step.kind) {
    case "navigate":
      return navigateStep(ev.step, ord);
    case "click":
      return clickStep(ev.step, ord);
    case "type":
      return typeStep(ev.step, ord, inputName);
    case "key":
      return keyStep(ev.step, ord);
    case "scroll":
    case "narration":
    case "marker":
      return null;
  }
}

function navigateStep(step: TeachNavigateStep, ord: number): ActionStepDef {
  return {
    id: stepId(ord, "navigate"),
    action: "browser_navigate",
    with: { tab_id: "{{tab_id}}", url: step.url },
    expected_effect: { url: { changed: true } },
  };
}

function clickStep(step: TeachClickStep, ord: number): ActionStepDef {
  const usableName = pickUsableName(step.target);
  if (usableName !== null) {
    const withParams: Record<string, unknown> = {
      tab_id: "{{tab_id}}",
      text: usableName,
    };
    const role = step.target.role;
    if (role !== undefined && role !== "" && role !== "generic") {
      withParams["role"] = role;
    }
    return {
      id: stepId(ord, "click"),
      action: "browser_click_by_text",
      with: withParams,
      expected_effect: { dom: { any: true } },
    };
  }
  return {
    id: stepId(ord, "click"),
    action: "browser_execute_js",
    with: {
      tab_id: "{{tab_id}}",
      code: `(() => { const el = document.querySelector(${jsString(step.target.selector)}); if (el instanceof HTMLElement) el.click(); return { clicked: el !== null }; })()`,
    },
    expected_effect: { dom: { any: true } },
  };
}

function typeStep(
  step: TeachTypeStep,
  ord: number,
  inputName: string | undefined,
): ActionStepDef {
  const valueExpr = inputName !== undefined ? `{{input.${inputName}}}` : step.value;
  const code = [
    "(() => {",
    `  const el = document.querySelector(${jsString(step.target.selector)});`,
    `  if (!(el instanceof HTMLElement)) return { typed: false, reason: "not_found" };`,
    `  el.focus();`,
    "  if (el.isContentEditable) {",
    `    document.execCommand("insertText", false, ${jsTemplateString(valueExpr)});`,
    `    return { typed: true, mode: "contenteditable" };`,
    "  }",
    "  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {",
    "    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;",
    `    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${jsTemplateString(valueExpr)});`,
    `    el.dispatchEvent(new Event("input", { bubbles: true }));`,
    `    el.dispatchEvent(new Event("change", { bubbles: true }));`,
    `    return { typed: true, mode: "input" };`,
    "  }",
    `  return { typed: false, reason: "unsupported_element" };`,
    "})()",
  ].join("\n");
  return {
    id: stepId(ord, "type"),
    action: "browser_execute_js",
    with: { tab_id: "{{tab_id}}", code },
    expected_effect: { dom: { any: true } },
  };
}

function keyStep(step: TeachKeyStep, ord: number): ActionStepDef {
  const keys = step.keys.map((k) =>
    k === "Meta" || k === "Control" ? "Primary" : k,
  );
  return {
    id: stepId(ord, "press"),
    action: "browser_press",
    with: { tab_id: "{{tab_id}}", keys },
  };
}

// ---------------------------------------------------------------------------
// Composite rendering
// ---------------------------------------------------------------------------

interface BuildCompositeArgs {
  name: string;
  description: string;
  domain: string | undefined;
  leafProcedures: DistilledProcedure[];
  inputPlan: InputPlan;
}

function buildCompositeDraft(args: BuildCompositeArgs): ProcedureDef {
  const usesNames = args.leafProcedures.map((p) => p.name);
  const steps: ActionStepDef[] = args.leafProcedures.map((p, i) => {
    // Pass through every input the leaf declares. The composite's own
    // inputs are the union of all leaves' inputs (built below) so any
    // {{input.X}} the leaf needs is in scope here.
    const leafInputs = p.draft.inputs ?? {};
    const withParams: Record<string, unknown> = { tab_id: "{{tab_id}}" };
    for (const inputName of Object.keys(leafInputs)) {
      withParams[inputName] = `{{input.${inputName}}}`;
    }
    return {
      id: `step_${String(i + 1).padStart(2, "0")}_${slugForId(p.name)}`,
      action: p.name,
      with: withParams,
    };
  });

  // Composite inputs = union of all leaf inputs.
  const compositeInputs: Record<string, InputFieldDef> = {};
  for (const p of args.leafProcedures) {
    for (const [k, v] of Object.entries(p.draft.inputs ?? {})) {
      compositeInputs[k] = v;
    }
  }

  return {
    schema_version: 1,
    name: args.name,
    description: args.description,
    kind: "composite",
    ...(args.domain !== undefined ? { domain: args.domain } : {}),
    ...(Object.keys(compositeInputs).length > 0 ? { inputs: compositeInputs } : {}),
    uses: usesNames,
    steps,
  };
}

function slugForId(s: string): string {
  return s.replace(/[^a-z0-9]+/g, "_").slice(0, 30);
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

function leafNameFor(baseName: string, group: LeafGroup, idx: number): string {
  if (group.marker_label !== undefined && group.marker_label !== "") {
    const slug = group.marker_label
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 30);
    if (slug.length > 0 && /^[a-z]/.test(slug)) {
      return appendLeafSlug(baseName, slug);
    }
  }
  // Use first event's verb + index as a fallback.
  const verb = firstActionVerb(group.events);
  return appendLeafSlug(baseName, `${verb}_${idx}`);
}

function appendLeafSlug(baseName: string, slug: string): string {
  const candidate = baseName.includes(".")
    ? `${baseName}__${slug}`
    : `${baseName}_${slug}`;
  return PROCEDURE_NAME_PATTERN.test(candidate)
    ? candidate.slice(0, 80)
    : `${baseName}_${slug.replace(/[^a-z0-9]/g, "")}`.slice(0, 80);
}

function leafDescriptionFor(
  group: LeafGroup,
  fallback: string,
  idx: number,
  total: number,
): string {
  if (group.marker_label !== undefined && group.marker_label !== "") {
    return `${group.marker_label.slice(0, 180)}`;
  }
  return total === 1 ? fallback : `${fallback} (leaf ${idx} of ${total})`;
}

function deriveName(
  hint: string | undefined,
  domain: string | undefined,
  events: TeachEvent[],
): string {
  if (hint !== undefined && hint !== "") {
    const slug = hint
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 50);
    if (slug.length > 0 && /^[a-z]/.test(slug)) {
      return domain !== undefined ? `${domain}.${slug}` : slug;
    }
  }
  const verb = firstActionVerb(events);
  const base = (domain ?? "session") + "." + verb;
  return PROCEDURE_NAME_PATTERN.test(base) ? base : "session.recorded";
}

function firstActionVerb(events: TeachEvent[]): string {
  for (const ev of events) {
    switch (ev.step.kind) {
      case "click":
        return "click_through";
      case "type":
        return "fill_form";
      case "navigate":
        return "navigate";
      case "key":
        return "key_chord";
    }
  }
  return "recorded";
}

function assertProcedureName(name: string): string {
  if (!PROCEDURE_NAME_PATTERN.test(name)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `name must match ^[a-z][a-z0-9_.-]{0,79}$ — got: ${name}`,
    );
  }
  return name;
}

function pickUsableName(target: TeachTargetRef): string | null {
  const name = (target.name ?? "").trim();
  if (name.length < 2 || name.length > 80) return null;
  if (/\s{3,}|[\n\r]/.test(name)) return null;
  return name;
}

function hostFromUrl(url: string): string | null {
  if (url === "") return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function hostToDomain(host: string): string | undefined {
  const stripped = host.replace(/^www\./, "");
  const parts = stripped.split(".");
  let candidate: string | undefined = parts[parts.length - 2];
  if (candidate === undefined || candidate.length < 2) {
    candidate = parts[0];
  }
  if (candidate === undefined) return undefined;
  candidate = candidate.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!/^[a-z]/.test(candidate)) return undefined;
  return candidate.slice(0, 40);
}

function stepId(ord: number, verb: string): string {
  return `step_${String(ord).padStart(2, "0")}_${verb}`;
}

function jsString(s: string): string {
  return JSON.stringify(s);
}

function jsTemplateString(value: string): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// YAML header comment
// ---------------------------------------------------------------------------

function sessionHeaderComment(
  sessionId: string,
  meta: { started_at: number; stopped_at?: number; event_count: number },
  kind: "leaf" | "composite",
  stepOrLeafCount: number,
): string {
  const stoppedLine =
    meta.stopped_at !== undefined
      ? `# Stopped:  ${new Date(meta.stopped_at).toISOString()}`
      : `# Stopped:  (still active)`;
  const tail =
    kind === "leaf"
      ? `# Events:   ${meta.event_count} captured, ${stepOrLeafCount} step(s) in this leaf`
      : `# Composite: ${stepOrLeafCount} leaves`;
  return [
    `# Distilled from teach session ${sessionId}`,
    `# Started:  ${new Date(meta.started_at).toISOString()}`,
    stoppedLine,
    tail,
    `#`,
    `# DRAFT — replay before saving. type events are emitted as`,
    `# browser_execute_js for portability; swap to browser_quick_read +`,
    `# browser_type if you prefer ref-based dispatch.`,
    "",
  ].join("\n");
}
