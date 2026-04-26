/**
 * procedures_execute — Phase 5 effect-verified procedure replay.
 *
 * Loads a saved procedure, substitutes {{var}} input placeholders, then
 * replays each step by dispatching the corresponding browser_* tool call
 * through the extension WebSocket. After each step the observed page_effect
 * is checked against the step's expected_effect (if present) using loose
 * assertions. Any divergence halts execution and returns a structured report.
 *
 * Execution rules:
 *   - ForEach steps are skipped (not yet supported; logged as warning).
 *   - Steps without expected_effect auto-match.
 *   - Tool call errors halt execution immediately.
 *   - continue_on_warning is reserved for Phase 6; Phase 5 always halts on
 *     the first mismatch.
 *   - max_steps defaults to the total step count of the loaded procedure.
 */

import YAML from "yaml";
import type { ProcedureDef, ActionStepDef, ForEachStepDef } from "@browserops/shared";
import type { PageEffect } from "@browserops/shared";
import { CodedError } from "./store.js";
import { handleGet } from "./handlers.js";
import { checkExpectation } from "./expected-effect.js";
import type { WSBridgeLike } from "../mcp-server.js";
import { TOOL_DEF_MAP, DEFAULT_TOOL_TIMEOUT_MS, NAVIGATE_TIMEOUT_MS, WAIT_FOR_TIMEOUT_CAP_MS } from "@browserops/shared";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface StepResult {
  id: string;
  action: string;
  observed_effect?: PageEffect;
  matched: boolean;
  warnings?: string[];
}

export interface DivergenceInfo {
  step_id: string;
  step_index: number;
  reason: string;
  observed?: PageEffect;
  expected?: unknown;
}

export interface ExecuteResult {
  completed: boolean;
  steps_executed: number;
  step_results: StepResult[];
  final_step?: {
    id: string;
    observed_effect?: PageEffect;
    expected_effect?: unknown;
    divergence?: string;
  };
  divergence?: DivergenceInfo;
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

/**
 * Recursively substitute `{{varName}}` placeholders in a value using the
 * provided inputs map. String values are scanned; objects and arrays are
 * traversed recursively. Non-string scalars are returned as-is.
 */
function substituteVars(
  value: unknown,
  inputs: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{([^}]+)\}\}/g, (match, key: string) => {
      const trimmed = key.trim();
      if (Object.prototype.hasOwnProperty.call(inputs, trimmed)) {
        const v = inputs[trimmed];
        return typeof v === "string" ? v : JSON.stringify(v);
      }
      return match; // leave unresolved placeholders as-is
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteVars(item, inputs));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = substituteVars(v, inputs);
    }
    return result;
  }
  return value;
}

// ---------------------------------------------------------------------------
// page_effect extractor
// ---------------------------------------------------------------------------

function extractPageEffect(value: unknown): PageEffect | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const pe = (value as Record<string, unknown>)["page_effect"];
  if (pe == null || typeof pe !== "object") return undefined;
  return pe as PageEffect;
}

// ---------------------------------------------------------------------------
// Timeout resolution (mirrors mcp-server.ts)
// ---------------------------------------------------------------------------

