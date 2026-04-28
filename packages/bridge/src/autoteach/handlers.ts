/**
 * MCP tool handlers for the procedures_autoteach_* family.
 *
 * Owns:
 *   - start          — open a session, optionally kick off teach mode
 *   - attach         — bind a tab to the session for trace tagging
 *   - record_trace   — close a run's trace window, return record count
 *   - distill        — run the distiller, write a new draft
 *   - record_run     — log run metrics, compute outcome vs prior best
 *   - status         — return session + history + convergence + next opt
 *   - finalize       — variance gate + promote drafts to procedures store
 *   - list           — list sessions on disk
 *   - resume         — same shape as status, by session_id
 */
import * as YAML from "yaml";
import type {
  AutoTeachConsent,
  AutoTeachLeafSummary,
  AutoTeachMode,
  AutoTeachOptimization,
  AutoTeachRun,
  AutoTeachSession,
  FeatureName,
  ProcedureDef,
} from "@browserops/shared";
import type { WSBridgeLike } from "../mcp-server.js";
import type { TabRegistry } from "../tab-registry.js";
import { CodedError } from "../procedures/store.js";
import {
  ensureIndex,
  buildIndex,
  writeIndex,
} from "../procedures/index-builder.js";
import {
  proceduresRoot,
  procedureYamlPath,
} from "../procedures/paths.js";
import { writeProcedureYamlAtomic } from "../procedures/store.js";
import type { AutoTeachStore } from "./store.js";
import { computeOutcome } from "./store.js";
import type { AutoTeachBindings } from "./bindings.js";
import { distill } from "./distiller.js";
import { computeConvergence, pickNextOptimization } from "./convergence.js";
import { checkVariance } from "./variance-gate.js";

const TEACH_CALL_TIMEOUT_MS = 10_000;

export interface AutoteachHandlerDeps {
  wsBridge: WSBridgeLike;
  store: AutoTeachStore;
  bindings: AutoTeachBindings;
  tabs: TabRegistry;
  /** Daemon-managed MCP session_id of the caller; empty for legacy bridge. */
  mcpSessionId: string;
  /** Read at call time so feature toggles take effect without restart. */
  enabledFeatures: ReadonlySet<FeatureName>;
  /**
   * Optional renameSession hook (provided by the daemon, undefined
   * under the legacy single-session bridge). When set + caller passed
   * session_name, the bridge labels the tab group before acquiring
   * the tab.
   */
  renameSession?: (name: string) => string | undefined;
}

