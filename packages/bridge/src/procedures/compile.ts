/**
 * procedures_compile — Phase 4 trace-to-YAML compiler.
 *
 * Reads a JSONL trace file, filters read-only and failed-call events,
 * then emits a draft procedure YAML with one step per remaining tool call
 * and an expected_effect clause derived from the observed page_effect.
 *
 * expected_effect uses loose semantics so replay tolerates natural
 * run-to-run variance rather than asserting exact mutation counts.
 * Callers review the YAML and save via procedures_save — never auto-saved.
 */
import * as fs from "node:fs/promises";
import * as readline from "node:readline";
import * as nodeFs from "node:fs";
import type { TraceEvent } from "@browserops/shared";
import { CodedError } from "./store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Tool names that are read-only / observational. These are excluded from
 * compiled procedures by default since they don't advance the task state.
 */
export const DEFAULT_SKIP_TOOLS: ReadonlySet<string> = new Set([
  "browser_read",
  "browser_list_tabs",
  "browser_pinned_tab",
  "browser_current_tab",
  "browser_query_selector",
  "browser_describe_ref",
  "browser_screenshot",
  "browser_wait_for",
  "browser_wait_for_idle",
]);

// ---------------------------------------------------------------------------
// page_effect types (subset we care about for expected_effect compilation)
// ---------------------------------------------------------------------------

interface DomEffect {
  added: number;
  removed: number;
  attr_changes: number;
  text_changes: number;
}

interface UrlEffect {
  changed: boolean;
  before?: string;
  after?: string;
}

interface FocusEffect {
  changed: boolean;
}

interface NetworkEffect {
  requests_started: number;
  requests_completed: number;
  in_flight_at_end: number;
}

interface PageEffect {
  dom: DomEffect;
  url: UrlEffect;
  focus: FocusEffect;
  network: NetworkEffect;
  console_errors?: number;
  window_ms?: number;
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Step builder
// ---------------------------------------------------------------------------

/**
 * Derive loose expected_effect from observed page_effect.
 *
 * Semantics:
 *   - dom.any: true  when any DOM mutation was observed
 *   - url.changed: as observed
 *   - focus.changed: as observed
 *   - network.requests_started_min: max(1, observed - 1) when observed > 0
 *
 * This gives replay slack for natural variability instead of asserting
 * exact mutation counts.
 */
function compileExpectedEffect(
  effect: PageEffect,
): Record<string, unknown> | undefined {
  const clauses: Record<string, unknown> = {};

  // DOM
  const totalMutations =
    effect.dom.added +
    effect.dom.removed +
    effect.dom.attr_changes +
    effect.dom.text_changes;
  if (totalMutations > 0) {
    clauses["dom"] = { any: true };
  }

  // URL
  clauses["url"] = { changed: effect.url.changed };

  // Focus
  clauses["focus"] = { changed: effect.focus.changed };

  // Network
  if (effect.network.requests_started > 0) {
    clauses["network"] = {
      requests_started_min: Math.max(1, effect.network.requests_started - 1),
    };
  }

  return Object.keys(clauses).length > 0 ? clauses : undefined;
}

/**
 * Extract page_effect from a tool result value, if present.
 */
function extractPageEffect(value: unknown): PageEffect | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const pe = v["page_effect"];
  if (pe == null || typeof pe !== "object") return undefined;
  const peo = pe as Record<string, unknown>;

  // Validate structure loosely — must have dom, url, focus, network
  if (
    typeof peo["dom"] !== "object" ||
    typeof peo["url"] !== "object" ||
    typeof peo["focus"] !== "object" ||
    typeof peo["network"] !== "object"
  ) {
    return undefined;
  }

  return pe as PageEffect;
}

// ---------------------------------------------------------------------------
// YAML serialiser (simple hand-rolled, keeps style consistent)
// ---------------------------------------------------------------------------

/**
 * Minimal hand-rolled YAML serialiser that produces the same style as the
 * example procedure YAMLs in examples/procedures/. We avoid pulling in the
 * full `yaml` library here because we want deterministic, readable output
 * without needing to configure the serialiser.
 *
 * Limitations: only handles string/number/boolean/null scalars, plain arrays
 * of scalars, and objects with string keys. Sufficient for the procedure
 * step shape.
 */
