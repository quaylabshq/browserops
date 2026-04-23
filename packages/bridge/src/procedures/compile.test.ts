/**
 * Unit tests for procedures_compile (Phase 4 trace-to-YAML compiler).
 *
 * Uses a synthetic 5-event trace (a realistic mini-flow: navigate → read →
 * click → type → navigate) to verify compilation output shape, filtering
 * semantics, and error handling.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { compileTrace, DEFAULT_SKIP_TOOLS } from "./compile.js";
import { handleCompile } from "./compile.js";
import { CodedError } from "./store.js";
import type { TraceEvent } from "@browserops/shared";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeEvent(
  toolName: string,
  input: Record<string, unknown>,
  ok: boolean,
  value?: unknown,
  pageEffect?: {
    dom: { added: number; removed: number; attr_changes: number; text_changes: number };
    url: { changed: boolean; before?: string; after?: string };
    focus: { changed: boolean };
    network: { requests_started: number; requests_completed: number; in_flight_at_end: number };
    console_errors?: number;
    window_ms?: number;
  },
): TraceEvent {
  const result = ok
    ? ({
        ok: true,
        value: pageEffect ? { ...(typeof value === "object" && value ? value : {}), page_effect: pageEffect } : value ?? {},
      } as TraceEvent["result"])
    : ({
        ok: false,
        error_code: "TIMEOUT",
        error_message: "timed out",
      } as TraceEvent["result"]);

  return {
    id: `ev-${toolName}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    tool_name: toolName,
    duration_ms: 200,
    input,
    result,
  };
}

/**
 * A realistic 5-event trace for a "search and click" flow:
 *   1. browser_navigate (mutating, included)   — URL changes, DOM loads
 *   2. browser_read     (read-only, excluded)  — reads a11y tree
 *   3. browser_click    (mutating, included)   — clicks search button, DOM changes
 *   4. browser_type     (mutating, included)   — types query, text changes
 *   5. browser_navigate (mutating, but FAILED, excluded) — navigation that timed out
 *
 * Expected compiled steps: 3 (events 1, 3, 4)
 */
const FIXTURE_EVENTS: TraceEvent[] = [
  // 1: navigate — included (mutating, succeeded, URL changed)
  makeEvent(
    "browser_navigate",
    { tab_id: "t_1", url: "https://example.com/search" },
    true,
    { final_url: "https://example.com/search" },
    {
      dom: { added: 120, removed: 0, attr_changes: 5, text_changes: 10 },
      url: { changed: true, before: "about:blank", after: "https://example.com/search" },
      focus: { changed: false },
      network: { requests_started: 4, requests_completed: 4, in_flight_at_end: 0 },
      console_errors: 0,
      window_ms: 320,
    },
  ),
  // 2: browser_read — excluded (read-only)
  makeEvent(
    "browser_read",
    { tab_id: "t_1", mode: "a11y_tree" },
    true,
    { content: "...", url: "https://example.com/search", title: "Search", mode: "a11y_tree" },
  ),
  // 3: browser_click — included (mutating, succeeded, DOM changed)
  makeEvent(
    "browser_click",
    { tab_id: "t_1", ref: 42 },
    true,
    { clicked: true },
    {
      dom: { added: 3, removed: 1, attr_changes: 2, text_changes: 0 },
      url: { changed: false },
      focus: { changed: true },
      network: { requests_started: 2, requests_completed: 2, in_flight_at_end: 0 },
      console_errors: 0,
      window_ms: 150,
    },
  ),
  // 4: browser_type — included (mutating, succeeded, text changed)
  makeEvent(
    "browser_type",
    { tab_id: "t_1", ref: 100, text: "hello world" },
    true,
    { typed: 11 },
    {
      dom: { added: 0, removed: 0, attr_changes: 0, text_changes: 1 },
      url: { changed: false },
      focus: { changed: false },
      network: { requests_started: 0, requests_completed: 0, in_flight_at_end: 0 },
      console_errors: 0,
      window_ms: 80,
    },
  ),
  // 5: browser_navigate (failed) — excluded
  makeEvent(
    "browser_navigate",
    { tab_id: "t_1", url: "https://example.com/results" },
    false,
  ),
];

// ---------------------------------------------------------------------------
// Test setup — write fixture to a temp dir
// ---------------------------------------------------------------------------

let tmpDir: string;
let fixturePath: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".compile-test-"),
  );
  fixturePath = path.join(tmpDir, "fixture.jsonl");
  const lines = FIXTURE_EVENTS.map((ev) => JSON.stringify(ev)).join("\n");
  await fs.writeFile(fixturePath, lines, "utf8");
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// DEFAULT_SKIP_TOOLS
// ---------------------------------------------------------------------------

