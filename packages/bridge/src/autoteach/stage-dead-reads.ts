/**
 * Distiller stage: drop reads whose result no later step consumed.
 *
 * A "dead" read is a browser_read / browser_quick_read / browser_describe_ref /
 * browser_query_selector whose returned `ref` (or `refs` array, or
 * `text` substrings) doesn't appear in any subsequent step's params.
 *
 * Reference detection is conservative — we look at:
 *   - any integer ref that appears in params of later steps
 *   - any string substring of length >= 4 from the read's surfaced
 *     text that appears in later steps' params
 *
 * False negatives (keeping a dead read) are fine: extra steps just
 * add noise to the draft. False positives (dropping a live read) would
 * break replay, so we err on keeping.
 */
import type { IRStep } from "./distiller-ir.js";

const READ_METHODS: ReadonlySet<string> = new Set([
  "browser_read",
  "browser_quick_read",
  "browser_describe_ref",
  "browser_query_selector",
]);

const MIN_TEXT_MATCH = 4;

export function removeDeadReads(steps: IRStep[]): IRStep[] {
  const liveAt = new Set<number>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] as IRStep;
    if (!READ_METHODS.has(s.method)) {
      liveAt.add(i);
      continue;
    }
    if (laterStepConsumes(steps, i)) liveAt.add(i);
  }
  return steps.filter((_, i) => liveAt.has(i));
}

function laterStepConsumes(steps: IRStep[], readIdx: number): boolean {
  const read = steps[readIdx] as IRStep;
  // We don't have access to the read's actual response here (the bridge
  // strips large fields from the trace). Use the params + page_effect to
  // build a conservative consumer-detector: future steps that reference
  // ref:N or use a text/selector closely matching what was queried.
  const queryText = pickQueryText(read.params);
  for (let i = readIdx + 1; i < steps.length; i++) {
    const next = steps[i] as IRStep;
    // ref:N usage in subsequent steps strongly suggests live read.
    const ref = next.params["ref"];
    if (typeof ref === "number" && Number.isInteger(ref)) return true;
    if (queryText !== undefined) {
      for (const v of Object.values(next.params)) {
        if (typeof v !== "string") continue;
        if (v.length < MIN_TEXT_MATCH) continue;
        if (v.includes(queryText) || queryText.includes(v)) return true;
      }
    }
  }
  return false;
}

function pickQueryText(params: Record<string, unknown>): string | undefined {
  for (const key of ["text", "selector", "query"]) {
    const v = params[key];
    if (typeof v === "string" && v.length >= MIN_TEXT_MATCH) return v;
  }
  return undefined;
}
