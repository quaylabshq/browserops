/**
 * In-memory procedure execution state.
 *
 * Holds suspended runs that are waiting for a `procedures_resume` call from
 * the agent (LLM fallback flow). Each execution has a 5-minute TTL —
 * stale entries are evicted lazily on `getState`.
 *
 * Per-process: state does NOT survive a bridge restart. A resume after
 * restart surfaces PROCEDURE_RESUME_EXPIRED so the caller doesn't silently
 * lose work.
 */
import type { ProcedureDef } from "@browserops/shared";
import type { StepResult, DivergenceInfo } from "./execute-types.js";

export const EXECUTION_TTL_MS = 5 * 60 * 1000;

export interface ExecutionBudget {
  /** Total LLM-fallback tool_calls consumed across all steps so far. */
  consumed_tool_calls: number;
  /** Total tokens (estimate) charged so far. */
  consumed_tokens: number;
}

export interface ExecutionState {
  execution_id: string;
  procedure: ProcedureDef;
  tab_id: string;
  /** Caller-supplied input map, post-substitution. */
  inputs: Record<string, unknown>;
  /** Index of the step that suspended the run. */
  paused_at: number;
  step_results: StepResult[];
  divergence: DivergenceInfo;
  budget: ExecutionBudget;
  /** Strict mode disables all LLM fallback paths even if a step declares them. */
  strict: boolean;
  /** Whether the run has ever used LLM fallback. Trusted-bump refuses if true. */
  used_llm_fallback: boolean;
  created_at: number;
  expires_at: number;
}

const _states = new Map<string, ExecutionState>();
let _idCounter = 0;

function nextId(): string {
  _idCounter = (_idCounter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `ex_${Date.now().toString(36)}_${_idCounter.toString(36)}_${rand}`;
}

function pruneStale(): void {
  const now = Date.now();
  for (const [id, st] of _states) {
    if (st.expires_at < now) _states.delete(id);
  }
}

export interface CreateStateInput {
  procedure: ProcedureDef;
  tab_id: string;
  inputs: Record<string, unknown>;
  paused_at: number;
  step_results: StepResult[];
  divergence: DivergenceInfo;
  strict: boolean;
  budget?: ExecutionBudget;
  used_llm_fallback?: boolean;
}

export function createState(input: CreateStateInput): ExecutionState {
  pruneStale();
  const now = Date.now();
  const state: ExecutionState = {
    execution_id: nextId(),
    procedure: input.procedure,
    tab_id: input.tab_id,
    inputs: input.inputs,
    paused_at: input.paused_at,
    step_results: input.step_results,
    divergence: input.divergence,
    strict: input.strict,
    used_llm_fallback: input.used_llm_fallback ?? false,
    budget: input.budget ?? { consumed_tool_calls: 0, consumed_tokens: 0 },
    created_at: now,
    expires_at: now + EXECUTION_TTL_MS,
  };
  _states.set(state.execution_id, state);
  return state;
}

export function getState(execution_id: string): ExecutionState | undefined {
  pruneStale();
  return _states.get(execution_id);
}

export function dropState(execution_id: string): boolean {
  return _states.delete(execution_id);
}

export function _resetForTests(): void {
  _states.clear();
  _idCounter = 0;
}

export function _activeStateCount(): number {
  return _states.size;
}
