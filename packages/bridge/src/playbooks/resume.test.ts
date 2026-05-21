import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { WSBridgeLike } from "../mcp-server.js";
import { makePlaybookExecutor } from "./execute.js";
import { makeResumeHandler } from "./resume.js";
import { _resetForTests } from "./state.js";

let tmpDir: string;
const ORIGINAL_ENV = process.env["BROWSEROPS_PLAYBOOKS_DIR"];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(import.meta.dirname ?? __dirname, ".pbres-test-"),
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
    callExtension: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
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

describe("playbooks_resume", () => {
  it("resume_with patch retries the failing step with a new locator", async () => {
    await writeYaml("shared/r/playbook.yaml", {
      schema_version: 1,
      name: "r.click",
      description: "resume_with demo",
      kind: "leaf",
      steps: [
        {
          id: "s1",
          do: "click",
          locator: { role: "button", name: "/^compose$/i" },
          fallback: { strategy: "llm" },
        },
      ],
    });

    const ws = stubWsBridge([
      // First locate fails → needs_assist
      { method: "browser_locate", error: { code: "LOCATOR_NOT_FOUND", message: "no match" } },
      // After resume_with patch:
      {
        method: "browser_locate",
        response: {
          matches: [{ ref: 11, role: "link", name: "New message", selector: "#x" }],
          used_snapshot: "current",
        },
      },
      { method: "browser_click", response: { clicked: true, page_effect: emptyPageEffect() } },
    ]);

    const exec = makePlaybookExecutor(ws);
    const first = await exec({ name: "r.click", tab_id: "t_1", inputs: {} });
    expect(first.status).toBe("needs_assist");

    const resume = makeResumeHandler(ws);
    const second = await resume({
      execution_id: first.execution_id!,
      patch: {
        kind: "resume_with",
        with: { locator: { role: "link", name: "New message" } },
      },
    });
    expect(second.completed).toBe(true);
  });

  it("insert_steps runs the patch steps then continues", async () => {
    await writeYaml("shared/i/playbook.yaml", {
      schema_version: 1,
      name: "i.flow",
      description: "insert_steps demo",
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
      { method: "browser_locate", error: { code: "LOCATOR_NOT_FOUND", message: "blocked" } },
      // Inserted step 1: dismiss banner
      {
        method: "browser_locate",
        response: {
          matches: [{ ref: 4, role: "button", name: "Dismiss", selector: "#d" }],
          used_snapshot: "current",
        },
      },
      { method: "browser_click", response: { clicked: true, page_effect: emptyPageEffect() } },
      // Resumed original step
      {
        method: "browser_locate",
        response: {
          matches: [{ ref: 5, role: "button", name: "Send", selector: "#s" }],
          used_snapshot: "current",
        },
      },
      { method: "browser_click", response: { clicked: true, page_effect: emptyPageEffect() } },
    ]);

    const exec = makePlaybookExecutor(ws);
    const first = await exec({ name: "i.flow", tab_id: "t_1", inputs: {} });
    expect(first.status).toBe("needs_assist");

    const resume = makeResumeHandler(ws);
    const second = await resume({
      execution_id: first.execution_id!,
      patch: {
        kind: "insert_steps",
        steps: [
          {
            id: "_llm_dismiss",
            do: "click",
            locator: { role: "button", name: "Dismiss" },
          },
        ],
      },
    });
    expect(second.completed).toBe(true);
  });

  it("give_up patch returns gave_up and drops state", async () => {
    await writeYaml("shared/g/playbook.yaml", {
      schema_version: 1,
      name: "g.flow",
      description: "give_up demo",
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
      { method: "browser_locate", error: { code: "LOCATOR_NOT_FOUND", message: "x" } },
    ]);
    const exec = makePlaybookExecutor(ws);
    const first = await exec({ name: "g.flow", tab_id: "t_1", inputs: {} });
    expect(first.status).toBe("needs_assist");

    const resume = makeResumeHandler(ws);
    const second = await resume({
      execution_id: first.execution_id!,
      patch: { kind: "give_up", reason: "blocked by cookie wall" },
    });
    expect(second.status).toBe("gave_up");
  });

  it("refuses forbidden locators in resume_with", async () => {
    await writeYaml("shared/f/playbook.yaml", {
      schema_version: 1,
      name: "f.flow",
      description: "forbidden resume",
      kind: "leaf",
      forbidden: { locators: [{ name: "/^delete/i" }] },
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
      { method: "browser_locate", error: { code: "LOCATOR_NOT_FOUND", message: "x" } },
    ]);
    const exec = makePlaybookExecutor(ws);
    const first = await exec({ name: "f.flow", tab_id: "t_1", inputs: {} });
    expect(first.status).toBe("needs_assist");

    const resume = makeResumeHandler(ws);
    await expect(
      resume({
        execution_id: first.execution_id!,
        patch: {
          kind: "resume_with",
          with: { locator: { role: "button", name: "Delete account" } },
        },
      }),
    ).rejects.toThrow(/PLAYBOOK_FORBIDDEN|forbidden/);
  });

  it("returns PLAYBOOK_RESUME_EXPIRED for unknown execution_id", async () => {
    const ws = stubWsBridge([]);
    const resume = makeResumeHandler(ws);
    await expect(
      resume({ execution_id: "ex_nope", patch: { kind: "give_up" } }),
    ).rejects.toThrow(/PLAYBOOK_RESUME_EXPIRED|unknown or has expired/);
  });

  it("rejects unknown patch kinds", async () => {
    await writeYaml("shared/u/playbook.yaml", {
      schema_version: 1,
      name: "u.flow",
      description: "unknown patch kind",
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
      { method: "browser_locate", error: { code: "LOCATOR_NOT_FOUND", message: "x" } },
    ]);
    const exec = makePlaybookExecutor(ws);
    const first = await exec({ name: "u.flow", tab_id: "t_1", inputs: {} });

    const resume = makeResumeHandler(ws);
    await expect(
      resume({
        execution_id: first.execution_id!,
        patch: { kind: "explode" },
      } as unknown as Record<string, unknown>),
    ).rejects.toThrow(/PLAYBOOK_RESUME_INVALID|kind/);
  });
});
