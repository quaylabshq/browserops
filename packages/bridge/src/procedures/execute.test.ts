/**
 * Unit tests for procedures_execute (Phase 5 effect-verified replay).
 *
 * Each test builds a minimal procedure YAML, writes it to a temp dir,
 * sets BROWSEROPS_PROCEDURES_DIR, then calls the execute handler with a
 * mocked WSBridgeLike. The mock controls what page_effect each step returns.
 *
 * Scenarios covered:
 *   1. Happy path — 3 steps, all expected_effects match → completed: true
 *   2. Divergence on step 2 (dom.any expected, none observed) → halts with structured report
 *   3. Missing page_effect when expected_effect present → divergence
 *   4. Missing expected_effect → step auto-matches
 *   5. Input {{var}} substitution flows through to callExtension params
 *   6. max_steps cap — stops after N steps even if more remain
 *   7. Tool call error mid-procedure → completed: false, error surfaced
 *   8. EXTENSION_DISCONNECTED → CodedError thrown before any steps run
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { makeExecuteHandler } from "./execute.js";
import type { WSBridgeLike } from "../mcp-server.js";
import { CodedError } from "./store.js";
import type { PageEffect } from "@browserops/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePageEffect(overrides: Partial<{
  dom: Partial<PageEffect["dom"]>;
  url: Partial<PageEffect["url"]>;
  focus: Partial<PageEffect["focus"]>;
  network: Partial<PageEffect["network"]>;
  console_errors: number;
  window_ms: number;
}>= {}): PageEffect {
  return {
    dom: {
      added: 0,
      removed: 0,
      attr_changes: 0,
      text_changes: 0,
      ...(overrides.dom ?? {}),
    },
    url: {
      changed: false,
      ...(overrides.url ?? {}),
    },
    focus: {
      changed: false,
      ...(overrides.focus ?? {}),
    },
    network: {
      requests_started: 0,
      requests_completed: 0,
      in_flight_at_end: 0,
      ...(overrides.network ?? {}),
    },
    console_errors: overrides.console_errors ?? 0,
    window_ms: overrides.window_ms ?? 100,
  };
}

function makeConnectedBridge(
  callExtensionImpl?: (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>,
): WSBridgeLike {
  return {
    isConnected: () => true,
    callExtension: callExtensionImpl
      ? vi.fn().mockImplementation(callExtensionImpl)
      : vi.fn().mockResolvedValue({ ok: true }),
  };
}

function makeDisconnectedBridge(): WSBridgeLike {
  return {
    isConnected: () => false,
    callExtension: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Procedure YAML builders
// ---------------------------------------------------------------------------

function makeLeafYaml(
  name: string,
  steps: Array<{
    id: string;
    action: string;
    with?: Record<string, unknown>;
    expected_effect?: Record<string, unknown>;
  }>,
  inputs?: Record<string, { type: string; required?: boolean }>,
): string {
  const doc: Record<string, unknown> = {
    schema_version: 1,
    name,
    description: `Test procedure ${name}`,
    kind: "leaf",
    steps: steps.map((s) => {
      const step: Record<string, unknown> = { id: s.id, action: s.action };
      if (s.with) step["with"] = s.with;
      if (s.expected_effect) step["expected_effect"] = s.expected_effect;
      return step;
    }),
  };
  if (inputs) doc["inputs"] = inputs;
  return YAML.stringify(doc);
}

// ---------------------------------------------------------------------------
// Temp dir setup (per describe block)
// ---------------------------------------------------------------------------

let tmpDir: string;

async function writeProcedure(name: string, yaml: string): Promise<void> {
  // Shared procedures go in shared/<name>/procedure.yaml
  const dir = path.join(tmpDir, "shared", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "procedure.yaml"), yaml, "utf8");
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp("/tmp/execute-test-");
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env["BROWSEROPS_PROCEDURES_DIR"] = tmpDir;
  // Clear the module-level index cache by deleting the index file if present
});

afterEach(async () => {
  // Remove shared dir to reset state between tests
  await fs.rm(path.join(tmpDir, "shared"), { recursive: true, force: true });
  // Also remove any index file
  await fs.rm(path.join(tmpDir, "index.json"), { force: true });
  delete process.env["BROWSEROPS_PROCEDURES_DIR"];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("procedures_execute", () => {
  it("happy path: 3 steps all match → completed: true", async () => {
    const name = "test.happy_path";

    // navigate: DOM loaded + URL changed
    const navEffect = makePageEffect({
      dom: { added: 120, removed: 0, attr_changes: 5, text_changes: 10 },
      url: { changed: true },
    });
    // click: DOM mutations, no URL change
    const domEffect = makePageEffect({ dom: { added: 5, removed: 0, attr_changes: 0, text_changes: 0 } });
    // type: focus changed
    const focusEffect = makePageEffect({ focus: { changed: true } });

    await writeProcedure(name, makeLeafYaml(name, [
      {
        id: "step_01_navigate",
        action: "browser_navigate",
        with: { tab_id: "t_1", url: "https://example.com" },
        expected_effect: { dom: { any: true }, url: { changed: true } },
      },
      {
        id: "step_02_click",
        action: "browser_click",
        with: { tab_id: "t_1", ref: 10 },
        expected_effect: { dom: { any: true } },
      },
      {
        id: "step_03_focus",
        action: "browser_type",
        with: { tab_id: "t_1", ref: 11, text: "hello" },
        expected_effect: { focus: { changed: true } },
      },
    ]));

    let callCount = 0;
    const effects = [
      { page_effect: navEffect },                    // navigate: DOM + URL change
      { clicked: true, page_effect: domEffect },    // click: DOM change
      { typed: true, page_effect: focusEffect },    // type: focus change
    ];

    const bridge = makeConnectedBridge(async () => {
      return effects[callCount++]!;
    });

    const handler = makeExecuteHandler(bridge);
    const result = await handler({ name });

    expect(result.completed).toBe(true);
    expect(result.steps_executed).toBe(3);
    expect(result.step_results).toHaveLength(3);
    expect(result.step_results.every((s) => s.matched)).toBe(true);
    expect(result.divergence).toBeUndefined();
    expect(bridge.callExtension).toHaveBeenCalledTimes(3);
  });

  it("divergence on step 2 (dom.any expected, no DOM observed) → halts with structured report", async () => {
    const name = "test.diverge_step2";

    await writeProcedure(name, makeLeafYaml(name, [
      {
        id: "step_01_navigate",
        action: "browser_navigate",
        with: { tab_id: "t_1", url: "https://example.com" },
        expected_effect: { url: { changed: true } },
      },
      {
        id: "step_02_click",
        action: "browser_click",
        with: { tab_id: "t_1", ref: 10 },
        expected_effect: { dom: { any: true } },  // expects DOM mutation
      },
      {
        id: "step_03_type",
        action: "browser_type",
        with: { tab_id: "t_1", ref: 11, text: "hello" },
      },
    ]));

    let callCount = 0;
    const effects: Array<Record<string, unknown>> = [
      { page_effect: makePageEffect({ url: { changed: true } }) },  // step 1 OK
      // step 2: returns page_effect with NO DOM mutations — diverges from dom.any: true
      { page_effect: makePageEffect({ dom: { added: 0, removed: 0, attr_changes: 0, text_changes: 0 } }) },
    ];

    const bridge = makeConnectedBridge(async () => {
      return effects[callCount++]!;
    });

    const handler = makeExecuteHandler(bridge);
    const result = await handler({ name });

    expect(result.completed).toBe(false);
    expect(result.steps_executed).toBe(2);
    expect(result.step_results).toHaveLength(2);
    expect(result.step_results[0]!.matched).toBe(true);
    expect(result.step_results[1]!.matched).toBe(false);

    // step 3 was never called
    expect(bridge.callExtension).toHaveBeenCalledTimes(2);

    expect(result.divergence).toBeDefined();
    expect(result.divergence!.step_id).toBe("step_02_click");
    expect(result.divergence!.step_index).toBe(1);
    expect(result.divergence!.reason).toContain("dom.any: true");
    expect(result.divergence!.reason).toContain("no DOM mutations");

    expect(result.final_step).toBeDefined();
    expect(result.final_step!.id).toBe("step_02_click");
    expect(result.final_step!.divergence).toBeDefined();
  });

  it("missing page_effect when expected_effect present → divergence", async () => {
    const name = "test.missing_page_effect";

    await writeProcedure(name, makeLeafYaml(name, [
      {
        id: "step_01_click",
        action: "browser_click",
        with: { tab_id: "t_1", ref: 5 },
        expected_effect: { dom: { any: true } },
      },
    ]));

    // Tool returns result WITHOUT page_effect
    const bridge = makeConnectedBridge(async () => ({ clicked: true }));

    const handler = makeExecuteHandler(bridge);
    const result = await handler({ name });

    expect(result.completed).toBe(false);
    expect(result.steps_executed).toBe(1);
    expect(result.divergence).toBeDefined();
    expect(result.divergence!.reason).toBe("observed page_effect unavailable");
  });

  it("missing expected_effect → step auto-matches", async () => {
    const name = "test.no_expected_effect";

    await writeProcedure(name, makeLeafYaml(name, [
      {
        id: "step_01_navigate",
        action: "browser_navigate",
        with: { tab_id: "t_1", url: "https://example.com" },
        // No expected_effect
      },
      {
        id: "step_02_click",
        action: "browser_click",
        with: { tab_id: "t_1", ref: 7 },
        // No expected_effect
      },
    ]));

    // Even without page_effect in the response, steps should auto-match
    const bridge = makeConnectedBridge(async () => ({ ok: true }));

    const handler = makeExecuteHandler(bridge);
    const result = await handler({ name });

    expect(result.completed).toBe(true);
    expect(result.steps_executed).toBe(2);
    expect(result.step_results.every((s) => s.matched)).toBe(true);
    expect(result.divergence).toBeUndefined();
  });

  it("input {{var}} substitution is applied to step params", async () => {
    const name = "test.var_substitution";

    await writeProcedure(name, makeLeafYaml(
      name,
      [
        {
          id: "step_01_navigate",
          action: "browser_navigate",
          with: { tab_id: "{{tab_id}}", url: "{{url}}" },
        },
        {
          id: "step_02_type",
          action: "browser_type",
          with: { tab_id: "{{tab_id}}", ref: 1, text: "{{query}}" },
        },
      ],
      {
        tab_id: { type: "string", required: true },
        url: { type: "string", required: true },
        query: { type: "string", required: true },
      },
    ));

    const capturedCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const bridge = makeConnectedBridge(async (method, params) => {
      capturedCalls.push({ method, params: { ...params } });
      return { ok: true };
    });

    const handler = makeExecuteHandler(bridge);
    await handler({
      name,
      inputs: { tab_id: "t_42", url: "https://test.com", query: "hello world" },
    });

    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[0]!.params["tab_id"]).toBe("t_42");
    expect(capturedCalls[0]!.params["url"]).toBe("https://test.com");
    expect(capturedCalls[1]!.params["tab_id"]).toBe("t_42");
    expect(capturedCalls[1]!.params["text"]).toBe("hello world");
  });

  it("{{input.NAME}} placeholders resolve against bare input keys", async () => {
    // Mirrors the binding-validator's contract: YAML must use `{{input.NAME}}`
    // for input refs, but callers pass the natural shape `{NAME: value}` —
    // not `{"input.NAME": value}`. The executor must strip the prefix.
    const name = "test.input_dot_substitution";

    await writeProcedure(name, makeLeafYaml(
      name,
      [
        {
          id: "step_01_navigate",
          action: "browser_navigate",
          with: { tab_id: "{{tab_id}}", url: "{{input.url}}" },
        },
        {
          id: "step_02_type",
          action: "browser_type",
          with: { tab_id: "{{tab_id}}", ref: 1, text: "{{input.query}}" },
        },
      ],
      {
        url: { type: "string", required: true },
        query: { type: "string", required: true },
      },
    ));

    const capturedCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const bridge = makeConnectedBridge(async (method, params) => {
      capturedCalls.push({ method, params: { ...params } });
      return { ok: true };
    });

    const handler = makeExecuteHandler(bridge);
    await handler({
      name,
      inputs: { tab_id: "t_99", url: "https://example.com", query: "find me" },
    });

    expect(capturedCalls).toHaveLength(2);
    expect(capturedCalls[0]!.params["tab_id"]).toBe("t_99");
    expect(capturedCalls[0]!.params["url"]).toBe("https://example.com");
    expect(capturedCalls[1]!.params["text"]).toBe("find me");
  });

  it("{{input.NAME}} also accepts the legacy prefixed key for backward compat", async () => {
    // Older callers may still be passing inputs with the literal `input.NAME`
    // key. Accept that too so we don't silently break them.
    const name = "test.input_dot_legacy";

    await writeProcedure(name, makeLeafYaml(
      name,
      [{
        id: "step_01_navigate",
        action: "browser_navigate",
        with: { tab_id: "{{tab_id}}", url: "{{input.url}}" },
      }],
      { url: { type: "string", required: true } },
    ));

    const capturedCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const bridge = makeConnectedBridge(async (method, params) => {
      capturedCalls.push({ method, params: { ...params } });
      return { ok: true };
    });

    const handler = makeExecuteHandler(bridge);
    await handler({
      name,
      inputs: { tab_id: "t_55", "input.url": "https://legacy.example" },
    });

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.params["url"]).toBe("https://legacy.example");
  });

  it("max_steps cap stops execution after N steps", async () => {
    const name = "test.max_steps";

    await writeProcedure(name, makeLeafYaml(name, [
      { id: "step_01", action: "browser_navigate", with: { tab_id: "t_1", url: "https://a.com" } },
      { id: "step_02", action: "browser_click", with: { tab_id: "t_1", ref: 1 } },
      { id: "step_03", action: "browser_click", with: { tab_id: "t_1", ref: 2 } },
      { id: "step_04", action: "browser_click", with: { tab_id: "t_1", ref: 3 } },
    ]));

    const bridge = makeConnectedBridge(async () => ({ ok: true }));

    const handler = makeExecuteHandler(bridge);
    const result = await handler({ name, max_steps: 2 });

    expect(result.steps_executed).toBe(2);
    // completed is true because max_steps was reached without divergence
    expect(result.completed).toBe(true);
    expect(bridge.callExtension).toHaveBeenCalledTimes(2);
    expect(result.step_results).toHaveLength(2);
  });

  it("tool call error mid-procedure → completed: false, error surfaced", async () => {
    const name = "test.tool_error";

    await writeProcedure(name, makeLeafYaml(name, [
      { id: "step_01_navigate", action: "browser_navigate", with: { tab_id: "t_1", url: "https://x.com" } },
      { id: "step_02_click", action: "browser_click", with: { tab_id: "t_1", ref: 5 } },
      { id: "step_03_type", action: "browser_type", with: { tab_id: "t_1", ref: 6, text: "hi" } },
    ]));

    let callCount = 0;
    const bridge = makeConnectedBridge(async () => {
      callCount++;
      if (callCount === 2) {
        throw Object.assign(new Error("element not found"), { code: "REF_STALE" });
      }
      return { ok: true };
    });

    const handler = makeExecuteHandler(bridge);
    const result = await handler({ name });

    expect(result.completed).toBe(false);
    expect(result.steps_executed).toBe(2);
    expect(result.divergence).toBeDefined();
    expect(result.divergence!.step_id).toBe("step_02_click");
    expect(result.divergence!.reason).toContain("tool call error");
    expect(result.divergence!.reason).toContain("element not found");

    // Step 3 was not executed
    expect(bridge.callExtension).toHaveBeenCalledTimes(2);
  });

  it("EXTENSION_DISCONNECTED → CodedError thrown before any steps run", async () => {
    const name = "test.disconnected";

    await writeProcedure(name, makeLeafYaml(name, [
      { id: "step_01", action: "browser_navigate", with: { tab_id: "t_1", url: "https://x.com" } },
    ]));

    const bridge = makeDisconnectedBridge();
    const handler = makeExecuteHandler(bridge);

    await expect(handler({ name })).rejects.toMatchObject({
      code: "EXTENSION_DISCONNECTED",
    });

    expect(bridge.callExtension).not.toHaveBeenCalled();
  });

  it("PROC_NOT_FOUND → CodedError when procedure does not exist", async () => {
    const bridge = makeConnectedBridge();
    const handler = makeExecuteHandler(bridge);

    await expect(handler({ name: "nonexistent.procedure" })).rejects.toMatchObject({
      code: "PROC_NOT_FOUND",
    });
  });

  it("INVALID_PARAMS → CodedError on bad name", async () => {
    const bridge = makeConnectedBridge();
    const handler = makeExecuteHandler(bridge);

    await expect(handler({ name: "INVALID NAME!" })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
  });

  it("INVALID_PARAMS → CodedError on non-integer max_steps", async () => {
    const name = "test.bad_max_steps";

    await writeProcedure(name, makeLeafYaml(name, [
      { id: "step_01", action: "browser_navigate", with: { tab_id: "t_1", url: "https://x.com" } },
    ]));

    const bridge = makeConnectedBridge();
    const handler = makeExecuteHandler(bridge);

    await expect(handler({ name, max_steps: 0 })).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
  });
});

// ---------------------------------------------------------------------------
// checkExpectation unit tests (isolated from the handler)
// ---------------------------------------------------------------------------

import { checkExpectation } from "./expected-effect.js";

describe("checkExpectation", () => {
  const zeroEffect = makePageEffect();

  it("undefined expected → matched: true", () => {
    expect(checkExpectation(undefined, zeroEffect)).toEqual({ matched: true });
  });

  it("undefined observed with assertion → matched: false", () => {
    const result = checkExpectation({ dom: { any: true } }, undefined);
    expect(result.matched).toBe(false);
    expect((result as { matched: false; reason: string }).reason).toBe("observed page_effect unavailable");
  });

  it("dom.any: true with mutations → matched", () => {
    const obs = makePageEffect({ dom: { added: 1, removed: 0, attr_changes: 0, text_changes: 0 } });
    expect(checkExpectation({ dom: { any: true } }, obs)).toEqual({ matched: true });
  });

  it("dom.any: true with no mutations → not matched", () => {
    const result = checkExpectation({ dom: { any: true } }, zeroEffect);
    expect(result.matched).toBe(false);
    expect((result as { matched: false; reason: string }).reason).toContain("dom.any: true");
  });

  it("dom.added_min passes when observed >= min", () => {
    const obs = makePageEffect({ dom: { added: 5, removed: 0, attr_changes: 0, text_changes: 0 } });
    expect(checkExpectation({ dom: { added_min: 3 } }, obs)).toEqual({ matched: true });
  });

  it("dom.added_min fails when observed < min", () => {
    const obs = makePageEffect({ dom: { added: 2, removed: 0, attr_changes: 0, text_changes: 0 } });
    const result = checkExpectation({ dom: { added_min: 5 } }, obs);
    expect(result.matched).toBe(false);
    expect((result as { matched: false; reason: string }).reason).toContain("dom.added_min: 5");
  });

  it("url.changed: true matches when URL did change", () => {
    const obs = makePageEffect({ url: { changed: true } });
    expect(checkExpectation({ url: { changed: true } }, obs)).toEqual({ matched: true });
  });

  it("url.changed: true fails when URL did not change", () => {
    const result = checkExpectation({ url: { changed: true } }, zeroEffect);
    expect(result.matched).toBe(false);
    expect((result as { matched: false; reason: string }).reason).toContain("url.changed");
  });

  it("focus.changed: false passes when focus did not change", () => {
    expect(checkExpectation({ focus: { changed: false } }, zeroEffect)).toEqual({ matched: true });
  });

  it("focus.changed: true fails when focus did not change", () => {
    const result = checkExpectation({ focus: { changed: true } }, zeroEffect);
    expect(result.matched).toBe(false);
    expect((result as { matched: false; reason: string }).reason).toContain("focus.changed");
  });

  it("network.requests_started_min passes", () => {
    const obs = makePageEffect({ network: { requests_started: 3, requests_completed: 3, in_flight_at_end: 0 } });
    expect(checkExpectation({ network: { requests_started_min: 2 } }, obs)).toEqual({ matched: true });
  });

  it("network.requests_started_min fails when below min", () => {
    const result = checkExpectation({ network: { requests_started_min: 5 } }, zeroEffect);
    expect(result.matched).toBe(false);
    expect((result as { matched: false; reason: string }).reason).toContain("network.requests_started_min: 5");
  });

  it("console_errors_max passes when errors within limit", () => {
    const obs = makePageEffect({ console_errors: 2 });
    expect(checkExpectation({ console_errors_max: 3 }, obs)).toEqual({ matched: true });
  });

  it("console_errors_max fails when errors exceed limit", () => {
    const obs = makePageEffect({ console_errors: 5 });
    const result = checkExpectation({ console_errors_max: 2 }, obs);
    expect(result.matched).toBe(false);
    expect((result as { matched: false; reason: string }).reason).toContain("console_errors_max: 2");
  });

  it("multiple assertions: first failure is reported", () => {
    // url.changed: true fails, dom.any: true would also fail but is checked first
    const result = checkExpectation(
      { dom: { any: true }, url: { changed: true } },
      zeroEffect, // no DOM, no URL change
    );
    expect(result.matched).toBe(false);
    // dom is checked first
    expect((result as { matched: false; reason: string }).reason).toContain("dom.any");
  });

  it("all assertions pass → matched: true", () => {
    const obs = makePageEffect({
      dom: { added: 2, removed: 1, attr_changes: 0, text_changes: 0 },
      url: { changed: true },
      focus: { changed: false },
      network: { requests_started: 3, requests_completed: 2, in_flight_at_end: 1 },
      console_errors: 0,
    });
    expect(checkExpectation(
      {
        dom: { any: true, added_min: 1 },
        url: { changed: true },
        focus: { changed: false },
        network: { requests_started_min: 2 },
        console_errors_max: 1,
      },
      obs,
    )).toEqual({ matched: true });
  });
});