describe("DEFAULT_SKIP_TOOLS", () => {
  it("includes all expected read-only tools", () => {
    const expected = [
      "browser_read",
      "browser_list_tabs",
      "browser_pinned_tab",
      "browser_current_tab",
      "browser_query_selector",
      "browser_describe_ref",
      "browser_screenshot",
      "browser_wait_for",
      "browser_wait_for_idle",
    ];
    for (const tool of expected) {
      expect(DEFAULT_SKIP_TOOLS.has(tool)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// compileTrace — happy path
// ---------------------------------------------------------------------------

describe("compileTrace — happy path", () => {
  it("returns a valid YAML string and warnings array", async () => {
    const result = await compileTrace(fixturePath, "example.search_and_click");
    expect(typeof result.yaml).toBe("string");
    expect(result.yaml.length).toBeGreaterThan(0);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("YAML parses without errors", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    expect(() => YAML.parse(yaml)).not.toThrow();
  });

  it("compiled YAML has correct name and schema_version", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    expect(parsed["name"]).toBe("example.search_and_click");
    expect(parsed["schema_version"]).toBe(1);
  });

  it("compiled YAML has kind: leaf", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    expect(parsed["kind"]).toBe("leaf");
  });

  it("derives domain from dotted name prefix", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    const parsed = YAML.parse(yaml) as Record<string, unknown>;
    expect(parsed["domain"]).toBe("example");
  });

  it("produces exactly 3 steps (browser_read excluded, failed navigate excluded)", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    const parsed = YAML.parse(yaml) as { steps: unknown[] };
    expect(Array.isArray(parsed.steps)).toBe(true);
    expect(parsed.steps).toHaveLength(3);
  });

  it("step 1 is browser_navigate with correct params", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    const parsed = YAML.parse(yaml) as { steps: Array<Record<string, unknown>> };
    const step1 = parsed.steps[0]!;
    expect(step1["action"]).toBe("browser_navigate");
    const withParams = step1["with"] as Record<string, unknown>;
    expect(withParams["tab_id"]).toBe("t_1");
    expect(withParams["url"]).toBe("https://example.com/search");
  });

  it("step 2 is browser_click with ref param", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    const parsed = YAML.parse(yaml) as { steps: Array<Record<string, unknown>> };
    const step2 = parsed.steps[1]!;
    expect(step2["action"]).toBe("browser_click");
    const withParams = step2["with"] as Record<string, unknown>;
    expect(withParams["ref"]).toBe(42);
  });

  it("step 3 is browser_type with text param inlined", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    const parsed = YAML.parse(yaml) as { steps: Array<Record<string, unknown>> };
    const step3 = parsed.steps[2]!;
    expect(step3["action"]).toBe("browser_type");
    const withParams = step3["with"] as Record<string, unknown>;
    expect(withParams["text"]).toBe("hello world");
  });

  it("warns about filtered events", async () => {
    const { warnings } = await compileTrace(
      fixturePath,
      "example.search_and_click",
    );
    // 2 events filtered: browser_read + failed navigate
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => w.includes("filtered"))).toBe(true);
  });

  it("preamble comment includes trace path", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    expect(yaml).toContain("# Compiled from trace");
    expect(yaml).toContain(fixturePath);
  });

  it("preamble includes NOTE about inlined params", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    expect(yaml).toContain("NOTE: all params are inlined");
  });
});

// ---------------------------------------------------------------------------
// expected_effect compilation
// ---------------------------------------------------------------------------

