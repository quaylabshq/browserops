/**
 * Procedure execute loop.
 *
 * One run = one entry into `executeProcedure`. The runtime:
 *
 *   1. Loads + validates the procedure YAML.
 *   2. Builds the inputs map (applies defaults, refuses unknowns).
 *   3. For each step:
 *        a. Run the forbidden guard.
 *        b. If step.locator → call browser_locate to get a ref. On miss,
 *           hand to the fallback ladder (retry → relocate → llm).
 *        c. Dispatch the underlying browser_* primitive via wsBridge,
 *           with the resolved ref substituted into the with: map.
 *        d. Build an Observation snapshot, poll the step's expect block.
 *           Same fallback ladder on miss.
 *   4. After the last step, evaluate top-level verify (no retry — one shot
 *      against the live state).
 *
 * Strict mode (caller-supplied) overrides every step's fallback to
 * "strict" — never invokes retry/relocate/llm even if declared. Used by
 * CI / batch jobs and for `bump_success: true` promotion.
 */

import YAML from "yaml";
import type {
  ProcedureDef,
  StepDef,
  FallbackStrategy,
  PageEffect,
} from "@browserops/shared";
import { TOOL_DEF_MAP } from "@browserops/shared";
import { DEFAULT_TOOL_TIMEOUT_MS, NAVIGATE_TIMEOUT_MS } from "@browserops/shared";
import { isLocatorEmpty } from "@browserops/shared";
import { classifyLocator } from "@browserops/shared";
import type { Locator, HealthDef } from "@browserops/shared";

import type { WSBridgeLike } from "../mcp-server.js";

import * as path from "node:path";
import { CodedError, readProcedureYaml } from "./store.js";
import { ensureIndex } from "./index-builder.js";
import { proceduresRoot } from "./paths.js";
import { validateProcedure } from "./validator.js";
import { substituteVars } from "./substitute.js";
import { checkForbidden } from "./forbidden.js";
import {
  pollExpect,
  type Observation,
} from "./expectation.js";
import type { StepResult, DivergenceInfo } from "./execute-types.js";
import { createState, type ExecutionState } from "./state.js";
import { applyRetry, applyRelocate } from "./fallback.js";
import { emptyHealth, recordResolution } from "./health.js";
import { mergeHealthIntoProcedureYaml } from "./health-merge.js";
import { writeProcedureYamlAtomic } from "./store.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ExecuteOutcome {
  completed: boolean;
  status: "completed" | "needs_assist" | "gave_up" | "halted";
  steps_executed: number;
  step_results: StepResult[];
  divergence?: DivergenceInfo;
  execution_id?: string;
  envelope?: ResumeEnvelope;
  used_llm_fallback: boolean;
  verify_passed?: boolean;
}