function toYamlValue(value: unknown, indent: number): string {
  const pad = " ".repeat(indent);

  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "string") {
    // Quote strings that could be misread as YAML keywords or contain special chars
    if (
      value === "" ||
      value.includes(":") ||
      value.includes("#") ||
      value.includes("'") ||
      value.includes('"') ||
      value.includes("\n") ||
      value.includes("{") ||
      value.includes("}") ||
      value === "true" ||
      value === "false" ||
      value === "null" ||
      /^\d/.test(value)
    ) {
      // Use double-quoted form, escaping backslash and double-quote
      const escaped = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");
      return `"${escaped}"`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value
      .map((item) => `${pad}- ${toYamlValue(item, indent + 2)}`)
      .join("\n");
    return `\n${items}`;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    const lines = keys.map((k) => {
      const v = obj[k];
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        return `${pad}${k}:\n${toYamlValue(v, indent + 2)
          .split("\n")
          .map((l) => (l.startsWith(pad) ? l : `${pad}${l}`))
          .join("\n")}`;
      }
      const rendered = toYamlValue(v, indent + 2);
      if (rendered.startsWith("\n")) {
        return `${pad}${k}:${rendered}`;
      }
      return `${pad}${k}: ${rendered}`;
    });
    return lines.join("\n");
  }

  return String(value);
}

// ---------------------------------------------------------------------------
// Compile result
// ---------------------------------------------------------------------------

export interface CompileResult {
  yaml: string;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Main compiler
// ---------------------------------------------------------------------------

/**
 * Read a JSONL trace file and compile it into a draft procedure YAML string.
 *
 * @param tracePath  Absolute path to the .jsonl trace file.
 * @param outName    Dot-delimited procedure name (e.g. "slack.search_messages").
 * @param skipTools  Additional tool names to exclude beyond DEFAULT_SKIP_TOOLS.
 */
export async function compileTrace(
  tracePath: string,
  outName: string,
  skipTools: string[] = [],
): Promise<CompileResult> {
  const warnings: string[] = [];

  // Validate out_name pattern
  if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(outName)) {
    throw new CodedError(
      "INVALID_PARAMS",
      `out_name must match ^[a-z][a-z0-9_.-]{0,79}$ — got: ${outName}`,
    );
  }

  // Check file exists
  try {
    await fs.access(tracePath);
  } catch {
    throw new CodedError(
      "INVALID_PARAMS",
      `trace file not found: ${tracePath}`,
    );
  }

  // Build effective skip set
  const effectiveSkip = new Set<string>([
    ...DEFAULT_SKIP_TOOLS,
    ...skipTools,
  ]);

