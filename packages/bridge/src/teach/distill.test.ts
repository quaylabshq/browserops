import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as YAML from "yaml";
import type { TeachEvent, TeachSessionMeta } from "@browserops/shared";
import { TeachSessionStore } from "./session-store.js";
import { distillSession } from "./distill.js";
import { validateProcedure } from "../procedures/validator.js";
import { validateBindings } from "../procedures/binding-validator.js";

let tempDir: string;
let store: TeachSessionStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "teach-distill-"));
  process.env["BROWSEROPS_TEACH_DIR"] = tempDir;
  store = new TeachSessionStore();
});

afterEach(() => {
  delete process.env["BROWSEROPS_TEACH_DIR"];
  rmSync(tempDir, { recursive: true, force: true });
});

async function seed(meta: TeachSessionMeta, events: TeachEvent[]): Promise<TeachSessionStore> {
  for (const ev of events) {
    await store.appendEvent(ev);
  }
  // appendEvent auto-creates meta from the first event; overwrite the file
  // and return a fresh store so the in-memory cache doesn't shadow it.
  const path = join(tempDir, `${meta.session_id}.meta.json`);
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(path, JSON.stringify(meta, null, 2) + "\n", "utf8"),
  );
  return new TeachSessionStore();
}

function evt(seq: number, partial: Partial<TeachEvent> & { step: TeachEvent["step"] }): TeachEvent {
  return {
    session_id: partial.session_id ?? "ts_test",
    seq,
    ts: partial.ts ?? 1_700_000_000_000 + seq * 1000,
    tab_id: partial.tab_id ?? "t_1",
    url: partial.url ?? "https://example.com/",
    step: partial.step,
  };
}

describe("distillSession — single leaf paths", () => {
  it("emits a placeholder leaf for an empty session", async () => {
    const fresh = await seed(
      {
        session_id: "ts_empty",
        started_at: 1_700_000_000_000,
        stopped_at: 1_700_000_001_000,
        scope: "all_tabs",
        event_count: 0,
      },
      [],
    );

    const result = await distillSession("ts_empty", fresh);
    expect(result.procedures.length).toBe(1);
    expect(result.procedures[0]?.kind).toBe("leaf");
    expect(result.warnings).toContain("session has 0 events — emitting placeholder leaf");
    expect(validateProcedure(result.procedures[0]?.yaml === undefined ? null : YAML.parse(result.procedures[0].yaml)).valid).toBe(true);
  });

  it("converts navigate + click + key into a valid 3-step single leaf (no composite)", async () => {
    const fresh = await seed(
      {
        session_id: "ts_basic",
        started_at: 1_700_000_000_000,
        stopped_at: 1_700_000_010_000,
        scope: "all_tabs",
        narration_hint: "open hacker news",
        event_count: 3,
      },
      [
        evt(1, {
          session_id: "ts_basic",
          url: "https://news.ycombinator.com/",
          step: { kind: "navigate", url: "https://news.ycombinator.com/" },
        }),
        evt(2, {
          session_id: "ts_basic",
          url: "https://news.ycombinator.com/",
          step: {
            kind: "click",
            target: { selector: "a.storylink", role: "link", name: "Show HN: Cool thing", tag: "a" },
            button: "left",
            modifiers: [],
          },
        }),
        evt(3, {
          session_id: "ts_basic",
          url: "https://news.ycombinator.com/item?id=1",
          step: { kind: "key", keys: ["Meta", "KeyW"] },
        }),
      ],
    );

    const result = await distillSession("ts_basic", fresh);
    expect(result.procedures.length).toBe(1);
    const p = result.procedures[0]!;
    expect(p.kind).toBe("leaf");
    expect(p.draft.steps.length).toBe(3);
    expect((p.draft.steps[1] as { action?: string }).action).toBe("browser_click_by_text");

    const validation = validateProcedure(p.draft);
    expect(validation.valid).toBe(true);
    const bindings = validateBindings(p.draft);
    expect(bindings.valid).toBe(true);
  });

  it("turns redacted typing into a required input + step references {{input.password}}", async () => {
    const fresh = await seed(
      {
        session_id: "ts_login",
        started_at: 1_700_000_000_000,
        stopped_at: 1_700_000_010_000,
        scope: "all_tabs",
        narration_hint: "log in",
        event_count: 2,
      },
      [
        evt(1, {
          session_id: "ts_login",
          url: "https://example.com/login",
          step: { kind: "navigate", url: "https://example.com/login" },
        }),
        evt(2, {
          session_id: "ts_login",
          url: "https://example.com/login",
          step: {
            kind: "type",
            target: {
              selector: "#password",
              role: "textbox",
              name: "Password",
              tag: "input",
              input_type: "password",
            },
            value: "",
            redacted: true,
            redaction_reason: "password",
          },
        }),
      ],
    );

    const result = await distillSession("ts_login", fresh);
    expect(result.redacted_inputs).toContain("password");
    const p = result.procedures[0]!;
    expect(p.draft.inputs?.password?.required).toBe(true);
    const code = (p.draft.steps[1] as { with?: Record<string, unknown> }).with?.["code"] as string;
    expect(code).toContain("{{input.password}}");
    expect(validateProcedure(p.draft).valid).toBe(true);
    expect(validateBindings(p.draft).valid).toBe(true);
  });
});

