/**
 * Intermediate representation used by the distiller pipeline.
 *
 * The pipeline is a sequence of pure functions over IRStep[] (or
 * IRLeaf[] in the second half) so each stage is independently
 * testable, reorderable, and easy to extend without re-threading
 * arguments through.
 */
import type {
  AutoTeachTraceRecord,
  PageEffect,
  SelectorTier,
  SideEffectClass,
} from "@browserops/shared";

export interface IRStep {
  /** Index in the source trace array — preserved through filtering. */
  trace_index: number;
  ts: number;
  method: string;
  params: Record<string, unknown>;
  ok: boolean;
  duration_ms: number;
  page_effect?: PageEffect;
  /** True if this step is the successful tail of a retry chain. */
  retry_tail?: boolean;

  // Mutable fields filled in by later stages:

  /** Selector stability tier inferred from params/page_effect metadata. */
  selector_tier?: SelectorTier;
  /** Output name this step's result is bound to (for downstream lift_to_bind). */
  bind_out?: string;
  /** Map of arg key → bind reference, written when an arg sources from an earlier step. */
  arg_binds?: Record<string, string>;
  /** Tightened wait_for timeout in ms, if the step needs an async settle. */
  wait_for_ms?: number;
  /** Step id assigned during emit. */
  step_id?: string;
}

export type LeafSplitReason =
  | "first"
  | "url_change"
  | "modal_open"
  | "focus_shift"
  | "network_burst";

export interface IRLeaf {
  steps: IRStep[];
  reason: LeafSplitReason;
  /** Side-effect classification (computed during emit). */
  side_effects?: SideEffectClass[];
}

/**
 * Stage 1: normalize — drop non-browser_* records, sort by ts, copy
 * fields into IRStep. Pure; doesn't filter by run_index (callers do
 * that earlier when they read the trace).
 */
export function normalize(records: AutoTeachTraceRecord[]): IRStep[] {
  const filtered = records.filter((r) => r.method.startsWith("browser_"));
  filtered.sort((a, b) => a.ts - b.ts);
  return filtered.map((r, i) => ({
    trace_index: i,
    ts: r.ts,
    method: r.method,
    params: r.params,
    ok: r.ok,
    duration_ms: r.duration_ms,
    ...(r.page_effect !== undefined ? { page_effect: r.page_effect } : {}),
  }));
}
