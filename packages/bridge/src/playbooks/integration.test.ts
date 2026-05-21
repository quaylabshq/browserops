/**
 * End-to-end integration: drives the full playbooks_* tool surface against
 * a stub WSBridge, mirroring how mcp-server.ts would route calls.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { WSBridgeLike } from "../mcp-server.js";
import { buildPlaybookHandlers } from "./handlers.js";
import { _resetForTests } from "./state.js";

let tmpDir: string;
const ORIGINAL_ENV = process.env["BROWSEROPS_PLAYBOOKS_DIR"];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".pbint-test-"),
  );
  process.env["BROWSEROPS_PLAYBOOKS_DIR"] = tmpDir;
  _resetForTests();
});

afterEach(async () => {
  if (ORIGINAL_ENV === undefined) delete process.env["BROWSEROPS_PLAYBOOKS_DIR"];
  else process.env["BROWSEROPS_PLAYBOOKS_DIR"] = ORIGINAL_ENV;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

interface Script {
  method: string;
  response?: unknown;
  error?: { code: string; message: string };
}

function stubWsBridge(script: Script[]): WSBridgeLike {
  let idx = 0;
  return {
    isConnected: () => true,
    callExtension: async <T>(method: string, _params: Record<string, unknown>): Promise<T> => {
      const item = script[idx++];
      if (!item) throw new Error(`stub ran out (next ${method})`);
      if (item.method !== method) throw new Error(`expected ${item.method} got ${method}`);
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

const samplePlaybookYaml = YAML.stringify({
  schema_version: 1,
  name: "demo.ship",
  description: "Demo: navigate then click",
  kind: "leaf",
  goal: "Ship a sample request.",
  steps: [
    {
      id: "go",
      do: "navigate",
      with: { url: "https://example.com" },
    },
    {
      id: "submit",
      do: "click",
      locator: { role: "button", name: "/^send$/i" },
      expect: { network_endpoint: "/api/send", timeout_ms: 100, poll_interval_ms: 50 },
      fallback: { strategy: "llm" },
    },
  ],
});

describe("end-to-end playbooks via handlers", () => {
  it("save then execute then succeed", async () => {
    const ws = stubWsBridge([
      // step 1: navigate
      { method: "browser_navigate", response: { ok: true, page_effect: emptyPageEffect() } },
      // step 2: locate the button
      {
        method: "browser_locate",
        response: {
          matches: [{ ref: 5, role: "button", name: "Send", selector: "#x" }],
          used_snapshot: "current",
        },
      },
      // step 2: click — observation includes network endpoint
      {
        method: "browser_click",
        response: {
          clicked: true,
          page_effect: emptyPageEffect(),
          effect: { network: { endpoints: ["/api/send"], requests: 1, failed: 0 } },
        },
      },
    ]);
    const handlers = buildPlaybookHandlers(ws);

    const save = (await handlers["playbooks_save"]!({
      name: "demo.ship",
      yaml: samplePlaybookYaml,
    })) as { saved: boolean };
    expect(save.saved).toBe(true);

    const exec = (await handlers["playbooks_execute"]!({
      name: "demo.ship",
      tab_id: "t_1",
      inputs: {},
    })) as { completed: boolean; status: string };
    expect(exec.completed).toBe(true);
    expect(exec.status).toBe("completed");
  });

  it("needs_assist then resume_with completes", async () => {
    const ws = stubWsBridge([
      // step 1: navigate ok
      { method: "browser_navigate", response: { ok: true, page_effect: emptyPageEffect() } },
      // step 2 first attempt: locate fails
      { method: "browser_locate", error: { code: "LOCATOR_NOT_FOUND", message: "no match" } },
      // After resume_with: locate ok, click ok with endpoint
      {
        method: "browser_locate",
        response: {
          matches: [{ ref: 9, role: "link", name: "Submit", selector: "#x" }],
          used_snapshot: "current",
        },
      },
      {
        method: "browser_click",
        response: {
          clicked: true,
          page_effect: emptyPageEffect(),
          effect: { network: { endpoints: ["/api/send"], requests: 1, failed: 0 } },
        },
      },
    ]);
    const handlers = buildPlaybookHandlers(ws);

    await handlers["playbooks_save"]!({
      name: "demo.ship",
      yaml: samplePlaybookYaml,
    });
    const first = (await handlers["playbooks_execute"]!({
      name: "demo.ship",
      tab_id: "t_1",
      inputs: {},
    })) as { status: string; execution_id?: string; envelope?: { step_id: string } };

    expect(first.status).toBe("needs_assist");
    expect(first.execution_id).toMatch(/^ex_/);
    expect(first.envelope?.step_id).toBe("submit");

    const second = (await handlers["playbooks_resume"]!({
      execution_id: first.execution_id!,
      patch: {
        kind: "resume_with",
        with: { locator: { role: "link", name: "Submit" } },
      },
    })) as { completed: boolean; status: string };

    expect(second.completed).toBe(true);
    expect(second.status).toBe("completed");
  });

  it("strict mode refuses LLM fallback and halts", async () => {
    const ws = stubWsBridge([
      { method: "browser_navigate", response: { ok: true, page_effect: emptyPageEffect() } },
      { method: "browser_locate", error: { code: "LOCATOR_NOT_FOUND", message: "x" } },
    ]);
    const handlers = buildPlaybookHandlers(ws);

    await handlers["playbooks_save"]!({
      name: "demo.ship",
      yaml: samplePlaybookYaml,
    });

    const result = (await handlers["playbooks_execute"]!({
      name: "demo.ship",
      tab_id: "t_1",
      inputs: {},
      strict: true,
    })) as { status: string; used_llm_fallback: boolean };

    expect(result.status).toBe("halted");
    expect(result.used_llm_fallback).toBe(false);
  });
});
