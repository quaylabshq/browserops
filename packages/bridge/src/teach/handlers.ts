/**
 * MCP tool handlers for the procedures_teach_* family.
 *
 * Routing:
 *  - start / stop / marker / narration mutate extension-side state, so they
 *    forward to the extension via wsBridge.callExtension(). The extension's
 *    TeachRecorder owns the in-flight session.
 *  - observe / list read the on-disk JSONL store maintained by the bridge.
 *    No extension call required — works even if the extension is offline
 *    (sessions that ran in the past are still inspectable).
 */

import type { TeachSessionMeta } from "@browserops/shared";
import type { WSBridgeLike } from "../mcp-server.js";
import { CodedError } from "../procedures/store.js";
import type { TeachSessionStore } from "./session-store.js";
import { distillSession } from "./distill.js";

const TEACH_CALL_TIMEOUT_MS = 10_000;

export interface TeachStartResult {
  session_id: string;
  started_at: number;
  resumed: boolean;
}

export interface TeachStopResult {
  session_id: string;
  event_count: number;
  duration_ms: number;
}

export interface TeachObserveResult {
  events: unknown[];
  next_seq: number;
  finished: boolean;
}

export interface TeachListResult {
  sessions: TeachSessionMeta[];
}

export interface TeachDistillResult {
  procedures: Array<{ name: string; kind: "leaf" | "composite"; yaml: string }>;
  warnings: string[];
  redacted_inputs: string[];
  parameter_candidates: Array<{
    seq: number;
    value: string;
    suggested_name: string;
    suggested_type: "string";
    auto_parameterized: boolean;
    target_field_label?: string;
  }>;
}

export function buildTeachHandlers(
  wsBridge: WSBridgeLike,
  store: TeachSessionStore,
): Record<string, (raw: Record<string, unknown>) => Promise<unknown>> {
  async function handleStart(raw: Record<string, unknown>): Promise<TeachStartResult> {
    const params: Record<string, unknown> = {};
    const scope = raw["scope"];
    if (typeof scope === "string") params["scope"] = scope;
    const hint = raw["narration_hint"];
    if (typeof hint === "string" && hint !== "") params["narration_hint"] = hint;
    const result = await wsBridge.callExtension<{
      session_id?: unknown;
      started_at?: unknown;
      resumed?: unknown;
    }>("teach_start", params, TEACH_CALL_TIMEOUT_MS);
    if (
      typeof result?.session_id !== "string" ||
      typeof result?.started_at !== "number"
    ) {
      throw new CodedError("INTERNAL", "teach_start returned malformed result");
    }
    return {
      session_id: result.session_id,
      started_at: result.started_at,
      resumed: typeof result.resumed === "boolean" ? result.resumed : false,
    };
  }

  async function handleStop(raw: Record<string, unknown>): Promise<TeachStopResult> {
    void raw;
    const result = await wsBridge.callExtension<{
      session_id?: unknown;
      event_count?: unknown;
      duration_ms?: unknown;
    }>("teach_stop", {}, TEACH_CALL_TIMEOUT_MS);
    if (
      typeof result?.session_id !== "string" ||
      typeof result?.event_count !== "number" ||
      typeof result?.duration_ms !== "number"
    ) {
      throw new CodedError("INTERNAL", "teach_stop returned malformed result");
    }
    // Mirror stopped_at into the bridge-side meta so observe() can report
    // finished: true once the cursor catches up.
    await store.finalize(result.session_id, Date.now(), result.event_count);
    return {
      session_id: result.session_id,
      event_count: result.event_count,
      duration_ms: result.duration_ms,
    };
  }

  async function handleObserve(
    raw: Record<string, unknown>,
  ): Promise<TeachObserveResult> {
    const sessionId = raw["session_id"];
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new CodedError("INVALID_PARAMS", "session_id:string required");
    }
    const sinceSeqRaw = raw["since_seq"];
    const sinceSeq =
      typeof sinceSeqRaw === "number" && Number.isInteger(sinceSeqRaw) && sinceSeqRaw >= 0
        ? sinceSeqRaw
        : 0;
    const waitMsRaw = raw["wait_ms"];
    const waitMs =
      typeof waitMsRaw === "number" && Number.isInteger(waitMsRaw) && waitMsRaw >= 0
        ? Math.min(waitMsRaw, 30_000)
        : 0;
    const maxBatchRaw = raw["max_batch"];
    const maxBatch =
      typeof maxBatchRaw === "number" && Number.isInteger(maxBatchRaw) && maxBatchRaw >= 1
        ? Math.min(maxBatchRaw, 500)
        : 200;
    return store.observe(sessionId, sinceSeq, waitMs, maxBatch);
  }

  async function handleList(raw: Record<string, unknown>): Promise<TeachListResult> {
    void raw;
    const sessions = await store.list();
    return { sessions };
  }

  async function handleMarker(raw: Record<string, unknown>): Promise<{ ok: true }> {
    const params: Record<string, unknown> = {};
    const label = raw["label"];
    if (typeof label === "string" && label !== "") params["label"] = label;
    await wsBridge.callExtension("teach_marker", params, TEACH_CALL_TIMEOUT_MS);
    return { ok: true };
  }

  async function handleNarration(raw: Record<string, unknown>): Promise<{ ok: true }> {
    const text = raw["text"];
    if (typeof text !== "string" || text === "") {
      throw new CodedError("INVALID_PARAMS", "text:string required");
    }
    await wsBridge.callExtension("teach_narration", { text }, TEACH_CALL_TIMEOUT_MS);
    return { ok: true };
  }

  async function handleDistill(
    raw: Record<string, unknown>,
  ): Promise<TeachDistillResult> {
    const sessionId = raw["session_id"];
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new CodedError("INVALID_PARAMS", "session_id:string required");
    }
    const opts: { name?: string; description?: string } = {};
    const nameRaw = raw["name"];
    if (typeof nameRaw === "string" && nameRaw !== "") opts.name = nameRaw;
    const descRaw = raw["description"];
    if (typeof descRaw === "string" && descRaw !== "") opts.description = descRaw;
    const result = await distillSession(sessionId, store, opts);
    return {
      procedures: result.procedures.map((p) => ({
        name: p.name,
        kind: p.kind,
        yaml: p.yaml,
      })),
      warnings: result.warnings,
      redacted_inputs: result.redacted_inputs,
      parameter_candidates: result.parameter_candidates,
    };
  }

  return {
    procedures_teach_start: handleStart,
    procedures_teach_stop: handleStop,
    procedures_teach_observe: handleObserve,
    procedures_teach_list: handleList,
    procedures_teach_marker: handleMarker,
    procedures_teach_narration: handleNarration,
    procedures_teach_distill: handleDistill,
  };
}
