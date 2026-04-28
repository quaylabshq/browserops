/**
 * Convert teach-mode events into synthetic AutoTeachTraceRecord[] so the
 * autoteach distiller pipeline can consume a user demonstration as if it
 * were an agent-driven trace.
 *
 * This bridges the demo-mode gap: in demo mode the user clicks the page,
 * which produces TeachEvents (in the teach session JSONL) but zero
 * browser_* dispatches (so trace.jsonl is empty). The autoteach distiller
 * pipeline expects AutoTeachTraceRecord[] — without this converter the
 * pipeline emits a placeholder leaf no matter how rich the demo was.
 *
 * Mapping rules:
 *   - navigate → browser_navigate
 *   - click    → browser_click_by_text when target.name is usable; else
 *                browser_click_at with the captured viewport coords
 *   - type     → browser_type, with consecutive type events on the same
 *                target collapsed to the final value
 *   - key      → browser_press, Meta/Control normalized to Primary
 *   - scroll / narration / marker — dropped (autoteach distiller has no
 *     notion of any of these; markers aren't a hard split signal here)
 *
 * Side-effect-free; mirrors the mapping logic in
 * packages/bridge/src/teach/distill.ts so the two pipelines stay
 * structurally consistent.
 */

import type {
  AutoTeachTraceRecord,
  PageEffect,
  TeachClickStep,
  TeachEvent,
  TeachKeyStep,
  TeachNavigateStep,
  TeachTargetRef,
  TeachTypeStep,
} from "@browserops/shared";

interface ConvertOptions {
  runIndex: number;
}

export function teachEventsToTraceRecords(
  events: TeachEvent[],
  opts: ConvertOptions,
): AutoTeachTraceRecord[] {
  const collapsed = collapseConsecutiveTypes(events);
  const records: AutoTeachTraceRecord[] = [];
  let prevTs = collapsed.length > 0 ? collapsed[0]!.ts : 0;
  let prevUrl: string | null = null;

  for (const ev of collapsed) {
    if (ev.tab_id === "popup") continue; // synthetic narration/marker
    const tabId = ev.tab_id;
    const duration_ms = Math.max(0, ev.ts - prevTs);
    prevTs = ev.ts;

    const urlChanged = prevUrl !== null && prevUrl !== ev.url;
    const pageEffect: PageEffect | undefined = urlChanged
      ? synthesizeUrlChangeEffect(prevUrl ?? "", ev.url, duration_ms)
      : undefined;
    prevUrl = ev.url;

    const mapped = mapStep(ev, tabId);
    if (mapped === null) continue;
    const record: AutoTeachTraceRecord = {
      ts: ev.ts,
      run_index: opts.runIndex,
      method: mapped.method,
      params: mapped.params,
      ok: true,
      duration_ms,
      ...(pageEffect !== undefined ? { page_effect: pageEffect } : {}),
    };
    records.push(record);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Type-event coalescing — keep only the last consecutive type on a target so
// the distiller doesn't see "pra", "pratha", "pratham" as three retries.
// ---------------------------------------------------------------------------

function collapseConsecutiveTypes(events: TeachEvent[]): TeachEvent[] {
  const out: TeachEvent[] = [];
  for (const ev of events) {
    if (ev.step.kind !== "type") {
      out.push(ev);
      continue;
    }
    const prev = out[out.length - 1];
    if (
      prev !== undefined &&
      prev.step.kind === "type" &&
      prev.tab_id === ev.tab_id &&
      sameTarget(prev.step.target, ev.step.target)
    ) {
      out[out.length - 1] = ev;
      continue;
    }
    out.push(ev);
  }
  return out;
}

function sameTarget(a: TeachTargetRef, b: TeachTargetRef): boolean {
  if (a.selector !== "" && a.selector === b.selector) return true;
  if ((a.name ?? "") !== "" && a.name === b.name && a.role === b.role) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Per-step mapping
// ---------------------------------------------------------------------------

interface MappedCall {
  method: string;
  params: Record<string, unknown>;
}

function mapStep(ev: TeachEvent, tabId: string): MappedCall | null {
  switch (ev.step.kind) {
    case "navigate":
      return mapNavigate(ev.step, tabId);
    case "click":
      return mapClick(ev.step, tabId);
    case "type":
      return mapType(ev.step, tabId);
    case "key":
      return mapKey(ev.step, tabId);
    case "scroll":
    case "narration":
    case "marker":
      return null;
  }
}

function mapNavigate(step: TeachNavigateStep, tabId: string): MappedCall {
  return { method: "browser_navigate", params: { tab_id: tabId, url: step.url } };
}

function mapClick(step: TeachClickStep, tabId: string): MappedCall {
  const usableName = pickUsableName(step.target);
  if (usableName !== null) {
    const params: Record<string, unknown> = { tab_id: tabId, text: usableName };
    const role = step.target.role;
    if (role !== undefined && role !== "" && role !== "generic") params["role"] = role;
    return { method: "browser_click_by_text", params };
  }
  if (step.x !== undefined && step.y !== undefined) {
    return {
      method: "browser_click_at",
      params: { tab_id: tabId, x: step.x, y: step.y, button: step.button },
    };
  }
  return {
    method: "browser_click",
    params: { tab_id: tabId, ref: { css: step.target.selector } },
  };
}

function mapType(step: TeachTypeStep, tabId: string): MappedCall {
  return {
    method: "browser_type",
    params: {
      tab_id: tabId,
      ref: { css: step.target.selector },
      value: step.value,
      ...(step.redacted ? { redacted: true } : {}),
    },
  };
}

function mapKey(step: TeachKeyStep, tabId: string): MappedCall {
  const keys = step.keys.map((k) => (k === "Meta" || k === "Control" ? "Primary" : k));
  return { method: "browser_press", params: { tab_id: tabId, keys } };
}

function synthesizeUrlChangeEffect(
  before: string,
  after: string,
  windowMs: number,
): PageEffect {
  return {
    dom: { added: 0, removed: 0, attr_changes: 0, text_changes: 0 },
    url: { changed: true, before, after },
    focus: { changed: false },
    network: { requests_started: 0, requests_completed: 0, in_flight_at_end: 0 },
    console_errors: 0,
    window_ms: windowMs,
  };
}

function pickUsableName(target: TeachTargetRef): string | null {
  const name = (target.name ?? "").trim();
  if (name.length < 2 || name.length > 80) return null;
  if (/\s{3,}|[\n\r]/.test(name)) return null;
  return name;
}