describe("expected_effect compilation", () => {
  it("navigate step has url.changed: true (observed change)", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    const parsed = YAML.parse(yaml) as { steps: Array<Record<string, unknown>> };
    const navigateStep = parsed.steps[0]!;
    const effect = navigateStep["expected_effect"] as Record<string, unknown> | undefined;
    expect(effect).toBeDefined();
    const url = effect!["url"] as Record<string, unknown>;
    expect(url["changed"]).toBe(true);
  });

  it("navigate step has dom.any: true (DOM mutations observed)", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    const parsed = YAML.parse(yaml) as { steps: Array<Record<string, unknown>> };
    const navigateStep = parsed.steps[0]!;
    const effect = navigateStep["expected_effect"] as Record<string, unknown>;
    const dom = effect["dom"] as Record<string, unknown>;
    expect(dom["any"]).toBe(true);
  });

  it("navigate step has network.requests_started_min >= 1 (4 observed → 3)", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    const parsed = YAML.parse(yaml) as { steps: Array<Record<string, unknown>> };
    const navigateStep = parsed.steps[0]!;
    const effect = navigateStep["expected_effect"] as Record<string, unknown>;
    const network = effect["network"] as Record<string, unknown>;
    // max(1, 4-1) = 3
    expect(network["requests_started_min"]).toBe(3);
  });

  it("type step has url.changed: false (no navigation)", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    const parsed = YAML.parse(yaml) as { steps: Array<Record<string, unknown>> };
    const typeStep = parsed.steps[2]!;
    const effect = typeStep["expected_effect"] as Record<string, unknown>;
    const url = effect["url"] as Record<string, unknown>;
    expect(url["changed"]).toBe(false);
  });

  it("type step does not have network clause (0 requests started)", async () => {
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click");
    const parsed = YAML.parse(yaml) as { steps: Array<Record<string, unknown>> };
    const typeStep = parsed.steps[2]!;
    const effect = typeStep["expected_effect"] as Record<string, unknown>;
    // 0 requests_started → no network clause
    expect(effect["network"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// skip_tools override
// ---------------------------------------------------------------------------

describe("skip_tools override", () => {
  it("additional skip_tools further filters compiled steps", async () => {
    // Also skip browser_click → only navigate and type remain (2 steps)
    const { yaml } = await compileTrace(fixturePath, "example.search_and_click", [
      "browser_click",
    ]);
    const parsed = YAML.parse(yaml) as { steps: unknown[] };
    expect(parsed.steps).toHaveLength(2);
  });

  it("skipping all mutating tools yields a warning about all events filtered", async () => {
    const { warnings } = await compileTrace(
      fixturePath,
      "example.search_and_click",
      ["browser_navigate", "browser_click", "browser_type"],
    );
    expect(
      warnings.some((w) => w.includes("all") && w.includes("filtered")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("compileTrace — error handling", () => {
  it("throws INVALID_PARAMS for a non-existent trace file", async () => {
    await expect(
      compileTrace("/nonexistent/path/trace.jsonl", "test.proc"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("throws INVALID_PARAMS for an invalid out_name (uppercase)", async () => {
    await expect(
      compileTrace(fixturePath, "Invalid.Name"),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("emits a warning for an empty trace file", async () => {
    const emptyPath = path.join(tmpDir, "empty.jsonl");
    await fs.writeFile(emptyPath, "", "utf8");
    const { warnings } = await compileTrace(emptyPath, "test.empty_flow");
    expect(warnings.some((w) => w.includes("0 events"))).toBe(true);
  });

  it("emits a warning and skips malformed JSON lines", async () => {
    const badPath = path.join(tmpDir, "bad.jsonl");
    const goodLine = JSON.stringify(FIXTURE_EVENTS[0]);
    await fs.writeFile(badPath, `not-json\n${goodLine}\n`, "utf8");
    const { yaml, warnings } = await compileTrace(badPath, "test.bad_lines");
    expect(warnings.some((w) => w.includes("parse error"))).toBe(true);
    // Good line should still produce a step (browser_navigate is mutating)
    const parsed = YAML.parse(yaml) as { steps: unknown[] };
    expect(parsed.steps.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// handleCompile — MCP handler wrapper
// ---------------------------------------------------------------------------

describe("handleCompile", () => {
  it("happy path returns yaml and warnings", async () => {
    const result = await handleCompile({
      trace_path: fixturePath,
      out_name: "example.handler_test",
    });
    expect(typeof result.yaml).toBe("string");
    expect(result.yaml.length).toBeGreaterThan(0);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("throws INVALID_PARAMS when trace_path is missing", async () => {
    await expect(
      handleCompile({ out_name: "example.test" }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("throws INVALID_PARAMS when out_name is missing", async () => {
    await expect(
      handleCompile({ trace_path: fixturePath }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("throws INVALID_PARAMS when skip_tools is not an array", async () => {
    await expect(
      handleCompile({
        trace_path: fixturePath,
        out_name: "example.test",
        skip_tools: "browser_click",
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("throws INVALID_PARAMS when skip_tools contains non-string items", async () => {
    await expect(
      handleCompile({
        trace_path: fixturePath,
        out_name: "example.test",
        skip_tools: [123],
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof CodedError && err.code === "INVALID_PARAMS",
    );
  });

  it("path field is absent in result (never auto-saved)", async () => {
    const result = await handleCompile({
      trace_path: fixturePath,
      out_name: "example.no_autosave",
    });
    expect(result.path).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PROCEDURE_HANDLERS map includes procedures_compile
// ---------------------------------------------------------------------------

describe("PROCEDURE_HANDLERS map", () => {
  it("includes procedures_compile", async () => {
    // Import after the handler is registered
    const { PROCEDURE_HANDLERS } = await import("./handlers.js");
    expect("procedures_compile" in PROCEDURE_HANDLERS).toBe(true);
  });
});
