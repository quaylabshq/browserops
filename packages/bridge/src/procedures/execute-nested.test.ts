import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { WSBridgeLike } from "../mcp-server.js";
import { buildProcedureHandlers } from "./handlers.js";
import { _resetForTests } from "./state.js";

let tmpDir: string;
const ORIGINAL_ENV = process.env["BROWSEROPS_PROCEDURES_DIR"];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".pbnest-test-"),
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

function stubWsBridge(script: Script[]): WSBridgeLike {
  let idx = 0;
  return {
    isConnected: () => true,
    callExtension: async <T>(
      method: string,
      _params: Record<string, unknown>,
    ): Promise<T> => {
      if (method === "browser_read" && script[idx]?.method !== "browser_read") {
        return { refs: [], content: "", url: "", title: "" } as T;
      }
      const item = script[idx++];
      if (!item) throw new Error(`stub ran out (next ${method})`);
      if (item.method !== method) {
        throw new Error(`expected ${item.method} got ${method}`);
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

describe("nested execution", () => {
  it("procedure calls another procedure in-process", async () => {
    // Inner: just navigate
    await writeYaml("shared/inner/procedure.yaml", {
      schema_version: 1,
      name: "inner.flow",
      description: "inner flow",
      kind: "leaf",
      steps: [
        { id: "s1", do: "navigate", with: { url: "https://example.com" } },
      ],
    });
    // Outer composite: calls inner
    await writeYaml("composite_outer/procedure.yaml", {
      schema_version: 1,
      name: "outer.flow",
      description: "outer flow",
      kind: "composite",
      uses: ["inner.flow"],
      steps: [
        {
          id: "s1",
          do: "procedure_call",
          with: { name: "inner.flow", tab_id: "{{tab_id}}", inputs: {} },
        },
      ],
    });

    const ws = stubWsBridge([
      // Single navigate call from inner procedure
      {
        method: "browser_navigate",
        response: { ok: true, page_effect: emptyPageEffect() },
      },
    ]);
    const handlers = buildProcedureHandlers(ws);

    const result = await handlers["procedures_execute"]!({
      name: "outer.flow",
      tab_id: "t_1",
      inputs: {},
    });
    expect((result as { completed: boolean }).completed).toBe(true);
  });
});
