/**
 * Shared result/divergence types for the procedure execute loop.
 *
 * Lifted out of execute.ts so state.ts can reference them without a
 * circular import (state ↔ execute would otherwise loop).
 */

export interface StepResult {
  id: string;
  action: string;
  matched: boolean;
  /** Number of fallback attempts consumed by this step. */
  attempts?: number;
  /** Strategy that ultimately resolved (or failed) the step. */
  resolved_by?: "first_try" | "retry" | "relocate" | "llm" | "halted";
  observed?: unknown;
  warnings?: string[];
}

export interface DivergenceInfo {
  step_id: string;
  step_index: number;
  reason: string;
  observed?: unknown;
  expected?: unknown;
  locator?: unknown;
}