export interface ResumeEnvelope {
  procedure_name: string;
  step_id: string;
  step_index: number;
  step_goal?: string;
  procedure_progress: string;
  last_attempt: {
    action: string;
    locator_descriptor?: unknown;
    resolution_attempts: string[];
    page_effect?: PageEffect;
  };
  viewport_summary?: string;
  available_actions: ReadonlyArray<"resume_with" | "insert_steps" | "give_up">;
  constraints: {
    side_effects_allowed: string[];
    forbidden_locators: unknown[];
    forbidden_actions: string[];
    max_tool_calls: number;
    max_tokens: number;
  };
  remaining_steps_preview: Array<{ id: string; do: string; goal?: string }>;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export interface ExecuteParams {
  name: string;
  tab_id: string;
  inputs?: Record<string, unknown>;
  /** When true, refuse to invoke LLM fallback even if a step declares it. */
  strict?: boolean;
  /** Optional cap on tool_calls across all LLM-fallback attempts. */
  max_tool_calls?: number;
}

/**
 * Optional in-process dispatcher. When provided, the execute loop routes
 * `procedure_call` and `procedure_call` step actions through this function
 * instead of wsBridge — which lets a procedure compose with procedures and
 * other procedures without round-tripping through the extension.
 */
export type InProcessDispatch = (
  toolName: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

export function makeProcedureExecutor(
  wsBridge: WSBridgeLike,
  inProcessDispatch?: InProcessDispatch,
) {
  return async function executeProcedure(
    raw: Record<string, unknown>,
  ): Promise<ExecuteOutcome> {
    const params = parseParams(raw);

    const procedure = await loadProcedure(params.name);
    const inputs = params.inputs;

    return runProcedure({
      procedure: procedure,
      tab_id: params.tab_id,
      inputs,
      strict: params.strict ?? false,
      max_tool_calls: params.max_tool_calls ?? 25,
      wsBridge,
      inProcessDispatch,
      step_results: [],
      start_at: 0,
      binds: {},
      budget: { consumed_tool_calls: 0, consumed_tokens: 0 },
      used_llm_fallback: false,
    });
  };
}

// ---------------------------------------------------------------------------
// Params parsing
// ---------------------------------------------------------------------------

interface ParsedExecuteParams {
  name: string;
  tab_id: string;
  inputs: Record<string, unknown>;
  strict?: boolean;
  max_tool_calls?: number;
}

function parseParams(raw: Record<string, unknown>): ParsedExecuteParams {
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
  const tab_id = raw["tab_id"];
  if (typeof tab_id !== "string" || tab_id.length === 0) {
    throw new CodedError("INVALID_PARAMS", "tab_id must be a non-empty string");
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

  // tab_id is also available as {{tab_id}} via substitution
  if (inputs["tab_id"] === undefined) inputs["tab_id"] = tab_id;

  const result: ParsedExecuteParams = { name, tab_id, inputs };

  if (raw["strict"] !== undefined) {
    if (typeof raw["strict"] !== "boolean") {
      throw new CodedError("INVALID_PARAMS", "strict must be a boolean");
    }
    result.strict = raw["strict"];
  }

  if (raw["max_tool_calls"] !== undefined) {
    const m = raw["max_tool_calls"];
    if (typeof m !== "number" || !Number.isInteger(m) || m < 0) {
      throw new CodedError(
        "INVALID_PARAMS",
        "max_tool_calls must be a non-negative integer",
      );
    }
    result.max_tool_calls = m;
  }

  return result;
}

/**
 * Best-effort write-back of accumulated drift health into the procedure
 * YAML's meta.health. Swallows errors — health is auxiliary; a failed
 * disk write must not fail the run.
 */
async function flushHealth(
  procedureName: string,
  health: HealthDef,
): Promise<void> {
  if (Object.keys(health.steps).length === 0) return;
  try {
    const root = proceduresRoot();
    const manifest = await ensureIndex(root);
    const entry = manifest.procedures[procedureName];
    if (!entry) return;
    const absPath = path.join(root, entry.path);
    const text = await readProcedureYaml(absPath);
    const merged = mergeHealthIntoProcedureYaml(text, health);
    if (merged === text) return;
    await writeProcedureYamlAtomic(absPath, merged);
  } catch {
    // Health write-back is best-effort.
  }
}

async function loadProcedure(name: string): Promise<ProcedureDef> {
  const root = proceduresRoot();
  const manifest = await ensureIndex(root);
  const entry = manifest.procedures[name];
  if (!entry) {
    throw new CodedError("PROCEDURE_NOT_FOUND", `procedure not found: ${name}`, {
      name,
    });
  }

  const absPath = path.join(root, entry.path);
  const text = await readProcedureYaml(absPath);
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (e) {
    throw new CodedError(
      "PROCEDURE_SCHEMA_INVALID",
      `YAML parse error: ${(e as Error).message}`,
      { name },
    );
  }

  const validation = validateProcedure(parsed);
  if (!validation.valid) {
    throw new CodedError(
      "PROCEDURE_SCHEMA_INVALID",
      `schema validation failed: ${(validation.errors ?? []).join("; ")}`,
      { name },
    );
  }

  return parsed as ProcedureDef;
}

// ---------------------------------------------------------------------------
// Runner — pulled out so handleResume can re-enter the loop with state
// ---------------------------------------------------------------------------

export interface RunProcedureContext {
  procedure: ProcedureDef;
  tab_id: string;
  inputs: Record<string, unknown>;
  strict: boolean;
  max_tool_calls: number;
  wsBridge: WSBridgeLike;
  inProcessDispatch?: InProcessDispatch;
  step_results: StepResult[];
  start_at: number;
  binds: Record<string, unknown>;
  budget: { consumed_tool_calls: number; consumed_tokens: number };
  used_llm_fallback: boolean;
}

export async function runProcedure(
  ctx: RunProcedureContext,
): Promise<ExecuteOutcome> {
  const { procedure, tab_id, inputs, strict, wsBridge } = ctx;

  if (!wsBridge.isConnected()) {
    throw new CodedError(
      "EXTENSION_DISCONNECTED",
      "no active extension connection",
    );
  }

  const stepResults = ctx.step_results;

  // Per-run health accumulator. Folded back into the on-disk procedure's
  // meta.health when the run terminates (any of completed / halted /
  // needs_assist / verify-failed). Health updates are best-effort — a
  // disk write failure does not fail the run.
  const nowIso = new Date().toISOString();
  let healthAccum: HealthDef = emptyHealth(nowIso);

  for (let i = ctx.start_at; i < procedure.steps.length; i++) {
    const step = procedure.steps[i]!;

    // Forbidden guard (pre-substitution)
    const forbiddenCheck = checkForbidden(procedure.forbidden, {
      action: step.do,
      locator: step.locator,
    });
    if (!forbiddenCheck.allowed) {
      const div: DivergenceInfo = {
        step_id: step.id,
        step_index: i,
        reason: `forbidden: ${forbiddenCheck.reason}`,
      };
      stepResults.push({
        id: step.id,
        action: step.do,
        matched: false,
        resolved_by: "halted",
        warnings: [forbiddenCheck.reason ?? "forbidden"],
      });
      await flushHealth(procedure.name, healthAccum);
      return haltedOutcome(stepResults, div, ctx.used_llm_fallback);
    }

    const { ok, divergence, observation, attempts, resolvedBy, resolution } =
      await tryStepOnce(ctx, step, i);

    if (!ok) {
      // Fallback ladder lands here in Phase 6/7. For Phase 5 we just halt.
      const strategy = resolveStrategy(step, strict);
      const fallbackResult = await tryFallback(ctx, step, i, divergence, strategy);
      if (fallbackResult.ok) {
        stepResults.push(fallbackResult.stepResult);
        if (typeof step.bind === "string" && step.bind.length > 0 && fallbackResult.observation) {
          ctx.binds[step.bind] = fallbackResult.observation;
        }
        if (fallbackResult.resolution) {
          healthAccum = recordResolution(
            healthAccum,
            step.id,
            {
              matched_ref: fallbackResult.resolution.matched_ref,
              match_count: fallbackResult.resolution.match_count,
              tier: classifyLocator(fallbackResult.resolution.locator_used) ?? 3,
              used_relocate: fallbackResult.usedRelocate === true,
            },
            nowIso,
          );
        }
        continue;
      }
      if (fallbackResult.needsAssist) {
        // Phase 7 lands the actual envelope handoff. Surface here so the
        // executor doesn't pretend the run completed.
        stepResults.push(fallbackResult.stepResult);
        const envelope = buildEnvelope(procedure, step, i, fallbackResult.divergence, ctx);
        const state = createState({
          procedure: procedure,
          tab_id,
          inputs,
          paused_at: i,
          step_results: stepResults.slice(),
          divergence: fallbackResult.divergence,
          strict,
          budget: ctx.budget,
          used_llm_fallback: ctx.used_llm_fallback,
        });
        await flushHealth(procedure.name, healthAccum);
        return {
          completed: false,
          status: "needs_assist",
          steps_executed: stepResults.length,
          step_results: stepResults,
          divergence: fallbackResult.divergence,
          execution_id: state.execution_id,
          envelope,
          used_llm_fallback: ctx.used_llm_fallback,
        };
      }
      stepResults.push(fallbackResult.stepResult);
      await flushHealth(procedure.name, healthAccum);
      return haltedOutcome(stepResults, fallbackResult.divergence, ctx.used_llm_fallback);
    }

    stepResults.push({
      id: step.id,
      action: step.do,
      matched: true,
      observed: observation,
      attempts,
      resolved_by: resolvedBy,
    });
    if (typeof step.bind === "string" && step.bind.length > 0 && observation) {
      ctx.binds[step.bind] = observation;
    }
    if (resolution) {
      healthAccum = recordResolution(
        healthAccum,
        step.id,
        {
          matched_ref: resolution.matched_ref,
          match_count: resolution.match_count,
          tier: classifyLocator(resolution.locator_used) ?? 3,
          used_relocate: false,
        },
        nowIso,
      );
    }
    void inputs;
  }

  // Top-level verify
  let verifyPassed: boolean | undefined;
  if (procedure.verify !== undefined) {
    const obs = await captureObservation(ctx, undefined);
    const verify = await pollExpect(procedure.verify, async () => obs);
    verifyPassed = verify.matched;
    if (!verify.matched) {
      await flushHealth(procedure.name, healthAccum);
      return {
        completed: false,
        status: "halted",
        steps_executed: stepResults.length,
        step_results: stepResults,
        divergence: {
          step_id: "(verify)",
          step_index: procedure.steps.length,
          reason: `verify failed: ${verify.reason ?? "no reason"}`,
        },
        used_llm_fallback: ctx.used_llm_fallback,
        verify_passed: false,
      };
    }
  }

  await flushHealth(procedure.name, healthAccum);
  return {
    completed: true,
    status: "completed",
    steps_executed: stepResults.length,
    step_results: stepResults,
    used_llm_fallback: ctx.used_llm_fallback,
    verify_passed: verifyPassed,
  };
}

// ---------------------------------------------------------------------------
// Step execution — single attempt
// ---------------------------------------------------------------------------

interface StepAttemptResult {
  ok: boolean;
  divergence?: DivergenceInfo;
  observation?: unknown;
  attempts: number;
  resolvedBy?: StepResult["resolved_by"];
  /** Health snapshot from the resolve — only present when step.locator was used. */
  resolution?: {
    matched_ref: number;
    match_count: number;
    locator_used: Locator;
  };
}

async function tryStepOnce(
  ctx: RunProcedureContext,
  step: StepDef,
  index: number,
): Promise<StepAttemptResult> {
  const { tab_id, inputs, binds, wsBridge } = ctx;

  // Resolve locator → ref if step.locator is present and non-empty.
  let resolvedRef: number | undefined;
  let resolvedLocator: unknown = step.locator;
  let resolution: StepAttemptResult["resolution"] | undefined;

  if (step.locator !== undefined && !isLocatorEmpty(step.locator)) {
    const substituted = substituteVars(step.locator, inputs, binds);
    resolvedLocator = substituted;

    const autoTimeout = step.auto_wait?.timeout_ms ?? 4000;

    // Auto-prime the ref-cache before every locate. In v1 the extension
    // side does not seed the cache from browser_observe, and SPA hash
    // transitions (e.g. Gmail's #inbox → #inbox?compose=new) invalidate
    // the snapshot via chrome.webNavigation.onHistoryStateUpdated. Doing
    // the read here matches the contract that locate.ts already advertises
    // in its module doc ("The procedure executor on the bridge takes care
    // of refreshing the snapshot via browser_read before each locate
    // call"). The cost is one a11y_tree read per locator step — cheap
    // compared to a needless LLM-fallback round-trip.
    try {
      await wsBridge.callExtension(
        "browser_read",
        { tab_id, mode: "a11y_tree", scope: "viewport", augment: true },
        DEFAULT_TOOL_TIMEOUT_MS,
      );
    } catch {
      // A failed prime is not fatal — browser_locate will surface its
      // own LOCATOR_NOT_FOUND if the cache is genuinely empty.
    }

    try {
      const locateResult = await wsBridge.callExtension<{
        matches: Array<{ ref: number; role: string; name: string; selector: string }>;
      }>(
        "browser_locate",
        { tab_id, locator: substituted },
        autoTimeout,
      );
      const first = locateResult.matches[0];
      if (!first) {
        return {
          ok: false,
          attempts: 1,
          divergence: {
            step_id: step.id,
            step_index: index,
            reason: "locator matched no elements",
            locator: substituted,
          },
        };
      }
      resolvedRef = first.ref;
      resolution = {
        matched_ref: first.ref,
        match_count: locateResult.matches.length,
        locator_used: substituted as Locator,
      };
    } catch (err) {
      const code = (err as { code?: string }).code ?? "INTERNAL";
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        attempts: 1,
        divergence: {
          step_id: step.id,
          step_index: index,
          reason: `browser_locate failed (${code}): ${message}`,
          locator: substituted,
        },
      };
    }
  }

  // Build with: params — substitute, then merge resolved ref/tab_id.
  const baseWith = step.with ?? {};
  const substitutedWith = substituteVars(baseWith, inputs, binds) as Record<
    string,
    unknown
  >;
  const finalWith: Record<string, unknown> = { ...substitutedWith };
  if (finalWith["tab_id"] === undefined) finalWith["tab_id"] = tab_id;
  if (resolvedRef !== undefined && finalWith["ref"] === undefined) {
    finalWith["ref"] = resolvedRef;
  }

  // Map step.do to the actual MCP tool name.
  const toolName = mapStepDoToToolName(step.do);
  const toolDef = TOOL_DEF_MAP[toolName];
  if (!toolDef) {
    return {
      ok: false,
      attempts: 1,
      divergence: {
        step_id: step.id,
        step_index: index,
        reason: `unknown tool for do: ${step.do}`,
      },
    };
  }

  // Dispatch — in-process for procedure_call when an in-process dispatcher
  // is wired (handlers builder sets it up). Falls through to the wsBridge
  // for browser_* primitives.
  let toolResult: unknown;
  const isInProcessCall =
    step.do === "procedure_call" && ctx.inProcessDispatch !== undefined;
  try {
    if (isInProcessCall) {
      toolResult = await ctx.inProcessDispatch!(toolName, finalWith);
    } else {
      const timeoutMs = toolName === "browser_navigate" ? NAVIGATE_TIMEOUT_MS : DEFAULT_TOOL_TIMEOUT_MS;
      toolResult = await wsBridge.callExtension(toolName, finalWith, timeoutMs);
    }
  } catch (err) {
    const code = (err as { code?: string }).code ?? "INTERNAL";
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      attempts: 1,
      divergence: {
        step_id: step.id,
        step_index: index,
        reason: `dispatch failed (${code}): ${message}`,
        locator: resolvedLocator,
      },
    };
  }

  // Expect polling
  if (step.expect !== undefined) {
    const polled = await pollExpect(step.expect, async () =>
      buildObservation(toolResult),
    );
    if (!polled.matched) {
      return {
        ok: false,
        attempts: 1,
        observation: toolResult,
        divergence: {
          step_id: step.id,
          step_index: index,
          reason: `expect failed: ${polled.reason ?? "no reason"}`,
          observed: polled.observed,
          expected: step.expect,
          locator: resolvedLocator,
        },
      };
    }
  }

  return {
    ok: true,
    attempts: 1,
    observation: toolResult,
    resolvedBy: "first_try",
    ...(resolution ? { resolution } : {}),
  };
}

// ---------------------------------------------------------------------------
// Fallback ladder (Phase 6+7 expand this; Phase 5 lands the strict path)
// ---------------------------------------------------------------------------

interface FallbackResult {
  ok: boolean;
  needsAssist?: boolean;
  divergence: DivergenceInfo;
  stepResult: StepResult;
  observation?: unknown;
  resolution?: StepAttemptResult["resolution"];
  usedRelocate?: boolean;
}

function resolveStrategy(
  step: StepDef,
  strict: boolean,
): FallbackStrategy {
  if (strict) return "strict";
  return step.fallback?.strategy ?? "strict";
}

async function tryFallback(
  ctx: RunProcedureContext,
  step: StepDef,
  index: number,
  firstDivergence: DivergenceInfo | undefined,
  strategy: FallbackStrategy,
): Promise<FallbackResult> {
  let lastDivergence: DivergenceInfo =
    firstDivergence ?? {
      step_id: step.id,
      step_index: index,
      reason: "unknown divergence",
    };

  if (strategy === "strict") {
    return {
      ok: false,
      divergence: lastDivergence,
      stepResult: {
        id: step.id,
        action: step.do,
        matched: false,
        resolved_by: "halted",
        warnings: ["strict — no fallback attempted"],
      },
    };
  }

  // -------- retry strategy --------
  if (strategy === "retry") {
    let attempt = 0;
    let totalAttempts = 1;
    while (true) {
      const decision = applyRetry(step, attempt);
      if (decision.action === "give_up") break;
      if (!chargeBudget(ctx, step)) {
        lastDivergence = {
          ...lastDivergence,
          reason: `${lastDivergence.reason}; retry budget exhausted`,
        };
        break;
      }
      if (decision.backoff_ms > 0) {
        await new Promise((r) => setTimeout(r, decision.backoff_ms));
      }
      attempt = decision.attempt;
      totalAttempts += 1;
      const next = await tryStepOnce(ctx, step, index);
      if (next.ok) {
        return {
          ok: true,
          divergence: lastDivergence,
          observation: next.observation,
          stepResult: {
            id: step.id,
            action: step.do,
            matched: true,
            observed: next.observation,
            attempts: totalAttempts,
            resolved_by: "retry",
          },
          ...(next.resolution ? { resolution: next.resolution } : {}),
          usedRelocate: false,
        };
      }
      if (next.divergence) lastDivergence = next.divergence;
    }
    return {
      ok: false,
      divergence: lastDivergence,
      stepResult: {
        id: step.id,
        action: step.do,
        matched: false,
        attempts: totalAttempts,
        resolved_by: "halted",
      },
    };
  }

  // -------- relocate strategy (or first leg of relocate_then_llm) --------
  if (strategy === "relocate" || strategy === "relocate_then_llm") {
    const decision = applyRelocate(step);
    if (decision.action === "retry_with" && decision.locator !== undefined) {
      if (chargeBudget(ctx, step)) {
        const relocatedStep: StepDef = {
          ...step,
          locator: decision.locator,
        };
        const next = await tryStepOnce(ctx, relocatedStep, index);
        if (next.ok) {
          return {
            ok: true,
            divergence: lastDivergence,
            observation: next.observation,
            stepResult: {
              id: step.id,
              action: step.do,
              matched: true,
              observed: next.observation,
              attempts: 2,
              resolved_by: "relocate",
            },
            ...(next.resolution ? { resolution: next.resolution } : {}),
            usedRelocate: true,
          };
        }
        if (next.divergence) lastDivergence = next.divergence;
      } else {
        lastDivergence = {
          ...lastDivergence,
          reason: `${lastDivergence.reason}; relocate budget exhausted`,
        };
      }
    }

    if (strategy === "relocate") {
      return {
        ok: false,
        divergence: lastDivergence,
        stepResult: {
          id: step.id,
          action: step.do,
          matched: false,
          resolved_by: "halted",
        },
      };
    }
    // fall through to llm escalation
  }

  // -------- llm strategy (Phase 7 — halt + needs_assist) --------
  if (strategy === "llm" || strategy === "relocate_then_llm") {
    if (ctx.strict) {
      return {
        ok: false,
        divergence: lastDivergence,
        stepResult: {
          id: step.id,
          action: step.do,
          matched: false,
          resolved_by: "halted",
          warnings: ["llm fallback refused in strict mode"],
        },
      };
    }
    ctx.used_llm_fallback = true;
    return {
      ok: false,
      needsAssist: true,
      divergence: lastDivergence,
      stepResult: {
        id: step.id,
        action: step.do,
        matched: false,
        resolved_by: "llm",
      },
    };
  }

  return {
    ok: false,
    divergence: lastDivergence,
    stepResult: {
      id: step.id,
      action: step.do,
      matched: false,
      resolved_by: "halted",
      warnings: [`unhandled strategy ${strategy}`],
    },
  };
}

/**
 * Charge one tool_call from the per-step + per-run budgets.
 * Returns true if there was room, false when the budget is exhausted.
 */
function chargeBudget(
  ctx: RunProcedureContext,
  step: StepDef,
): boolean {
  const stepBudget = step.fallback?.budget?.tool_calls;
  if (typeof stepBudget === "number" && stepBudget <= 0) return false;

  ctx.budget.consumed_tool_calls += 1;
  if (ctx.budget.consumed_tool_calls > ctx.max_tool_calls) return false;
  // Decrement step budget by mutating step.fallback.budget? No — that
  // would mutate the procedure def. Track step-level usage via the per-
  // call divergence chain instead. Keeping the global cap is enough for
  // v1; step-level caps are a follow-up.
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function haltedOutcome(
  stepResults: StepResult[],
  divergence: DivergenceInfo,
  used_llm_fallback: boolean,
): ExecuteOutcome {
  return {
    completed: false,
    status: "halted",
    steps_executed: stepResults.length,
    step_results: stepResults,
    divergence,
    used_llm_fallback,
  };
}

function mapStepDoToToolName(stepDo: StepDef["do"]): string {
  switch (stepDo) {
    case "click":
      return "browser_click";
    case "type":
      return "browser_type";
    case "press":
      return "browser_press";
    case "hover":
      return "browser_hover";
    case "navigate":
      return "browser_navigate";
    case "scroll":
      return "browser_scroll";
    case "wait":
      return "browser_wait_for";
    case "observe":
      return "browser_observe";
    case "js":
      return "browser_execute_js";
    case "procedure_call":
      return "procedures_execute";
    case "procedure_call":
      return "procedures_execute";
  }
}

function buildObservation(toolResult: unknown): Observation | undefined {
  if (typeof toolResult !== "object" || toolResult === null) return undefined;
  const r = toolResult as Record<string, unknown>;

  const obs: Observation = {};

  const pe = r["page_effect"];
  if (pe !== undefined && pe !== null && typeof pe === "object") {
    obs.page_effect = pe as PageEffect;
  }

  const effect = r["effect"] as Record<string, unknown> | undefined;
  if (effect) {
    const network = effect["network"] as Record<string, unknown> | undefined;
    if (network && Array.isArray(network["endpoints"])) {
      obs.network_endpoints = network["endpoints"] as string[];
    }
    const dialogs = effect["new_dialogs"];
    if (Array.isArray(dialogs)) {
      obs.new_dialogs = dialogs as Array<{ name?: string; role?: string }>;
    }
    if (typeof effect["visual_hash_delta"] === "number") {
      obs.visual_hash_delta = effect["visual_hash_delta"] as number;
    }
    if (typeof effect["focus_moved_to"] === "string") {
      obs.focus_selector = effect["focus_moved_to"] as string;
    }
    if (typeof effect["console_errors"] === "number") {
      obs.console_errors = effect["console_errors"] as number;
    }
  }

  // browser_navigate returns the landed URL as `final_url`, not `url`.
  // Accept both so url_matches works on navigate steps as well as on
  // tools that surface `url` directly.
  if (typeof r["url"] === "string") obs.url = r["url"] as string;
  else if (typeof r["final_url"] === "string") obs.url = r["final_url"] as string;
  if (typeof r["title"] === "string") obs.title = r["title"] as string;

  return obs;
}

async function captureObservation(
  ctx: RunProcedureContext,
  baseResult: unknown,
): Promise<Observation | undefined> {
  void ctx;
  return buildObservation(baseResult);
}

// ---------------------------------------------------------------------------
// Resume envelope builder (Phase 7 fills in observation_token; this stub
// returns the structural envelope used by needs_assist).
// ---------------------------------------------------------------------------

export function buildEnvelope(
  procedure: ProcedureDef,
  step: StepDef,
  index: number,
  divergence: DivergenceInfo,
  ctx: RunProcedureContext,
): ResumeEnvelope {
  const remaining: ResumeEnvelope["remaining_steps_preview"] = [];
  for (let j = index + 1; j < procedure.steps.length && remaining.length < 5; j++) {
    const s = procedure.steps[j]!;
    const entry: { id: string; do: string; goal?: string } = {
      id: s.id,
      do: s.do,
    };
    if (s.goal !== undefined) entry.goal = s.goal;
    remaining.push(entry);
  }

  const envelope: ResumeEnvelope = {
    procedure_name: procedure.name,
    step_id: step.id,
    step_index: index,
    procedure_progress: `${index}/${procedure.steps.length} steps completed`,
    last_attempt: {
      action: step.do,
      resolution_attempts: [divergence.reason],
    },
    available_actions: ["resume_with", "insert_steps", "give_up"],
    constraints: {
      side_effects_allowed: procedure.side_effects ?? [],
      forbidden_locators: procedure.forbidden?.locators ?? [],
      forbidden_actions: procedure.forbidden?.actions ?? [],
      max_tool_calls: step.fallback?.budget?.tool_calls ?? ctx.max_tool_calls,
      max_tokens: step.fallback?.budget?.tokens ?? 2000,
    },
    remaining_steps_preview: remaining,
  };

  if (step.goal !== undefined) envelope.step_goal = step.goal;
  if (divergence.locator !== undefined) {
    envelope.last_attempt.locator_descriptor = divergence.locator;
  }

  // page_effect rough surface — pull from divergence.observed when present.
  const observedPe = (divergence.observed as { page_effect?: PageEffect } | undefined)?.page_effect;
  if (observedPe !== undefined) {
    envelope.last_attempt.page_effect = observedPe;
  }

  return envelope;
}

export type { ExecutionState };
