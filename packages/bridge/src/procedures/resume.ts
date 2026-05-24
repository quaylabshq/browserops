/**
 * procedures_resume — apply a caller-supplied patch to a suspended procedure
 * execution and continue.
 *
 * Three patch kinds:
 *   resume_with   — merge {locator?, with?} into the failing step and re-run
 *   insert_steps  — execute a list of corrective steps, then continue from the
 *                   next procedure step
 *   give_up       — drop state and return a `gave_up` outcome
 *
 * Every step the patch introduces flows through the same `checkForbidden`
 * guard as a normal dispatch — the LLM cannot bypass author-declared
 * safety bars by going through this path.
 */
import type {
  Locator,
  ProcedureDef,
  StepDef,
} from "@browserops/shared";
import { isLocatorEmpty } from "@browserops/shared";

import { CodedError } from "./store.js";
import { dropState, getState, type ExecutionState } from "./state.js";
import {
  runProcedure,
  type ExecuteOutcome,
  type RunProcedureContext,
} from "./execute.js";
import { checkForbidden } from "./forbidden.js";
import { validateProcedure } from "./validator.js";
import type { WSBridgeLike } from "../mcp-server.js";

export type ResumePatch =
  | {
      kind: "resume_with";
      with?: {
        locator?: Locator;
        params?: Record<string, unknown>;
      };
    }
  | {
      kind: "insert_steps";
      steps: StepDef[];
    }
  | { kind: "give_up"; reason?: string };

interface ResumeParams {
  execution_id: string;
  patch: ResumePatch;
}

function parseParams(raw: Record<string, unknown>): ResumeParams {
  const id = raw["execution_id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new CodedError(
      "INVALID_PARAMS",
      "execution_id must be a non-empty string",
    );
  }
  const patchRaw = raw["patch"];
  if (typeof patchRaw !== "object" || patchRaw === null || Array.isArray(patchRaw)) {
    throw new CodedError("INVALID_PARAMS", "patch must be an object");
  }
  const patch = patchRaw as Record<string, unknown>;
  const kind = patch["kind"];
  if (kind === "resume_with") {
    const withField = patch["with"];
    const result: ResumePatch = { kind: "resume_with" };
    if (withField !== undefined && withField !== null) {
      if (typeof withField !== "object" || Array.isArray(withField)) {
        throw new CodedError("INVALID_PARAMS", "patch.with must be an object");
      }
      const w = withField as Record<string, unknown>;
      const out: { locator?: Locator; params?: Record<string, unknown> } = {};
      if (w["locator"] !== undefined && w["locator"] !== null) {
        if (typeof w["locator"] !== "object" || Array.isArray(w["locator"])) {
          throw new CodedError(
            "INVALID_PARAMS",
            "patch.with.locator must be an object",
          );
        }
        out.locator = w["locator"] as Locator;
      }
      if (w["params"] !== undefined && w["params"] !== null) {
        if (typeof w["params"] !== "object" || Array.isArray(w["params"])) {
          throw new CodedError(
            "INVALID_PARAMS",
            "patch.with.params must be an object",
          );
        }
        out.params = w["params"] as Record<string, unknown>;
      }
      result.with = out;
    }
    return { execution_id: id, patch: result };
  }
  if (kind === "insert_steps") {
    const stepsRaw = patch["steps"];
    if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
      throw new CodedError(
        "INVALID_PARAMS",
        "patch.steps must be a non-empty array",
      );
    }
    if (stepsRaw.length > 10) {
      throw new CodedError(
        "INVALID_PARAMS",
        "patch.steps may contain at most 10 entries per resume call",
      );
    }
    return {
      execution_id: id,
      patch: {
        kind: "insert_steps",
        steps: stepsRaw as StepDef[],
      },
    };
  }
  if (kind === "give_up") {
    const reason = patch["reason"];
    const out: ResumePatch = { kind: "give_up" };
    if (typeof reason === "string") out.reason = reason;
    return { execution_id: id, patch: out };
  }
  throw new CodedError(
    "PROCEDURE_RESUME_INVALID",
    `patch.kind must be one of: resume_with, insert_steps, give_up — got: ${String(kind)}`,
  );
}