export function buildAutoteachHandlers(
  deps: AutoteachHandlerDeps,
): Record<string, (raw: Record<string, unknown>) => Promise<unknown>> {
  const { wsBridge, store, bindings, tabs, mcpSessionId, enabledFeatures, renameSession } = deps;

  // ---------------------------------------------------------------------
  // start
  // ---------------------------------------------------------------------

  async function handleStart(raw: Record<string, unknown>): Promise<{
    session_id: string;
    teach_session_id?: string;
    state: string;
    tab_id?: string;
    session_name?: string;
  }> {
    const goal = requireString(raw, "goal");
    const mode = requireMode(raw["mode"]);
    const consent = requireConsent(raw["consent"]);

    if (!enabledFeatures.has("procedures")) {
      throw new CodedError(
        "FEATURE_DISABLED",
        "auto-teach saves into the procedures store — enable the procedures feature first " +
          "(browserops feature enable procedures)",
        { required_feature: "procedures" },
      );
    }
    if (mode === "demo" && !enabledFeatures.has("teach")) {
      throw new CodedError(
        "FEATURE_DISABLED",
        "demo mode requires the teach feature — enable it first " +
          "(browserops feature enable teach), or call with mode: 'explore'",
        { required_feature: "teach" },
      );
    }

    const sessionNameRaw = raw["session_name"];
    const startUrlRaw = raw["start_url"];
    const acquireTabRaw = raw["acquire_tab"];
    const sessionName =
      typeof sessionNameRaw === "string" && sessionNameRaw.trim() !== ""
        ? sessionNameRaw.trim()
        : undefined;
    const startUrl = typeof startUrlRaw === "string" && startUrlRaw !== "" ? startUrlRaw : undefined;
    const acquireTab =
      typeof acquireTabRaw === "boolean" ? acquireTabRaw : startUrl !== undefined;

    if (acquireTab && !wsBridge.isConnected()) {
      throw new CodedError(
        "EXTENSION_DISCONNECTED",
        "auto-teach asked to acquire a tab but the extension is not connected",
      );
    }

    // Set session_name first so the tab acquired below joins the labeled group.
    let appliedSessionName: string | undefined;
    if (sessionName !== undefined && renameSession !== undefined && mcpSessionId !== "") {
      try {
        appliedSessionName = renameSession(sessionName) ?? sessionName;
      } catch {
        // Session rename is a UX-only feature — ignore failures so the
        // caller still gets a working session.
      }
    }

    let teachSessionId: string | undefined;
    if (mode === "demo") {
      const teachParams: Record<string, unknown> = { scope: "all_tabs" };
      const hint = raw["narration_hint"];
      if (typeof hint === "string" && hint !== "") teachParams["narration_hint"] = hint;
      else teachParams["narration_hint"] = goal.slice(0, 200);
      const result = await wsBridge.callExtension<{
        session_id?: unknown;
      }>("teach_start", teachParams, TEACH_CALL_TIMEOUT_MS);
      if (typeof result?.session_id !== "string") {
        throw new CodedError(
          "INTERNAL",
          "teach_start returned malformed result for autoteach demo",
        );
      }
      teachSessionId = result.session_id;
    }

    const session = await store.create({
      goal,
      mode,
      consent,
      owner_session_id: mcpSessionId,
      ...(teachSessionId !== undefined ? { teach_session_id: teachSessionId } : {}),
    });

    let tabId: string | undefined;
    if (acquireTab) {
      tabId = await acquireDemoTab({ startUrl });
      if (tabId !== undefined) {
        await store.update(session.session_id, { attached_tab_id: tabId });
        bindings.detachSession(session.session_id);
        bindings.attach(tabId, session.session_id, 0);
      }
    }

    return {
      session_id: session.session_id,
      ...(teachSessionId !== undefined ? { teach_session_id: teachSessionId } : {}),
      state: session.state,
      ...(tabId !== undefined ? { tab_id: tabId } : {}),
      ...(appliedSessionName !== undefined ? { session_name: appliedSessionName } : {}),
    };
  }

  /**
   * Open + claim a fresh tab so the demo lands in a session-visible
   * surface. Returns the new tab_id, or undefined if the extension's
   * response was malformed (caller surfaces a soft warning).
   */
  async function acquireDemoTab(opts: { startUrl: string | undefined }): Promise<string | undefined> {
    const params: Record<string, unknown> = { active: true };
    if (opts.startUrl !== undefined) params["url"] = opts.startUrl;
    const result = await wsBridge.callExtension<{ tab_id?: unknown }>(
      "browser_new_tab",
      params,
      TEACH_CALL_TIMEOUT_MS,
    );
    const tabId = result?.tab_id;
    if (typeof tabId !== "string") return undefined;
    // Claim into the calling session if we're in the multi-session daemon
    // so the agent's subsequent browser_* calls resolve. The tab_created
    // event might not have hit the registry yet — best-effort retry on a
    // microtask, mirroring maybeClaimNewTab in mcp-server.
    if (mcpSessionId !== "") {
      const first = tabs.claim(tabId, mcpSessionId);
      if (!first.ok) {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        tabs.claim(tabId, mcpSessionId);
      }
    }
    return tabId;
  }

  // ---------------------------------------------------------------------
  // attach
  // ---------------------------------------------------------------------

  async function handleAttach(raw: Record<string, unknown>): Promise<{ attached: true }> {
    const sessionId = requireString(raw, "session_id");
    const tabId = requireString(raw, "tab_id");
    const runIndex = requireNonNegativeInt(raw, "run_index");
    const session = await store.require(sessionId);
    if (mcpSessionId !== "" && session.owner_session_id !== mcpSessionId) {
      throw new CodedError(
        "INVALID_STATE",
        "auto-teach session belongs to a different MCP session",
      );
    }
    // Replace any prior binding for this session.
    bindings.detachSession(sessionId);
    bindings.attach(tabId, sessionId, runIndex);
    await store.update(sessionId, { attached_tab_id: tabId });
    return { attached: true };
  }

  // ---------------------------------------------------------------------
  // record_trace
  // ---------------------------------------------------------------------

  async function handleRecordTrace(
    raw: Record<string, unknown>,
  ): Promise<{ record_count: number }> {
    const sessionId = requireString(raw, "session_id");
    const runIndex = requireNonNegativeInt(raw, "run_index");
    await store.require(sessionId);
    const recordCount = await store.traceCount(sessionId, runIndex);
    bindings.detachSession(sessionId);
    return { record_count: recordCount };
  }

  // ---------------------------------------------------------------------
  // distill
  // ---------------------------------------------------------------------

  async function handleDistill(raw: Record<string, unknown>): Promise<{
    draft_version: number;
    composite_name: string | null;
    leaves: AutoTeachLeafSummary[];
    yaml: string;
    validation_errors: string[];
  }> {
    const sessionId = requireString(raw, "session_id");
    const session = await store.require(sessionId);
    const runIndex =
      raw["run_index"] !== undefined
        ? requireNonNegativeInt(raw, "run_index")
        : pickLatestRunIndexFromTrace(await store.readTrace(sessionId));
    const records = await store.readTrace(sessionId, runIndex);
    const result = distill(records, { goal: session.goal });
    const draftVersion = await store.writeDraft(sessionId, result.yaml);
    await store.update(sessionId, {
      state: "distilled",
      best_procedure_name:
        result.composite_name ?? result.leaves[0]?.name ?? session.best_procedure_name,
    });
    return {
      draft_version: draftVersion,
      composite_name: result.composite_name,
      leaves: result.leaves,
      yaml: result.yaml,
      validation_errors: result.validation_errors,
    };
  }

  // ---------------------------------------------------------------------
  // record_run
  // ---------------------------------------------------------------------

  async function handleRecordRun(raw: Record<string, unknown>): Promise<{
    outcome: AutoTeachRun["outcome"];
    delta: { tool_count: number; wall_clock_ms: number };
  }> {
    const sessionId = requireString(raw, "session_id");
    const runIndex = requireNonNegativeInt(raw, "run_index");
    const metricsRaw = raw["metrics"];
    if (metricsRaw === null || typeof metricsRaw !== "object") {
      throw new CodedError("INVALID_PARAMS", "metrics must be an object");
    }
    const metrics = metricsRaw as Record<string, unknown>;
    const tool_count = requireNonNegativeInt(metrics, "tool_count");
    const wall_clock_ms = requireNonNegativeInt(metrics, "wall_clock_ms");
    const retries = optionalNonNegativeInt(metrics, "retries") ?? 0;
    const errors = optionalStringArray(metrics, "errors") ?? [];
    const succeeded =
      typeof metrics["succeeded"] === "boolean" ? (metrics["succeeded"] as boolean) : true;

    await store.require(sessionId);
    const best = await store.bestRun(sessionId);
    const { outcome, delta } = computeOutcome(
      { tool_count, wall_clock_ms, succeeded },
      best === null
        ? null
        : { tool_count: best.tool_count, wall_clock_ms: best.wall_clock_ms },
    );

    const optimizationTried = parseOptimization(raw["optimization_tried"]);

    const run: AutoTeachRun = {
      run_id: `r_${runIndex}_${Date.now().toString(36)}`,
      run_index: runIndex,
      started_at: Date.now(),
      ended_at: Date.now(),
      tool_count,
      wall_clock_ms,
      retries,
      errors,
      ...(optimizationTried !== undefined ? { optimization_tried: optimizationTried } : {}),
      outcome,
      trace_ref: `trace.jsonl#run_${runIndex}`,
    };
    await store.appendRun(sessionId, run);
    return { outcome, delta };
  }

  // ---------------------------------------------------------------------
  // status / resume (identical shape)
  // ---------------------------------------------------------------------

  async function statusFor(
    sessionId: string,
    includeYaml: boolean,
  ): Promise<{
    session: AutoTeachSession;
    history: AutoTeachRun[];
    best_procedure_yaml?: string;
    convergence: ReturnType<typeof computeConvergence>;
    next_optimization?: AutoTeachOptimization;
    leaves: AutoTeachLeafSummary[];
  }> {
    const session = await store.require(sessionId);
    const history = await store.readRuns(sessionId);
    const convergence = computeConvergence({ runs: history, session });
    const draftYaml = (await store.readDraft(sessionId)) ?? undefined;
    const procedures = draftYaml !== undefined ? parseDraftYaml(draftYaml) : [];
    const leaves = leavesFromDraft(draftYaml);
    const next =
      convergence.verdict === "improving"
        ? pickNextOptimization({ runs: history, procedures })
        : undefined;
    return {
      session,
      history,
      ...(includeYaml && draftYaml !== undefined ? { best_procedure_yaml: draftYaml } : {}),
      convergence,
      ...(next !== undefined ? { next_optimization: next } : {}),
      leaves,
    };
  }

  async function handleStatus(raw: Record<string, unknown>): Promise<unknown> {
    const sessionId = requireString(raw, "session_id");
    const includeYaml =
      typeof raw["include_yaml"] === "boolean" ? (raw["include_yaml"] as boolean) : true;
    return statusFor(sessionId, includeYaml);
  }

  async function handleResume(raw: Record<string, unknown>): Promise<unknown> {
    const sessionId = requireString(raw, "session_id");
    return statusFor(sessionId, true);
  }

  // ---------------------------------------------------------------------
  // finalize
  // ---------------------------------------------------------------------

  async function handleFinalize(raw: Record<string, unknown>): Promise<{
    saved: string[];
    failed: Array<{ name: string; reason: string }>;
  }> {
    const sessionId = requireString(raw, "session_id");
    const force = typeof raw["force"] === "boolean" ? (raw["force"] as boolean) : false;
    const session = await store.require(sessionId);
    const runs = await store.readRuns(sessionId);

    const gate = checkVariance({ runs, force });
    if (!gate.passed) {
      await store.setState(sessionId, "stalled");
      return {
        saved: [],
        failed: [
          {
            name: session.best_procedure_name ?? "(unknown)",
            reason: `variance gate failed: ${gate.reasons.join("; ")}`,
          },
        ],
      };
    }

    const yaml = await store.readDraft(sessionId);
    if (yaml === null || yaml === undefined) {
      throw new CodedError(
        "PROC_NOT_FOUND",
        "no draft to finalize — call procedures_autoteach_distill first",
      );
    }

    const procedures = parseDraftYaml(yaml);
    if (procedures.length === 0) {
      return {
        saved: [],
        failed: [
          { name: "(empty draft)", reason: "draft contained no parsable procedures" },
        ],
      };
    }

    const saved: string[] = [];
    const failed: Array<{ name: string; reason: string }> = [];

    // Ensure the procedure index exists so save semantics line up with
    // procedures_save (atomic write, then rebuild manifest).
    await ensureIndex(proceduresRoot());

    // Promote leaves first, composite last (mirrors procedures_save).
    const ordered = [
      ...procedures.filter((p) => p.kind === "leaf"),
      ...procedures.filter((p) => p.kind === "composite"),
    ];
    for (const proc of ordered) {
      try {
        const promoted: ProcedureDef = {
          ...proc,
          meta: {
            version: 1,
            created: new Date().toISOString(),
            last_verified: new Date().toISOString(),
            success_count: 1,
            failure_count: 0,
            status: "trusted",
          },
        };
        const owner = proc.kind === "leaf" ? null : null;
        const yamlText = YAML.stringify(promoted, { lineWidth: 0 });
        await writeProcedureYamlAtomic(procedureYamlPath(owner, proc.name), yamlText);
        saved.push(proc.name);
      } catch (err) {
        failed.push({
          name: proc.name,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await writeIndex(proceduresRoot(), await buildIndex(proceduresRoot()));

    await store.setState(
      sessionId,
      saved.length > 0 && failed.length === 0 ? "converged" : "stalled",
    );

    return { saved, failed };
  }

  // ---------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------

  async function handleList(): Promise<{ sessions: AutoTeachSession[] }> {
    const sessions = await store.list(mcpSessionId === "" ? undefined : mcpSessionId);
    return { sessions };
  }

  return {
    procedures_autoteach_start: handleStart,
    procedures_autoteach_attach: handleAttach,
    procedures_autoteach_record_trace: handleRecordTrace,
    procedures_autoteach_distill: handleDistill,
    procedures_autoteach_record_run: handleRecordRun,
    procedures_autoteach_status: handleStatus,
    procedures_autoteach_finalize: handleFinalize,
    procedures_autoteach_list: handleList,
    procedures_autoteach_resume: handleResume,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function requireString(raw: Record<string, unknown>, field: string): string {
  const v = raw[field];
  if (typeof v !== "string" || v === "") {
    throw new CodedError("INVALID_PARAMS", `${field} must be a non-empty string`);
  }
  return v;
}

function requireNonNegativeInt(raw: Record<string, unknown>, field: string): number {
  const v = raw[field];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new CodedError("INVALID_PARAMS", `${field} must be a non-negative integer`);
  }
  return v;
}

function optionalNonNegativeInt(raw: Record<string, unknown>, field: string): number | undefined {
  const v = raw[field];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new CodedError("INVALID_PARAMS", `${field} must be a non-negative integer`);
  }
  return v;
}

function optionalStringArray(raw: Record<string, unknown>, field: string): string[] | undefined {
  const v = raw[field];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new CodedError("INVALID_PARAMS", `${field} must be a string[]`);
  }
  return v as string[];
}

function requireMode(v: unknown): AutoTeachMode {
  if (v !== "demo" && v !== "explore") {
    throw new CodedError("INVALID_PARAMS", "mode must be 'demo' or 'explore'");
  }
  return v;
}

function requireConsent(v: unknown): AutoTeachConsent {
  if (v === null || typeof v !== "object") {
    throw new CodedError("INVALID_PARAMS", "consent must be an object");
  }
  const c = v as Record<string, unknown>;
  const policy = c["side_effect_policy"];
  if (
    policy !== "use_dummies" &&
    policy !== "pause_at_destructive" &&
    policy !== "read_only_only"
  ) {
    throw new CodedError(
      "INVALID_PARAMS",
      "consent.side_effect_policy must be one of: use_dummies, pause_at_destructive, read_only_only",
    );
  }
  const budgetRaw = c["budget"];
  let budget: AutoTeachConsent["budget"];
  if (budgetRaw === "convergence") budget = "convergence";
  else if (typeof budgetRaw === "number" && Number.isInteger(budgetRaw) && budgetRaw >= 1) {
    budget = budgetRaw;
  } else {
    throw new CodedError(
      "INVALID_PARAMS",
      "consent.budget must be 'convergence' or a positive integer",
    );
  }
  const dummiesRaw = c["dummies"];
  let dummies: Record<string, string | number | boolean> | undefined;
  if (dummiesRaw !== undefined) {
    if (dummiesRaw === null || typeof dummiesRaw !== "object" || Array.isArray(dummiesRaw)) {
      throw new CodedError("INVALID_PARAMS", "consent.dummies must be an object");
    }
    const d: Record<string, string | number | boolean> = {};
    for (const [k, val] of Object.entries(dummiesRaw as Record<string, unknown>)) {
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        d[k] = val;
      } else {
        throw new CodedError(
          "INVALID_PARAMS",
          `consent.dummies.${k} must be a string|number|boolean`,
        );
      }
    }
    dummies = d;
  }
  return {
    budget,
    side_effect_policy: policy,
    ...(dummies !== undefined ? { dummies } : {}),
  };
}

function parseOptimization(raw: unknown): AutoTeachOptimization | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object") {
    throw new CodedError("INVALID_PARAMS", "optimization_tried must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj["kind"];
  if (typeof kind !== "string") {
    throw new CodedError("INVALID_PARAMS", "optimization_tried.kind must be a string");
  }
  // Trust the shape — Ajv has already validated it via the input schema in
  // the dispatch pipeline.
  return obj as unknown as AutoTeachOptimization;
}

function pickLatestRunIndexFromTrace(
  records: Array<{ run_index: number }>,
): number {
  let max = 0;
  for (const r of records) {
    if (r.run_index > max) max = r.run_index;
  }
  return max;
}

interface DraftSummary {
  name: string;
  draft_status: AutoTeachLeafSummary["draft_status"];
  side_effects: AutoTeachLeafSummary["side_effects"];
  fragility: AutoTeachLeafSummary["fragility"];
  step_ids: string[];
}

function readSummaries(yaml: string | undefined): DraftSummary[] {
  if (yaml === undefined) return [];
  const procs = parseDraftYaml(yaml);
  return procs.map((p) => ({
    name: p.name,
    draft_status: "draft",
    side_effects: p.side_effects ?? [],
    fragility: p.fragility ?? "low",
    step_ids: (p.steps ?? [])
      .map((s) => (s as { id?: unknown }).id)
      .filter((v): v is string => typeof v === "string"),
  }));
}

function leavesFromDraft(yaml: string | undefined): AutoTeachLeafSummary[] {
  return readSummaries(yaml).map((s) => ({
    name: s.name,
    draft_status: s.draft_status,
    side_effects: s.side_effects,
    fragility: s.fragility,
  }));
}

function stepIdsFromDraft(yaml: string | undefined): string[] {
  return readSummaries(yaml).flatMap((s) => s.step_ids);
}

function parseDraftYaml(yaml: string): ProcedureDef[] {
  const out: ProcedureDef[] = [];
  for (const doc of YAML.parseAllDocuments(yaml)) {
    const obj = doc.toJSON();
    if (obj === null || typeof obj !== "object") continue;
    if ((obj as { schema_version?: unknown }).schema_version !== 1) continue;
    out.push(obj as ProcedureDef);
  }
  return out;
}