  // Read events
  const events: TraceEvent[] = [];
  const rl = readline.createInterface({
    input: nodeFs.createReadStream(tracePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineNum = 0;
  for await (const line of rl) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TraceEvent;
      events.push(parsed);
    } catch {
      warnings.push(`line ${lineNum}: JSON parse error — skipped`);
    }
  }

  if (events.length === 0) {
    warnings.push("trace has 0 events");
  }

  // Filter events
  const included = events.filter((ev) => {
    // Drop tools in skip list
    if (effectiveSkip.has(ev.tool_name)) return false;
    // Drop failed calls
    if (!ev.result.ok) return false;
    return true;
  });

  const skippedCount = events.length - included.length;
  if (events.length > 0 && included.length === 0) {
    warnings.push(
      `all ${events.length} events were filtered (${skippedCount} skipped) — no steps generated`,
    );
  } else if (skippedCount > 0) {
    warnings.push(
      `${skippedCount} of ${events.length} events filtered (read-only or failed)`,
    );
  }

  // Build steps
  const stepLines: string[] = [];
  for (let i = 0; i < included.length; i++) {
    const ev = included[i]!;
    const stepId = `step_${String(i + 1).padStart(2, "0")}_${ev.tool_name.replace(/^browser_/, "")}`;

    stepLines.push(`  - id: ${stepId}`);
    stepLines.push(`    action: ${ev.tool_name}`);

    // Build with: block from input params
    const withParams = { ...ev.input };
    if (Object.keys(withParams).length > 0) {
      stepLines.push("    with:");
      for (const [k, v] of Object.entries(withParams)) {
        const rendered = toYamlValue(v, 8);
        if (rendered.startsWith("\n")) {
          stepLines.push(`      ${k}:${rendered}`);
        } else {
          stepLines.push(`      ${k}: ${rendered}`);
        }
      }
    }

    // Build expected_effect from page_effect if present
    const pageEffect =
      ev.result.ok ? extractPageEffect(ev.result.value) : undefined;
    if (pageEffect) {
      const effect = compileExpectedEffect(pageEffect);
      if (effect) {
        stepLines.push("    expected_effect:");
        for (const [clauseKey, clauseVal] of Object.entries(effect)) {
          if (typeof clauseVal === "object" && clauseVal !== null) {
            stepLines.push(`      ${clauseKey}:`);
            for (const [k, v] of Object.entries(
              clauseVal as Record<string, unknown>,
            )) {
              stepLines.push(`        ${k}: ${toYamlValue(v, 10)}`);
            }
          } else {
            stepLines.push(`      ${clauseKey}: ${toYamlValue(clauseVal, 8)}`);
          }
        }
      }
    }

    stepLines.push("");
  }

  // Derive description and domain from out_name
  const nameParts = outName.split(".");
  const domain = nameParts.length > 1 ? nameParts[0] : undefined;
  const descSlug = nameParts[nameParts.length - 1]!.replace(/_/g, " ");
  const description = `${descSlug.charAt(0).toUpperCase()}${descSlug.slice(1)} (compiled from trace)`;

  // Assemble YAML
  const header = [
    `# Compiled from trace ${tracePath} at ${new Date().toISOString()}`,
    `# NOTE: all params are inlined from the trace. Edit to extract dynamic`,
    `# params (e.g., {{query}}, {{tab_id}}) before saving.`,
    "",
    "schema_version: 1",
    "",
    `name: ${outName}`,
    `description: ${description}`,
    "kind: leaf",
    domain ? `domain: ${domain}` : null,
    "",
    "inputs: {}",
    "",
    "steps:",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const stepsSection =
    included.length === 0
      ? "  # No steps compiled — all trace events were filtered.\n  - id: placeholder\n    action: browser_navigate\n    with:\n      tab_id: t_0\n      url: https://example.com"
      : stepLines.join("\n").replace(/\n+$/, "");

  const yaml = `${header}\n${stepsSection}\n`;

  return { yaml, warnings };
}

// ---------------------------------------------------------------------------
// Handler (bridge-local, no extension round-trip)
// ---------------------------------------------------------------------------

export interface CompileHandlerResult {
  yaml: string;
  path?: string;
  warnings: string[];
}

export async function handleCompile(
  raw: Record<string, unknown>,
): Promise<CompileHandlerResult> {
  const tracePath = raw["trace_path"];
  if (typeof tracePath !== "string" || tracePath.trim() === "") {
    throw new CodedError(
      "INVALID_PARAMS",
      "trace_path must be a non-empty string",
    );
  }

  const outName = raw["out_name"];
  if (typeof outName !== "string" || outName.trim() === "") {
    throw new CodedError(
      "INVALID_PARAMS",
      "out_name must be a non-empty string",
    );
  }

  let skipTools: string[] = [];
  if (raw["skip_tools"] !== undefined) {
    if (!Array.isArray(raw["skip_tools"])) {
      throw new CodedError("INVALID_PARAMS", "skip_tools must be an array");
    }
    for (const item of raw["skip_tools"] as unknown[]) {
      if (typeof item !== "string") {
        throw new CodedError(
          "INVALID_PARAMS",
          "skip_tools must be an array of strings",
        );
      }
      skipTools.push(item);
    }
  }

  const { yaml, warnings } = await compileTrace(tracePath, outName, skipTools);

  return { yaml, warnings };
}