export function makeResumeHandler(wsBridge: WSBridgeLike) {
  return async function handleResume(
    raw: Record<string, unknown>,
  ): Promise<ExecuteOutcome> {
    const params = parseParams(raw);
    const state = getState(params.execution_id);
    if (state === undefined) {
      throw new CodedError(
        "PROCEDURE_RESUME_EXPIRED",
        `execution ${params.execution_id} is unknown or has expired`,
        { execution_id: params.execution_id },
      );
    }

    if (params.patch.kind === "give_up") {
      dropState(state.execution_id);
      return {
        completed: false,
        status: "gave_up",
        steps_executed: state.step_results.length,
        step_results: state.step_results,
        used_llm_fallback: state.used_llm_fallback,
      };
    }

    // Strict mode forbids LLM fallback patches. The path here only fires
    // if the state was created with strict:false; defence in depth in case
    // the caller forced state under unusual circumstances.
    if (state.strict) {
      dropState(state.execution_id);
      throw new CodedError(
        "PROCEDURE_RESUME_INVALID",
        "cannot resume a strict-mode execution via LLM patch",
        { execution_id: params.execution_id },
      );
    }

    const procedure = applyPatchToProcedure(state, params.patch);

    // Run the same execute loop, starting at the suspended step. The
    // patch produced a new in-memory procedure with the relocated /
    // inserted steps; runProcedure handles substitution + forbidden +
    // dispatch like any other run.
    dropState(state.execution_id);

    const ctx: RunProcedureContext = {
      procedure: procedure,
      tab_id: state.tab_id,
      inputs: state.inputs,
      strict: state.strict,
      max_tool_calls: Math.max(0, 25 - state.budget.consumed_tool_calls),
      wsBridge,
      step_results: state.step_results.slice(),
      start_at: state.paused_at,
      binds: {},
      budget: { ...state.budget },
      used_llm_fallback: state.used_llm_fallback,
    };

    return runProcedure(ctx);
  };
}

/**
 * Apply a resume_with or insert_steps patch to the saved procedure, in
 * memory only. The original on-disk YAML is never modified.
 */
function applyPatchToProcedure(
  state: ExecutionState,
  patch: Exclude<ResumePatch, { kind: "give_up" }>,
): ProcedureDef {
  const next: ProcedureDef = {
    ...state.procedure,
    steps: state.procedure.steps.slice(),
  };

  if (patch.kind === "resume_with") {
    const idx = state.paused_at;
    const step = next.steps[idx];
    if (!step) {
      throw new CodedError(
        "PROCEDURE_RESUME_INVALID",
        `paused_at index ${idx} is out of bounds (steps=${next.steps.length})`,
      );
    }
    const newStep: StepDef = { ...step };
    if (patch.with?.locator !== undefined) {
      if (isLocatorEmpty(patch.with.locator)) {
        throw new CodedError(
          "PROCEDURE_RESUME_INVALID",
          "patch.with.locator must declare at least one field",
        );
      }
      const forbid = checkForbidden(state.procedure.forbidden, {
        action: step.do,
        locator: patch.with.locator,
      });
      if (!forbid.allowed) {
        throw new CodedError(
          "PROCEDURE_FORBIDDEN",
          `LLM patch refused: ${forbid.reason ?? "forbidden"}`,
        );
      }
      newStep.locator = patch.with.locator;
    }
    if (patch.with?.params !== undefined) {
      newStep.with = { ...(step.with ?? {}), ...patch.with.params };
    }
    next.steps[idx] = newStep;
    return next;
  }

  // insert_steps
  if (patch.kind === "insert_steps") {
    // Validate each step shape against the schema by spinning up a temp
    // procedure around the steps.
    const probe: ProcedureDef = {
      schema_version: 1,
      name: state.procedure.name,
      description: "_probe_",
      kind: "leaf",
      steps: patch.steps,
    };
    const result = validateProcedure(probe);
    if (!result.valid) {
      throw new CodedError(
        "PROCEDURE_RESUME_INVALID",
        `inserted steps failed validation: ${(result.errors ?? []).join("; ")}`,
      );
    }

    // Forbidden check each step.
    for (const step of patch.steps) {
      const forbid = checkForbidden(state.procedure.forbidden, {
        action: step.do,
        locator: step.locator,
      });
      if (!forbid.allowed) {
        throw new CodedError(
          "PROCEDURE_FORBIDDEN",
          `inserted step ${step.id} refused: ${forbid.reason ?? "forbidden"}`,
        );
      }
    }

    next.steps.splice(state.paused_at, 0, ...patch.steps);
    return next;
  }

  // Exhaustive — TS knows give_up was peeled off above.
  throw new CodedError("PROCEDURE_RESUME_INVALID", "unknown patch kind");
}