function timeoutFor(toolName: string, params: Record<string, unknown>): number {
  if (toolName === "browser_navigate") return NAVIGATE_TIMEOUT_MS;
  if (toolName === "browser_wait_for") {
    const raw = params["timeout_ms"];
    const provided = typeof raw === "number" ? raw : DEFAULT_TOOL_TIMEOUT_MS;
    return Math.min(provided, WAIT_FOR_TIMEOUT_CAP_MS);
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Type guard for action vs for-each steps
// ---------------------------------------------------------------------------

function isForEachStep(step: ActionStepDef | ForEachStepDef): step is ForEachStepDef {
  return "for_each" in step;
}

// ---------------------------------------------------------------------------
// handleExecute
// ---------------------------------------------------------------------------

export function makeExecuteHandler(wsBridge: WSBridgeLike) {
  return async function handleExecute(
    raw: Record<string, unknown>,
  ): Promise<ExecuteResult> {
    // ---- Parameter validation ----

    const name = raw["name"];
    if (typeof name !== "string" || name.length === 0) {
      throw new CodedError("INVALID_PARAMS", "name must be a non-empty string");
    }
    if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(name)) {
      throw new CodedError(
        "INVALID_PARAMS",
        `name must match ^[a-z][a-z0-9_.-]{0,79}$ — got: ${name}`,
      );
    }

    const inputs: Record<string, unknown> =
      raw["inputs"] !== undefined && raw["inputs"] !== null
        ? (() => {
            if (typeof raw["inputs"] !== "object" || Array.isArray(raw["inputs"])) {
              throw new CodedError("INVALID_PARAMS", "inputs must be an object");
            }
            return raw["inputs"] as Record<string, unknown>;
          })()
        : {};

    const continueOnWarning =
      raw["continue_on_warning"] !== undefined
        ? (() => {
            if (typeof raw["continue_on_warning"] !== "boolean") {
              throw new CodedError("INVALID_PARAMS", "continue_on_warning must be a boolean");
            }
            return raw["continue_on_warning"];
          })()
        : false;

    // Suppress unused variable warning — reserved for Phase 6
    void continueOnWarning;

    const maxStepsRaw = raw["max_steps"];
    const maxStepsProvided =
      maxStepsRaw !== undefined
        ? (() => {
            if (typeof maxStepsRaw !== "number" || !Number.isInteger(maxStepsRaw) || maxStepsRaw < 1) {
              throw new CodedError("INVALID_PARAMS", "max_steps must be a positive integer");
            }
            return maxStepsRaw;
          })()
        : undefined;

    // ---- Load procedure ----

    const getResult = await handleGet({ name });
    let parsed: unknown;
    try {
      parsed = YAML.parse(getResult.yaml);
    } catch (e) {
      throw new CodedError(
        "PROC_SCHEMA_INVALID",
        `YAML parse error: ${(e as Error).message}`,
        { name },
      );
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new CodedError("PROC_SCHEMA_INVALID", "parsed procedure YAML must be an object");
    }

    const procedure = parsed as ProcedureDef;

    // ---- Resolve max_steps ----

    const maxSteps = maxStepsProvided ?? procedure.steps.length;

    // ---- Extension connectivity check ----

    if (!wsBridge.isConnected()) {
      throw new CodedError(
        "EXTENSION_DISCONNECTED",
        "no active extension connection",
      );
    }

    // ---- Execute steps ----

    const stepResults: StepResult[] = [];
    let stepsExecuted = 0;

    for (let i = 0; i < procedure.steps.length; i++) {
      if (stepsExecuted >= maxSteps) break;

      const step = procedure.steps[i]!;

      // Skip for-each steps — not supported in Phase 5
      if (isForEachStep(step)) {
        stepResults.push({
          id: step.id,
          action: "(for_each — skipped)",
          matched: true,
          warnings: ["for_each steps are not executed by procedures_execute"],
        });
        stepsExecuted++;
        continue;
      }

      const actionStep = step as ActionStepDef;
      const toolName = actionStep.action;

      // Substitute {{var}} placeholders in step params
      const rawWith = actionStep.with ?? {};
      const substitutedWith = substituteVars(rawWith, inputs) as Record<string, unknown>;

      // Validate tool exists
      const toolDef = TOOL_DEF_MAP[toolName];
      if (!toolDef) {
        const result: StepResult = {
          id: actionStep.id,
          action: toolName,
          matched: false,
          warnings: [`unknown tool: ${toolName}`],
        };
        stepResults.push(result);
        stepsExecuted++;
        return {
          completed: false,
          steps_executed: stepsExecuted,
          step_results: stepResults,
          final_step: {
            id: actionStep.id,
            divergence: `unknown tool: ${toolName}`,
          },
          divergence: {
            step_id: actionStep.id,
            step_index: i,
            reason: `unknown tool: ${toolName}`,
            observed: undefined,
            expected: actionStep.expected_effect,
          },
        };
      }

      // Call extension
      let toolResult: unknown;
      try {
        const timeoutMs = timeoutFor(toolName, substitutedWith);
        toolResult = await wsBridge.callExtension(toolName, substitutedWith, timeoutMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result: StepResult = {
          id: actionStep.id,
          action: toolName,
          matched: false,
          warnings: [`tool call error: ${message}`],
        };
        stepResults.push(result);
        stepsExecuted++;
        return {
          completed: false,
          steps_executed: stepsExecuted,
          step_results: stepResults,
          final_step: {
            id: actionStep.id,
            divergence: `tool call error: ${message}`,
          },
          divergence: {
            step_id: actionStep.id,
            step_index: i,
            reason: `tool call error: ${message}`,
            observed: undefined,
            expected: actionStep.expected_effect,
          },
        };
      }

      // Extract observed page_effect
      const observedEffect = extractPageEffect(toolResult);

      // Check expectation
      const check = checkExpectation(actionStep.expected_effect, observedEffect);

      const stepResult: StepResult = {
        id: actionStep.id,
        action: toolName,
        observed_effect: observedEffect,
        matched: check.matched,
      };

      stepResults.push(stepResult);
      stepsExecuted++;

      if (!check.matched) {
        return {
          completed: false,
          steps_executed: stepsExecuted,
          step_results: stepResults,
          final_step: {
            id: actionStep.id,
            observed_effect: observedEffect,
            expected_effect: actionStep.expected_effect,
            divergence: check.reason,
          },
          divergence: {
            step_id: actionStep.id,
            step_index: i,
            reason: check.reason,
            observed: observedEffect,
            expected: actionStep.expected_effect,
          },
        };
      }
    }

    // All steps completed (or max_steps reached without divergence)
    const lastStep = stepResults[stepResults.length - 1];
    return {
      completed: true,
      steps_executed: stepsExecuted,
      step_results: stepResults,
      final_step: lastStep
        ? {
            id: lastStep.id,
            observed_effect: lastStep.observed_effect,
          }
        : undefined,
    };
  };
}
