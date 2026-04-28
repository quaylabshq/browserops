/**
 * Distiller stage: tighten wait_for timeouts.
 *
 * For each step that has an observable page_effect, compute a tightened
 * wait_for timeout based on the step's observed duration_ms.
 *
 * Formula: max(observed × 1.5, 1000ms), capped at 30000ms.
 *
 * The actual wait_for selector/text isn't filled in here — that's data
 * we don't have from the trace. Instead the stage records `wait_for_ms`
 * on the IRStep, and the emit phase will set `wait_for: { selector: ... }`
 * with a placeholder when no selector signal is available, leaving the
 * expected_effect (added in stage-emit) as the primary post-condition.
 */
import type { IRStep } from "./distiller-ir.js";

const MIN_WAIT_MS = 1000;
const MAX_WAIT_MS = 30_000;

export function tuneWaits(steps: IRStep[]): IRStep[] {
  return steps.map((s) => {
    if (s.page_effect === undefined) return s;
    if (!hasObservableEffect(s.page_effect)) return s;
    const observed = s.duration_ms > 0 ? s.duration_ms : MIN_WAIT_MS;
    const target = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.ceil(observed * 1.5)));
    return { ...s, wait_for_ms: target };
  });
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
