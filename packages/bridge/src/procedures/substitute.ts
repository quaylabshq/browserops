/**
 * Variable substitution for procedure step parameters.
 *
 * Recognised placeholder forms:
 *   {{tab_id}}        → inputs.tab_id
 *   {{input.NAME}}    → inputs.NAME              (preferred form)
 *   {{NAME}}          → inputs.NAME              (legacy/loose form)
 *   {{BIND.field}}    → binds[BIND].field        (subfield path traversed)
 *
 * Strings are scanned; objects and arrays recurse. Non-string scalars are
 * returned as-is. Unresolved placeholders are left intact so a missing
 * input shows up at the call site rather than as a silent empty string.
 */

export function substituteVars(
  value: unknown,
  inputs: Record<string, unknown>,
  binds?: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
      const trimmed = key.trim();

      // Bind path? form is "<bind>.<field>[.<sub>]" with at least one dot.
      // We treat as bind only if `binds` carries the head.
      if (binds && trimmed.includes(".")) {
        const head = trimmed.slice(0, trimmed.indexOf("."));
        if (Object.prototype.hasOwnProperty.call(binds, head) && head !== "input") {
          const resolved = traverse(binds[head], trimmed.slice(head.length + 1));
          return stringifyValue(resolved, match);
        }
      }

      // Input form: input.NAME → inputs[NAME]
      const lookupKey = trimmed.startsWith("input.")
        ? trimmed.slice("input.".length)
        : trimmed;

      if (Object.prototype.hasOwnProperty.call(inputs, lookupKey)) {
        return stringifyValue(inputs[lookupKey], match);
      }
      if (
        lookupKey !== trimmed &&
        Object.prototype.hasOwnProperty.call(inputs, trimmed)
      ) {
        return stringifyValue(inputs[trimmed], match);
      }

      return match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteVars(item, inputs, binds));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = substituteVars(v, inputs, binds);
    }
    return result;
  }
  return value;
}

function stringifyValue(v: unknown, fallback: string): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function traverse(root: unknown, path: string): unknown {
  if (root === null || root === undefined) return undefined;
  const parts = path.split(".");
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