describe("distillSession — modular split", () => {
  it("splits on a user marker into 2 leaves + 1 composite", async () => {
    const fresh = await seed(
      {
        session_id: "ts_marker",
        started_at: 1_700_000_000_000,
        stopped_at: 1_700_000_020_000,
        scope: "all_tabs",
        narration_hint: "two phase flow",
        event_count: 5,
      },
      [
        evt(1, {
          session_id: "ts_marker",
          url: "https://app.example/",
          step: { kind: "navigate", url: "https://app.example/" },
        }),
        evt(2, {
          session_id: "ts_marker",
          url: "https://app.example/",
          step: {
            kind: "click",
            target: { selector: "button.start", role: "button", name: "Start", tag: "button" },
            button: "left",
            modifiers: [],
          },
        }),
        evt(3, {
          session_id: "ts_marker",
          tab_id: "popup",
          url: "",
          step: { kind: "marker", label: "phase two" },
        }),
        evt(4, {
          session_id: "ts_marker",
          url: "https://app.example/step2",
          step: { kind: "navigate", url: "https://app.example/step2" },
        }),
        evt(5, {
          session_id: "ts_marker",
          url: "https://app.example/step2",
          step: {
            kind: "click",
            target: { selector: "button.finish", role: "button", name: "Finish", tag: "button" },
            button: "left",
            modifiers: [],
          },
        }),
      ],
    );

    const result = await distillSession("ts_marker", fresh);
    expect(result.procedures.length).toBe(3);
    expect(result.procedures[0]?.kind).toBe("leaf");
    expect(result.procedures[1]?.kind).toBe("leaf");
    expect(result.procedures[2]?.kind).toBe("composite");
    // Second leaf should be named after the marker label.
    expect(result.procedures[1]?.name).toMatch(/phase_two/);
    // Composite uses both leaves.
    const composite = result.procedures[2]!.draft;
    expect(composite.uses).toEqual([result.procedures[0]!.name, result.procedures[1]!.name]);
    expect(validateProcedure(composite).valid).toBe(true);
  });

  it("splits on host change", async () => {
    const fresh = await seed(
      {
        session_id: "ts_host",
        started_at: 1_700_000_000_000,
        stopped_at: 1_700_000_010_000,
        scope: "all_tabs",
        event_count: 4,
      },
      [
        evt(1, { session_id: "ts_host", url: "https://a.example/", step: { kind: "navigate", url: "https://a.example/" } }),
        evt(2, {
          session_id: "ts_host",
          url: "https://a.example/",
          step: {
            kind: "click",
            target: { selector: "a", role: "link", name: "Continue to B", tag: "a" },
            button: "left",
            modifiers: [],
          },
        }),
        evt(3, { session_id: "ts_host", url: "https://b.example/", step: { kind: "navigate", url: "https://b.example/" } }),
        evt(4, {
          session_id: "ts_host",
          url: "https://b.example/",
          step: {
            kind: "click",
            target: { selector: "button", role: "button", name: "Done", tag: "button" },
            button: "left",
            modifiers: [],
          },
        }),
      ],
    );

    const result = await distillSession("ts_host", fresh);
    const leaves = result.procedures.filter((p) => p.kind === "leaf");
    expect(leaves.length).toBe(2);
    expect(result.warnings.some((w) => w.includes("host_change"))).toBe(true);
  });

  it("splits on form submit (Enter)", async () => {
    const fresh = await seed(
      {
        session_id: "ts_submit",
        started_at: 1_700_000_000_000,
        stopped_at: 1_700_000_010_000,
        scope: "all_tabs",
        event_count: 4,
      },
      [
        evt(1, { session_id: "ts_submit", url: "https://x.example/", step: { kind: "navigate", url: "https://x.example/" } }),
        evt(2, {
          session_id: "ts_submit",
          url: "https://x.example/",
          step: {
            kind: "type",
            target: { selector: "#q", role: "searchbox", name: "Search", tag: "input", input_type: "search" },
            value: "hello",
            redacted: false,
          },
        }),
        evt(3, { session_id: "ts_submit", url: "https://x.example/", step: { kind: "key", keys: ["Enter"] } }),
        evt(4, {
          session_id: "ts_submit",
          url: "https://x.example/results",
          step: {
            kind: "click",
            target: { selector: "a.r1", role: "link", name: "First Result", tag: "a" },
            button: "left",
            modifiers: [],
          },
        }),
      ],
    );

    const result = await distillSession("ts_submit", fresh);
    const leaves = result.procedures.filter((p) => p.kind === "leaf");
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    // First leaf includes the Enter; second starts with the click.
    expect(leaves[0]!.draft.steps[leaves[0]!.draft.steps.length - 1]).toMatchObject({
      action: "browser_press",
    });
  });
});

