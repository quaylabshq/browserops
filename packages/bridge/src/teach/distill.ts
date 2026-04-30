/**
 * Distill a recorded teach session into a draft procedure YAML (single-leaf MVP).
 *
 * Single-leaf scope (Step 6): every meaningful interaction in the session
 * becomes one step in one leaf. Markers, scrolls, narrations are dropped
 * (markers feed Step 7's modular split). Multi-tab sessions are flattened
 * onto the dominant tab — the tab with the most interactions wins, and
 * events on other tabs emit a warning instead of a step.
 *
 * Output is a draft. The agent runs replay against it before calling
 * procedures_save — same "never save an untested procedure" rule as
 * everywhere else in the codebase.
 *
 * Step mapping:
 *   click  → browser_click_by_text when the accessible name looks usable;
 *            otherwise browser_execute_js with document.querySelector(...)?.click().
 *   type   → browser_execute_js that focuses the selector and inserts text,
 *            handling both native <input>/<textarea> (via the prototype value
 *            setter + input/change events, so React etc. see the change) and
 *            contenteditable (execCommand insertText). Single step per type;
 *            avoids the browser_type ref-resolution problem at the YAML
 *            authoring layer.
 *   key    → browser_press with Meta/Control normalised to Primary.
 *   navigate → browser_navigate(tab_id, url).
 *   scroll, narration, marker → dropped in single-leaf MVP.
 *
 * Inputs:
 *   tab_id is always declared (well-known, supplied by caller).
 *   Each redacted typing event becomes a required string input named after
 *   its redaction_reason (password / otp_code / secret), de-duplicated with
 *   a numeric suffix when the same name recurs.
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
const MAX_STEPS = 40;
const READ_BATCH = 500;

export interface DistillResult {
  /** Rendered YAML the agent can pass straight to procedures_save (after replay). */
  yaml: string;
  /** Parsed procedure for inspection / round-trip in tests. */
  draft: ProcedureDef;
  /** Notes about events that were dropped, truncated, or guessed. */
  warnings: string[];
  /** Names of redacted inputs the runner must supply at execution time. */
  redacted_inputs: string[];
}

export interface DistillOptions {
  /** Procedure name override. Must match ^[a-z][a-z0-9_.-]{0,79}$. */
  name?: string;
  /** Description override; defaults to the session's narration_hint or a generated stub. */
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

  // Drain all events. observe(0, 0, batch) returns events in seq order; loop
  // until we've consumed every available event.
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

  // Pick the tab with the most events; the rest are flattened away with a
  // warning. Multi-tab support lives in the modular-split distiller (Step 7).
  const dominantTabId = pickDominantTab(events);
  const droppedOtherTab = events.filter(
    (ev) => ev.tab_id !== dominantTabId && ev.tab_id !== "popup",
  ).length;
  if (dominantTabId !== null && droppedOtherTab > 0) {
    warnings.push(
      `${droppedOtherTab} event(s) on tabs other than ${dominantTabId} were dropped (single-leaf flatten).`,
    );
  }

  const onTab = events.filter(
    (ev) => ev.tab_id === dominantTabId || ev.tab_id === "popup",
  );

  // Allocate redacted-input names up-front so step rendering can reference
  // them. We pre-walk type events and assign one input per redacted event.
  const redactedInputs: { event: TeachEvent; name: string }[] = [];
  const inputNameCounts = new Map<string, number>();
  for (const ev of onTab) {
    if (ev.step.kind !== "type" || !ev.step.redacted) continue;
    const base = redactionParamName(ev.step.redaction_reason);
    const count = (inputNameCounts.get(base) ?? 0) + 1;
    inputNameCounts.set(base, count);
    const finalName = count === 1 ? base : `${base}_${count}`;
    redactedInputs.push({ event: ev, name: finalName });
  }

  // Build the steps array.
  const steps: ActionStepDef[] = [];
  let stepIdx = 0;
  let truncated = false;
  for (const ev of onTab) {
    if (steps.length >= MAX_STEPS) {
      truncated = true;
      break;
    }
    const mapped = stepFromEvent(ev, ++stepIdx, redactedInputs);
    if (mapped !== null) steps.push(mapped);
  }
  if (truncated) {
    warnings.push(
      `session has more than ${MAX_STEPS} interactive events — output truncated to fit the procedure step cap.`,
    );
  }
  if (steps.length === 0) {
    warnings.push("no mappable steps after filtering — emitting placeholder leaf");
    steps.push({
      id: "placeholder",
      action: "browser_navigate",
      with: { tab_id: "{{tab_id}}", url: "https://example.com" },
    });
  }

  // Inputs: tab_id is implicit ({{tab_id}} is well-known per binding-validator
  // semantics — no need to declare). Just the redacted parameters.
  const inputs: Record<string, InputFieldDef> = {};
  for (const r of redactedInputs) {
    if (r.event.step.kind !== "type") continue;
    inputs[r.name] = {
      type: "string",
      required: true,
      description: redactionDescription(r.event.step.redaction_reason, r.event.step.target),
    };
  }

  // Domain: derive from the first navigate's host, or from the first event's
  // URL host. Used both in name fallback and as the procedure's domain tag.
  const firstUrl = onTab.find((ev) => ev.url !== "")?.url ?? "";
  const host = hostFromUrl(firstUrl);
  const domain = host !== null ? hostToDomain(host) : undefined;

