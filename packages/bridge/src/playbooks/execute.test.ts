import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { WSBridgeLike } from "../mcp-server.js";
import { makePlaybookExecutor } from "./execute.js";
import { _resetForTests } from "./state.js";

let tmpDir: string;
const ORIGINAL_ENV = process.env["BROWSEROPS_PLAYBOOKS_DIR"];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".pbexec-test-"),
  );
  process.env["BROWSEROPS_PLAYBOOKS_DIR"] = tmpDir;
  _resetForTests();
});

afterEach(async () => {
  if (ORIGINAL_ENV === undefined) delete process.env["BROWSEROPS_PLAYBOOKS_DIR"];
  else process.env["BROWSEROPS_PLAYBOOKS_DIR"] = ORIGINAL_ENV;
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
      const item = script[idx++];
      if (!item) {
        throw new Error(`stub ran out of scripted calls (next was ${method})`);
      }
      if (item.method !== method) {
        throw new Error(
          `stub expected method ${item.method} but got ${method}`,
        );
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

describe("playbook execute — strict mode", () => {
  it("runs a single navigate step happy path", async () => {
    await writeYaml("shared/demo_a/playbook.yaml", {
      schema_version: 1,
      name: "demo.a",
      description: "demo a",
      kind: "leaf",
      steps: [
        {
          id: "s1",
          do: "navigate",
          with: { url: "https://example.com" },
        },
      ],
    });

    const ws = stubWsBridge([
      {
        method: "browser_navigate",
        response: { ok: true, page_effect: emptyPageEffect() },
      },
    ]);
    const exec = makePlaybookExecutor(ws);
    const result = await exec({ name: "demo.a", tab_id: "t_1", inputs: {} });

    expect(result.completed).toBe(true);
    expect(result.status).toBe("completed");
    expect(ws.calls[0]?.method).toBe("browser_navigate");
    expect(ws.calls[0]?.params["url"]).toBe("https://example.com");
  });

  it("resolves locator + dispatches click with the matched ref", async () => {
    await writeYaml("shared/click_demo/playbook.yaml", {
      schema_version: 1,
      name: "click.demo",
      description: "click demo",
      kind: "leaf",
      steps: [
        {
          id: "s1",
          do: "click",
          locator: { role: "button", name: "Compose" },
        },
      ],
    });

    const ws = stubWsBridge([
      {
        method: "browser_locate",
        response: {
          matches: [{ ref: 7, role: "button", name: "Compose", selector: "#x" }],
          used_snapshot: "current",
        },
      },
      {
        method: "browser_click",
        response: { clicked: true, page_effect: emptyPageEffect() },
      },
    ]);
    const exec = makePlaybookExecutor(ws);
    const result = await exec({ name: "click.demo", tab_id: "t_1", inputs: {} });

    expect(result.completed).toBe(true);
    expect(ws.calls[1]?.params["ref"]).toBe(7);
  });

  it("halts on locator miss with divergence info", async () => {
    await writeYaml("shared/missloc/playbook.yaml", {
      schema_version: 1,
      name: "miss.loc",
      description: "miss locator",
      kind: "leaf",
      steps: [
        {
          id: "s1",
          do: "click",
          locator: { role: "button", name: "Nope" },
        },
      ],
    });

    const ws = stubWsBridge([
      {
        method: "browser_locate",
        error: { code: "LOCATOR_NOT_FOUND", message: "no match" },
      },
    ]);
    const exec = makePlaybookExecutor(ws);
    const result = await exec({ name: "miss.loc", tab_id: "t_1", inputs: {} });

    expect(result.completed).toBe(false);
    expect(result.status).toBe("halted");
    expect(result.divergence?.reason).toMatch(/LOCATOR_NOT_FOUND/);
  });

  it("halts on expect miss with retry strategy not yet implemented (Phase 5 behaviour)", async () => {
    await writeYaml("shared/exp_miss/playbook.yaml", {
      schema_version: 1,
      name: "exp.miss",
      description: "expect miss",
      kind: "leaf",
      steps: [
        {
          id: "s1",
          do: "navigate",
          with: { url: "https://example.com" },
          expect: { url_matches: "/^https://other/", timeout_ms: 100 },
        },
      ],
    });

    const ws = stubWsBridge([
      {
        method: "browser_navigate",
        response: {
          ok: true,
          url: "https://example.com",
          page_effect: emptyPageEffect(),
        },
      },
    ]);
    const exec = makePlaybookExecutor(ws);
    const result = await exec({ name: "exp.miss", tab_id: "t_1", inputs: {} });

    expect(result.completed).toBe(false);
    expect(result.status).toBe("halted");
    expect(result.divergence?.reason).toMatch(/expect failed/);
  });

  it("refuses dispatch matching forbidden locators", async () => {
    await writeYaml("shared/forbid/playbook.yaml", {
      schema_version: 1,
      name: "forbid.click",
      description: "forbid click",
      kind: "leaf",
      forbidden: { locators: [{ name: "/^delete/i" }] },
      steps: [
        {
          id: "s1",
          do: "click",
          locator: { role: "button", name: "Delete account" },
        },
      ],
    });

    const ws = stubWsBridge([]);
    const exec = makePlaybookExecutor(ws);
    const result = await exec({ name: "forbid.click", tab_id: "t_1", inputs: {} });

    expect(result.completed).toBe(false);
    expect(result.divergence?.reason).toMatch(/forbidden/);
    expect(ws.calls).toHaveLength(0);
  });

  it("top-level verify enforced after last step", async () => {
    await writeYaml("shared/verify/playbook.yaml", {
      schema_version: 1,
      name: "verify.demo",
      description: "verify demo",
      kind: "leaf",
      verify: { text_visible: "Done", timeout_ms: 100, poll_interval_ms: 50 },
      steps: [
        {
          id: "s1",
          do: "navigate",
          with: { url: "https://example.com" },
        },
      ],
    });

    const ws = stubWsBridge([
      {
        method: "browser_navigate",
        // No "text" → verify will fail
        response: { ok: true, page_effect: emptyPageEffect() },
      },
    ]);
    const exec = makePlaybookExecutor(ws);
    const result = await exec({ name: "verify.demo", tab_id: "t_1", inputs: {} });

    expect(result.completed).toBe(false);
    expect(result.verify_passed).toBe(false);
  });

  it("input substitution feeds into with: params", async () => {
    await writeYaml("shared/sub/playbook.yaml", {
      schema_version: 1,
      name: "sub.demo",
      description: "sub demo",
      kind: "leaf",
      inputs: { target: { type: "string", required: true } },
      steps: [
        {
          id: "s1",
          do: "navigate",
          with: { url: "https://example.com/{{input.target}}" },
        },
      ],
    });

    const ws = stubWsBridge([
      {
        method: "browser_navigate",
        response: { ok: true, page_effect: emptyPageEffect() },
      },
    ]);
    const exec = makePlaybookExecutor(ws);
    await exec({ name: "sub.demo", tab_id: "t_1", inputs: { target: "abc" } });

    expect(ws.calls[0]?.params["url"]).toBe("https://example.com/abc");
  });

  it("PLAYBOOK_NOT_FOUND when name is missing", async () => {
    const ws = stubWsBridge([]);
    const exec = makePlaybookExecutor(ws);
    await expect(
      exec({ name: "nope", tab_id: "t_1", inputs: {} }),
    ).rejects.toThrow(/PLAYBOOK_NOT_FOUND|playbook not found/);
  });

  it("INVALID_PARAMS when name pattern violated", async () => {
    const ws = stubWsBridge([]);
    const exec = makePlaybookExecutor(ws);
    await expect(
      exec({ name: "BAD_NAME", tab_id: "t_1", inputs: {} }),
    ).rejects.toThrow(/must match/);
  });
});

function emptyPageEffect() {
  return {
    dom: { added: 0, removed: 0, attr_changes: 0, text_changes: 0 },
    url: { changed: false },
    focus: { changed: false },
    network: {
      requests_started: 0,
      requests_completed: 0,
      in_flight_at_end: 0,
    },
    console_errors: 0,
    window_ms: 100,
  };
}
