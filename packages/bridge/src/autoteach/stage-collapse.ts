/**
 * Distiller stage: collapse retry chains.
 *
 * A retry chain is a run of consecutive failed steps with the same
 * method and similar params, optionally terminated by a successful
 * step with the same method+params. Within a chain we keep only the
 * successful tail; if every attempt failed, we keep only the last
 * attempt (so the YAML still surfaces the failure mode).
 *
 * Similarity test for params: same set of keys, same primitive values
 * for tab_id/url/text/role/ref/keys/code; ignores page_effect-derived
 * fields. The window is bounded — retries more than RETRY_GAP_MS apart
 * are treated as separate intentions, not a chain.
 */
import type { IRStep } from "./distiller-ir.js";

const RETRY_GAP_MS = 5_000;

const SIMILARITY_KEYS: ReadonlySet<string> = new Set([
  "tab_id",
  "url",
  "ref",
  "text",
  "role",
  "selector",
  "code",
  "keys",
  "x",
  "y",
]);

export function collapseRetries(steps: IRStep[]): IRStep[] {
  if (steps.length <= 1) return steps.slice();
  const out: IRStep[] = [];
  let chainStart = 0;

  function commitChain(endExclusive: number): void {
    if (endExclusive <= chainStart) return;
    const chain = steps.slice(chainStart, endExclusive);
    // Keep the last successful step if any; otherwise the last attempt.
    let pick: IRStep | undefined;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i]?.ok) {
        pick = chain[i];
        break;
      }
    }
    if (pick === undefined) pick = chain[chain.length - 1];
    if (pick !== undefined) {
      out.push({ ...pick, retry_tail: chain.length > 1 });
    }
  }

  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1] as IRStep;
    const cur = steps[i] as IRStep;
    const sameMethod = prev.method === cur.method;
    const closeInTime = cur.ts - prev.ts <= RETRY_GAP_MS;
    if (sameMethod && closeInTime && paramsSimilar(prev.params, cur.params)) {
      // continue chain
      continue;
    }
    commitChain(i);
    chainStart = i;
  }
  commitChain(steps.length);
  return out;
}

function paramsSimilar(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  for (const key of SIMILARITY_KEYS) {
    if (key in a !== key in b) return false;
    if (key in a && JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      return false;
    }
  }
  return true;
}