  const name =
    opts.name !== undefined && opts.name !== ""
      ? assertProcedureName(opts.name)
      : deriveName(meta.narration_hint, domain, onTab);

  const description =
    opts.description !== undefined && opts.description !== ""
      ? opts.description.slice(0, 200)
      : meta.narration_hint !== undefined && meta.narration_hint !== ""
        ? meta.narration_hint.slice(0, 200)
        : `Recorded teach session ${sessionId}`;

  const draft: ProcedureDef = {
    schema_version: 1,
    name,
    description,
    kind: "leaf",
    ...(domain !== undefined ? { domain } : {}),
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    steps,
  };

  const headerComment = [
    `# Distilled from teach session ${sessionId}`,
    `# Started:  ${new Date(meta.started_at).toISOString()}`,
    meta.stopped_at !== undefined
      ? `# Stopped:  ${new Date(meta.stopped_at).toISOString()}`
      : `# Stopped:  (still active)`,
    `# Events:   ${meta.event_count} captured, ${steps.length} step(s) emitted`,
    `#`,
    `# DRAFT — replay before saving. type events are emitted as`,
    `# browser_execute_js for portability; swap to browser_quick_read +`,
    `# browser_type if you prefer ref-based dispatch.`,
    "",
  ].join("\n");

  const yaml = headerComment + YAML.stringify(draft, { lineWidth: 0 });

  return {
    yaml,
    draft,
    warnings,
    redacted_inputs: redactedInputs.map((r) => r.name),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickDominantTab(events: TeachEvent[]): string | null {
  const counts = new Map<string, number>();
  for (const ev of events) {
    if (ev.tab_id === "popup") continue; // narration / marker events
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
  redacted: { event: TeachEvent; name: string }[],
): ActionStepDef | null {
  switch (ev.step.kind) {
    case "navigate":
      return navigateStep(ev.step, ord);
    case "click":
      return clickStep(ev.step, ord);
    case "type":
      return typeStep(ev.step, ord, redacted.find((r) => r.event === ev)?.name);
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
    with: {
      tab_id: "{{tab_id}}",
      url: step.url,
    },
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
  // Fallback: synthetic click via execute_js. Less reliable on canvas apps,
  // but the agent will rewrite during replay.
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
  redactedInputName: string | undefined,
): ActionStepDef {
  const valueExpr =
    step.redacted && redactedInputName !== undefined
      ? `{{input.${redactedInputName}}}`
      : step.value;

  // Build a small JS snippet that handles:
  //   - native <input>/<textarea>: use the prototype value setter so React
  //     and friends see the change, then dispatch input + change.
  //   - contenteditable: focus + execCommand("insertText").
  // Selector is the recorded best-effort selector; the agent can swap this
  // for a more stable one during replay.
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
    with: {
      tab_id: "{{tab_id}}",
      code,
    },
    expected_effect: { dom: { any: true } },
  };
}

function keyStep(step: TeachKeyStep, ord: number): ActionStepDef {
  // Normalise Meta / Control to Primary so the procedure works on any OS.
  const keys = step.keys.map((k) =>
    k === "Meta" || k === "Control" ? "Primary" : k,
  );
  return {
    id: stepId(ord, "press"),
    action: "browser_press",
    with: {
      tab_id: "{{tab_id}}",
      keys,
    },
  };
}

function stepId(ord: number, verb: string): string {
  return `step_${String(ord).padStart(2, "0")}_${verb}`;
}

function pickUsableName(target: TeachTargetRef): string | null {
  const name = (target.name ?? "").trim();
  if (name.length < 2 || name.length > 80) return null;
  // Reject names that look like long body text rather than a label.
  if (/\s{3,}|[\n\r]/.test(name)) return null;
  return name;
}

function redactionParamName(reason: string | undefined): string {
  switch (reason) {
    case "password":
      return "password";
    case "otp":
      return "otp_code";
    case "secret_pattern":
      return "secret";
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

function hostFromUrl(url: string): string | null {
  if (url === "") return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Translate "mail.google.com" → "gmail" when we can recognise it; otherwise
 * just take the bare hostname's first label. Domain pattern is
 * ^[a-z][a-z0-9_-]*$ so we sanitise.
 */
function hostToDomain(host: string): string | undefined {
  // Strip leading "www." and any port; take the rightmost-recognisable label.
  const stripped = host.replace(/^www\./, "");
  const parts = stripped.split(".");
  // Use the second-level domain when it's not a well-known TLD candidate.
  // For "mail.google.com" → "google"; for "amazon.in" → "amazon"; for
  // "tempmailo.com" → "tempmailo".
  let candidate: string | undefined = parts[parts.length - 2];
  if (candidate === undefined || candidate.length < 2) {
    candidate = parts[0];
  }
  if (candidate === undefined) return undefined;
  candidate = candidate.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!/^[a-z]/.test(candidate)) return undefined;
  return candidate.slice(0, 40);
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
  // Fall back to <domain>.<verb> from the first interaction.
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

function jsString(s: string): string {
  return JSON.stringify(s);
}

/**
 * Embed `value` as a JS string literal. If value is a binding placeholder
 * (`{{input.foo}}`) we still serialise via JSON.stringify — at runtime the
 * bridge templater substitutes the literal text into the YAML before the JS
 * code is sent to the browser. That keeps the placeholder a string in JS
 * land too; on substitution the value flows in as a plain literal.
 */
function jsTemplateString(value: string): string {
  return JSON.stringify(value);
}
