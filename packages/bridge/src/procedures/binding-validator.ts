/**
 * Validates {{...}} reference bindings inside a parsed procedure.
 *
 * Catches the magic_url-class of bug: a step references a field on a prior
 * step's output that the prior step does not actually return.
 *
 * Three reference forms are recognised in any string value under step.with,
 * step.do[].with, or step.on_fail[].with:
 *
 *   {{tab_id}}                — always valid (well-known caller-supplied)
 *   {{input.NAME}}            — NAME must be a declared procedure input
 *   {{BIND.FIELD[.subkey]}}   — BIND must equal a prior step's `bind:` value;
 *                               FIELD validation depends on that step's action:
 *                                 - tool action: FIELD must be in the tool's
 *                                   outputSchema.properties (sub-keys opaque,
 *                                   resolved by the agent at runtime).
 *                                 - sub-procedure action: skipped — procedures
 *                                   don't declare an output schema today.
 *
 * Any reference that doesn't match one of these forms, or that fails its
 * specific check, is reported as an error with an instancePath.
 */
import { TOOL_DEF_MAP } from "@browserops/shared";
import type { ProcedureDef, StepDef, ActionStepDef, ForEachStepDef } from "@browserops/shared";

export interface BindingError {
  /** JSON-pointer-style location, e.g. /steps/2/with/ref */
  instancePath: string;
  message: string;
}

export interface BindingValidationResult {
  valid: boolean;
  errors?: BindingError[];
}

const REF_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

function isActionStep(step: StepDef): step is ActionStepDef {
  return typeof (step as ActionStepDef).action === "string";
}

function isForEachStep(step: StepDef): step is ForEachStepDef {
  return typeof (step as ForEachStepDef).for_each === "string";
}

interface BoundContext {
  /** Map from bind-name → step.action for prior steps that declared `bind:`. */
  binds: Map<string, string>;
  /** Set of declared input names. */
  inputs: Set<string>;
  /** Names whose sub-fields are opaque (e.g. for-each `as`). */
  opaqueHeads: Set<string>;
}

function checkValue(
  value: unknown,
  pathPrefix: string,
  ctx: BoundContext,
  errors: BindingError[],
): void {
  if (typeof value === "string") {
    checkString(value, pathPrefix, ctx, errors);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkValue(v, `${pathPrefix}/${i}`, ctx, errors));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      checkValue(v, `${pathPrefix}/${k}`, ctx, errors);
    }
  }
}

function checkString(
  s: string,
  instancePath: string,
  ctx: BoundContext,
  errors: BindingError[],
): void {
  for (const match of s.matchAll(REF_PATTERN)) {
    const expr = match[1]!.trim();
    if (expr.length === 0) {
      errors.push({ instancePath, message: "empty {{}} reference" });
      continue;
    }

    if (expr === "tab_id") continue;

    const dotIdx = expr.indexOf(".");
    const head = dotIdx === -1 ? expr : expr.slice(0, dotIdx);

    // Opaque heads (e.g. for-each `as`) bypass field checks entirely.
    if (ctx.opaqueHeads.has(head)) continue;

    if (dotIdx === -1) {
      // Bare identifier other than tab_id / opaque — not a recognised form
      errors.push({
        instancePath,
        message: `unknown reference "{{${expr}}}" — expected tab_id, input.<name>, or <bind>.<field>`,
      });
      continue;
    }

    const rest = expr.slice(dotIdx + 1);
    const firstSegment = rest.split(".")[0]!;

    if (head === "input") {
      if (!ctx.inputs.has(firstSegment)) {
        errors.push({
          instancePath,
          message: `references undeclared input "${firstSegment}" in {{${expr}}}`,
        });
      }
      continue;
    }

    // Treat as bind-name
    const action = ctx.binds.get(head);
    if (action === undefined) {
      errors.push({
        instancePath,
        message: `references unknown bind "${head}" in {{${expr}}} — no prior step declared bind: ${head}`,
      });
      continue;
    }

    const toolDef = TOOL_DEF_MAP[action];
    if (!toolDef) {
      // Sub-procedure (non-tool action) — outputs schema not declared today.
      // Skip with no error; this is a known gap covered by composite re-author.
      continue;
    }

    const props = toolDef.outputSchema.properties ?? {};
    if (!(firstSegment in props)) {
      const known = Object.keys(props).join(", ") || "(none)";
      errors.push({
        instancePath,
        message: `field "${firstSegment}" not in ${action} outputSchema (known: ${known}) in {{${expr}}}`,
      });
    }
  }
}

export function validateBindings(
  parsed: unknown,
): BindingValidationResult {
  if (parsed === null || typeof parsed !== "object") {
    return { valid: true };
  }
  const proc = parsed as Partial<ProcedureDef>;
  const errors: BindingError[] = [];

  const inputs = new Set<string>(Object.keys(proc.inputs ?? {}));
  const binds = new Map<string, string>();

  const steps = Array.isArray(proc.steps) ? proc.steps : [];

  steps.forEach((step, i) => {
    const stepPath = `/steps/${i}`;

    if (isActionStep(step)) {
      const ctx: BoundContext = { binds: new Map(binds), inputs, opaqueHeads: new Set() };
      if (step.with !== undefined) {
        checkValue(step.with, `${stepPath}/with`, ctx, errors);
      }
      if (step.on_fail !== undefined) {
        step.on_fail.forEach((item, j) => {
          if (item.with !== undefined) {
            checkValue(item.with, `${stepPath}/on_fail/${j}/with`, ctx, errors);
          }
        });
      }
      // Register this step's bind AFTER its own with/ checks — a step cannot
      // reference its own bound name.
      if (typeof step.bind === "string" && step.bind.length > 0) {
        binds.set(step.bind, step.action);
      }
      return;
    }

    if (isForEachStep(step)) {
      // The `for_each:` expression itself is a reference and must validate
      // against the outer context (no `as` available yet).
      const outerCtx: BoundContext = {
        binds: new Map(binds),
        inputs,
        opaqueHeads: new Set(),
      };
      checkString(step.for_each, `${stepPath}/for_each`, outerCtx, errors);

      // Inside do[].with the `as` name is available but its element shape
      // is unknown; treat as an opaque head.
      const innerCtx: BoundContext = {
        binds: new Map(binds),
        inputs,
        opaqueHeads: new Set([step.as]),
      };
      step.do.forEach((item, j) => {
        if (item.with !== undefined) {
          checkValue(item.with, `${stepPath}/do/${j}/with`, innerCtx, errors);
        }
      });
      // for-each itself doesn't bind a result.
    }
  });

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}