describe("distillSession — parameter inference", () => {
  it("auto-parameterises an email value typed into a To: field", async () => {
    const fresh = await seed(
      {
        session_id: "ts_email",
        started_at: 1_700_000_000_000,
        stopped_at: 1_700_000_005_000,
        scope: "all_tabs",
        narration_hint: "send mail",
        event_count: 1,
      },
      [
        evt(1, {
          session_id: "ts_email",
          url: "https://mail.example/",
          step: {
            kind: "type",
            target: { selector: "#to", role: "textbox", name: "To", tag: "input" },
            value: "alice@example.com",
            redacted: false,
          },
        }),
      ],
    );

    const result = await distillSession("ts_email", fresh);
    const candidate = result.parameter_candidates.find((c) => c.value === "alice@example.com");
    expect(candidate?.auto_parameterized).toBe(true);
    expect(candidate?.suggested_name).toBe("to");
    const leaf = result.procedures[0]!;
    expect(leaf.draft.inputs?.["to"]?.required).toBe(true);
    const code = (leaf.draft.steps[0] as { with?: Record<string, unknown> }).with?.["code"] as string;
    expect(code).toContain("{{input.to}}");
    expect(validateBindings(leaf.draft).valid).toBe(true);
  });

  it("surfaces a non-email typed value as a parameter candidate without lifting it", async () => {
    const fresh = await seed(
      {
        session_id: "ts_freetext",
        started_at: 1_700_000_000_000,
        stopped_at: 1_700_000_005_000,
        scope: "all_tabs",
        event_count: 1,
      },
      [
        evt(1, {
          session_id: "ts_freetext",
          url: "https://x.example/",
          step: {
            kind: "type",
            target: { selector: "#q", role: "searchbox", name: "Search query", tag: "input" },
            value: "hello world distill",
            redacted: false,
          },
        }),
      ],
    );

    const result = await distillSession("ts_freetext", fresh);
    const candidate = result.parameter_candidates.find((c) => c.value === "hello world distill");
    expect(candidate).toBeDefined();
    expect(candidate?.auto_parameterized).toBe(false);
    expect(candidate?.suggested_name).toMatch(/search|query/);
    // The typed value is inlined since we didn't auto-parameterise it.
    const leaf = result.procedures[0]!;
    const code = (leaf.draft.steps[0] as { with?: Record<string, unknown> }).with?.["code"] as string;
    expect(code).toContain("hello world distill");
  });
});
