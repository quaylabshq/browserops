/**
 * Auto-teach session types.
 *
 * Auto-teach is the procedure-bootstrapping loop: the user asks the agent
 * to "learn to do X", the agent captures one demonstration (or, when the
 * caller opts in, explores cold), distills it, and then iteratively
 * replays the draft applying one optimization per run until the metrics
 * stop improving. The loop is driven by the agent (only it can issue
 * browser_* calls); the bridge owns persistent state, the distiller, the
 * convergence verdict, and the variance gate.
 *
 * These types describe everything that crosses the bridge ↔ agent
 * boundary plus the on-disk session sidecar.
 */

import type {
  ProcedureFragility,
  SideEffectClass,
} from "./procedures.js";
import type { PageEffect } from "./effects.js";

// ---------------------------------------------------------------------------
// Modes & policies
// ---------------------------------------------------------------------------

/** Whether run 0 came from a user demo or from agent exploration. */
export type AutoTeachMode = "demo" | "explore";

/**
 * What the loop does when a draft leaf is classified as side-effecting.
 *
 *  - use_dummies          — replay normally, but every destructive input
 *                            must be supplied with a dummy value.
 *  - pause_at_destructive — optimize only the leading non-destructive
 *                            leaves; the destructive leaf runs once
 *                            during finalize for the variance gate.
 *  - read_only_only       — refuse the session if any leaf has
 *                            side_effects.
 */
export type AutoTeachSideEffectPolicy =
  | "use_dummies"
  | "pause_at_destructive"
  | "read_only_only";

/**
 * Consent answers gathered up-front. Persisted on the session so the
 * skill doesn't have to re-ask if the conversation is resumed.
 */
export interface AutoTeachConsent {
  /** Maps destructive input name → dummy value used during training. */
  dummies?: Record<string, string | number | boolean>;
  /**
   * Budget for the loop:
   *  - "convergence" — keep going until convergence or stall.
   *  - <number>      — hard cap on optimization runs (in addition to run 0).
   * Default is "convergence".
   */
  budget: "convergence" | number;
  side_effect_policy: AutoTeachSideEffectPolicy;
}

/**
 * Session lifecycle. The state machine is mostly informational — the
 * skill computes transitions and writes them on each tool call.
 */
export type AutoTeachState =
  | "consenting"
  | "capturing_demo"
  | "exploring"
  | "distilled"
  | "optimizing"
  | "finalizing"
  | "converged"
  | "stalled"
  | "aborted";

// ---------------------------------------------------------------------------
// Session & runs
// ---------------------------------------------------------------------------

/** On-disk session metadata sidecar. */
export interface AutoTeachSession {
  session_id: string;
  /** Free-text goal as the user phrased it (not redacted). */
  goal: string;
  mode: AutoTeachMode;
  consent: AutoTeachConsent;
  state: AutoTeachState;
  /** Owner MCP session_id (multi-session daemon). Empty for legacy bridge. */
  owner_session_id?: string;
  /** Teach-mode session_id when mode === "demo". */
  teach_session_id?: string;
  /** Tab currently attached to this session for trace tagging. */
  attached_tab_id?: string;
  /** Latest draft procedure name once distillation has run at least once. */
  best_procedure_name?: string;
  /** Number of drafts/v<N>.yaml files written so far. */
  draft_version: number;
  created_at: number;
  last_run_at?: number;
}

/** Outcome of one optimization run vs. the prior best. */
export type AutoTeachRunOutcome = "improved" | "regressed" | "noop" | "failed";

/** Per-run record appended to runs.jsonl. */
export interface AutoTeachRun {
  run_id: string;
  /** 0 = first capture (demo or explore); 1.. = optimization replays. */
  run_index: number;
  started_at: number;
  ended_at?: number;
  /** Total browser_* tool calls observed during this run. */
  tool_count: number;
  /** Wall-clock from first to last call in this run (ms). */
  wall_clock_ms: number;
  /** Number of failed dispatches the agent retried within this run. */
  retries: number;
  /** Distinct error codes observed (for debugging). */
  errors: string[];
  /** Optimization the loop applied before this replay; absent for run 0. */
  optimization_tried?: AutoTeachOptimization;
  /** Verdict vs. prior best. */
  outcome: AutoTeachRunOutcome;
  /** Relative path to this run's slice of trace.jsonl (e.g. trace.jsonl#run_0). */
  trace_ref: string;
}

// ---------------------------------------------------------------------------
// Optimizations
// ---------------------------------------------------------------------------

/**
 * One change the loop tried. The picker emits ONE per replay so a
 * regression is bisectable to the exact change.
 *
 * The `kind` field is the discriminator. All variants carry enough
 * structured detail for the distiller to apply them deterministically
 * to the current draft.
 */
export type AutoTeachOptimization =
  | {
      kind: "drop_dead_read";
      step_id: string;
    }
  | {
      kind: "cache_selector";
      step_id: string;
      new_tier: "id" | "testid" | "role_name";
      new_selector: string;
    }
  | {
      kind: "lift_to_bind";
      step_id: string;
      input_name: string;
      source_step_id: string;
    }
  | {
      kind: "tighten_wait";
      step_id: string;
      new_timeout_ms: number;
    }
  | {
      kind: "swap_to_execute_js";
      step_id: string;
    }
  | {
      kind: "split_leaf";
      at_step_id: string;
      reason: "url_change" | "modal_open" | "focus_shift" | "network_burst";
    }
  | {
      kind: "reuse_existing";
      leaf_name: string;
      replacement_name: string;
    };

// ---------------------------------------------------------------------------
// Status & convergence
// ---------------------------------------------------------------------------

export type AutoTeachConvergenceVerdict = "converged" | "stalled" | "improving";

export interface AutoTeachConvergence {
  verdict: AutoTeachConvergenceVerdict;
  /** Plain-English reasons feeding the verdict; safe to surface to the user. */
  reasons: string[];
}

/** Per-leaf rollup returned in status. */
export interface AutoTeachLeafSummary {
  name: string;
  draft_status: "draft" | "trusted" | "missing";
  side_effects: SideEffectClass[];
  fragility: ProcedureFragility;
}

/** Composite return shape of procedures_autoteach_status. */
export interface AutoTeachStatus {
  session: AutoTeachSession;
  history: AutoTeachRun[];
  best_procedure_yaml?: string;
  convergence: AutoTeachConvergence;
  /** Skill should apply this and replay; absent when converged or stalled. */
  next_optimization?: AutoTeachOptimization;
  leaves: AutoTeachLeafSummary[];
}

// ---------------------------------------------------------------------------
// Trace records
// ---------------------------------------------------------------------------

/**
 * One browser_* call observed on an attached tab. Appended to
 * trace.jsonl. The distiller reads back these records (filtered by
 * run_index) to build a draft.
 */
export interface AutoTeachTraceRecord {
  ts: number;
  run_index: number;
  /** MCP tool name (e.g. browser_click). */
  method: string;
  /** Arguments passed to the tool. */
  params: Record<string, unknown>;
  /** True when the bridge returned a non-error reply. */
  ok: boolean;
  /** Error code when ok=false. */
  error_code?: string;
  /** Compact result summary (stripping large blobs like screenshots). */
  result_summary?: Record<string, unknown>;
  /** Observed page_effect when the tool returned one. */
  page_effect?: PageEffect;
  /** Duration of the call in ms. */
  duration_ms: number;
}
