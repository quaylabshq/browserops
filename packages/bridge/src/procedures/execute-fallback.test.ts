import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { WSBridgeLike } from "../mcp-server.js";
import { makeProcedureExecutor } from "./execute.js";
import { _resetForTests } from "./state.js";

let tmpDir: string;
const ORIGINAL_ENV = process.env["BROWSEROPS_PROCEDURES_DIR"];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".pbfb-test-"),
  );
  process.env["BROWSEROPS_PROCEDURES_DIR"] = tmpDir;
  _resetForTests();
});

afterEach(async () => {
  if (ORIGINAL_ENV === undefined) delete process.env["BROWSEROPS_PROCEDURES_DIR"];
  else process.env["BROWSEROPS_PROCEDURES_DIR"] = ORIGINAL_ENV;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeYaml(rel: string, doc: unknown): Promise<void> {
  const abs = path.join(tmpDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, YAML.stringify(doc), "utf8");
}

interface Script {
  method: string;
  response?: unknown;
  error?: { code: string; message: string };
}

function stubWsBridge(script: Script[]): WSBridgeLike & {
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let idx = 0;
  return {
    calls,
    isConnected: () => true,
    callExtension: async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> => {
      calls.push({ method, params });
      if (method === "browser_read" && script[idx]?.method !== "browser_read") {
        return { refs: [], content: "", url: "", title: "" } as T;
      }
      const item = script[idx++];
      if (!item) throw new Error(`stub ran out (next was ${method})`);
      if (item.method !== method) {
        throw new Error(`stub expected ${item.method} but got ${method}`);
      }
      if (item.error) {
        const err = new Error(item.error.message) as Error & { code: string };
        err.code = item.error.code;
        throw err;
      }
      return item.response as T;
    },
  };
}

function emptyPageEffect() {
  return {
    dom: { added: 0, removed: 0, attr_changes: 0, text_changes: 0 },
    url: { changed: false },
    focus: { changed: false },
    network: { requests_started: 0, requests_completed: 0, in_flight_at_end: 0 },
    console_errors: 0,
    window_ms: 100,
  };
}

describe("procedure fallback ladder", () => {
  it("retry strategy succeeds on second attempt", async () => {
    await writeYaml("shared/r/procedure.yaml", {
      schema_version: 1,
      name: "r.click",
      description: "retry demo",
      kind: "leaf",
      steps: [
        {
          id: "s1",
          do: "click",
          locator: { role: "button", name: "Send" },
          fallback: {
            strategy: "retry",
            retry: { attempts: 2, backoff_ms: 0 },
          },
        },
      ],
    });

    const ws = stubWsBridge([
      // First attempt — locate ok, click fails
      {
        method: "browser_locate",
        response: {
          matches: [{ ref: 7, role: "button", name: "Send", selector: "#x" }],
          used_snapshot: "current",
        },
      },
      {
        method: "browser_click",
        error: { code: "OCCLUDED_CLICK", message: "occluded" },
      },
      // Second attempt — locate ok, click ok
      {
        method: "browser_locate",
        response: {
          matches: [{ ref: 7, role: "button", name: "Send", selector: "#x" }],
          used_snapshot: "current",
        },
      },
      {
        method: "browser_click",
        response: { clicked: true, page_effect: emptyPageEffect() },
      },
    ]);
    const exec = makeProcedureExecutor(ws);
    const result = await exec({ name: "r.click", tab_id: "t_1", inputs: {} });
    expect(result.completed).toBe(true);
    expect(result.step_results[0]?.resolved_by).toBe("retry");
  });

  it("relocate strategy widens role then succeeds", async () => {
    await writeYaml("shared/rl/procedure.yaml", {
      schema_version: 1,
      name: "rl.click",
      description: "relocate demo",
      kind: "leaf",
      steps: [
        {
          id: "s1",
          do: "click",
          locator: { role: "button", name: "Send" },
          fallback: {
            strategy: "relocate",
            relocate: { widen_role: true },
          },
        },
      ],
    });

    const ws = stubWsBridge([
      // First locate: not found
      {
        method: "browser_locate",
        error: { code: "LOCATOR_NOT_FOUND", message: "no match" },
      },
      // Relocate locate: found
      {
        method: "browser_locate",
        response: {
          matches: [{ ref: 9, role: "link", name: "Send", selector: "#x" }],
          used_snapshot: "current",
        },
      },
      // Click ok
      {
        method: "browser_click",
        response: { clicked: true, page_effect: emptyPageEffect() },
      },
    ]);
    const exec = makeProcedureExecutor(ws);
    const result = await exec({ name: "rl.click", tab_id: "t_1", inputs: {} });
    expect(result.completed).toBe(true);
    expect(result.step_results[0]?.resolved_by).toBe("relocate");
  });

  it("llm strategy halts with needs_assist envelope", async () => {
    await writeYaml("shared/llm/procedure.yaml", {
      schema_version: 1,
      name: "llm.click",
      description: "llm demo",
      kind: "leaf",
      steps: [
        {
          id: "s1",
          do: "click",
          locator: { role: "button", name: "Send" },
          fallback: { strategy: "llm" },
        },
      ],
    });

    const ws = stubWsBridge([
      {
        method: "browser_locate",
        error: { code: "LOCATOR_NOT_FOUND", message: "no match" },
      },
    ]);
    const exec = makeProcedureExecutor(ws);
    const result = await exec({ name: "llm.click", tab_id: "t_1", inputs: {} });

    expect(result.completed).toBe(false);
    expect(result.status).toBe("needs_assist");
    expect(result.execution_id).toMatch(/^ex_/);
    expect(result.envelope?.step_id).toBe("s1");
    expect(result.used_llm_fallback).toBe(true);
  });

  it("strict mode refuses llm fallback even when step declares it", async () => {
    await writeYaml("shared/strict/procedure.yaml", {
      schema_version: 1,
      name: "strict.click",
      description: "strict demo",
      kind: "leaf",
      steps: [
        {
          id: "s1",
          do: "click",
          locator: { role: "button", name: "Send" },
          fallback: { strategy: "llm" },
        },
      ],
    });

    const ws = stubWsBridge([
      {
        method: "browser_locate",
        error: { code: "LOCATOR_NOT_FOUND", message: "no match" },
      },
    ]);
    const exec = makeProcedureExecutor(ws);
    const result = await exec({
      name: "strict.click",
      tab_id: "t_1",
      inputs: {},
      strict: true,
    });

    expect(result.completed).toBe(false);
    expect(result.status).toBe("halted");
    expect(result.used_llm_fallback).toBe(false);
  });

  it("relocate_then_llm escalates to needs_assist when relocate also fails", async () => {
    await writeYaml("shared/rtl/procedure.yaml", {
      schema_version: 1,
      name: "rtl.click",
      description: "relocate_then_llm demo",
      kind: "leaf",
      steps: [
        {
          id: "s1",
          do: "click",
          locator: { role: "button", name: "/^send$/i" },
          fallback: {
            strategy: "relocate_then_llm",
            relocate: { widen_name: true },
          },
        },
      ],
    });

    const ws = stubWsBridge([
      // First locate fails
      {
        method: "browser_locate",
        error: { code: "LOCATOR_NOT_FOUND", message: "no match" },
      },
      // Relocate locate also fails
      {
        method: "browser_locate",
        error: { code: "LOCATOR_NOT_FOUND", message: "still no match" },
      },
    ]);
    const exec = makeProcedureExecutor(ws);
    const result = await exec({
      name: "rtl.click",
      tab_id: "t_1",
      inputs: {},
    });
    expect(result.status).toBe("needs_assist");
  });
});
