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
  // with our desired meta (narration_hint, scope, etc.) and return a fresh
  // store so the in-memory cache from append doesn't shadow the override.
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
    ts: 1_700_000_000_000 + seq * 1000,
    tab_id: partial.tab_id ?? "t_1",
    url: partial.url ?? "https://example.com/",
    step: partial.step,
  };
}

describe("distillSession", () => {
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
    expect(result.warnings).toContain("session has 0 events — emitting placeholder leaf");
    expect(result.draft.kind).toBe("leaf");
    expect(result.draft.steps.length).toBe(1);
    const validation = validateProcedure(result.draft);
    expect(validation.valid).toBe(true);
  });

  it("converts navigate + click + key into a valid 3-step leaf", async () => {
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
            target: {
              selector: "a.storylink",
              role: "link",
              name: "Show HN: Cool thing",
              tag: "a",
            },
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
    expect(result.warnings).toEqual([]);
    expect(result.draft.steps.length).toBe(3);
    expect((result.draft.steps[0] as { action?: string }).action).toBe("browser_navigate");
    expect((result.draft.steps[1] as { action?: string }).action).toBe("browser_click_by_text");
    const keyStep = result.draft.steps[2] as { with?: Record<string, unknown> };
    expect((keyStep.with?.["keys"] as string[])[0]).toBe("Primary"); // Meta normalised
    expect(result.draft.domain).toBe("ycombinator");
    expect(result.draft.name).toMatch(/^ycombinator\.open_hacker_news/);

    const validation = validateProcedure(result.draft);
    expect(validation.valid).toBe(true);
    const bindings = validateBindings(result.draft);
    expect(bindings.valid).toBe(true);
  });

  it("turns redacted typing into a required input", async () => {
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
    expect(result.draft.inputs?.password?.required).toBe(true);
    expect(result.draft.inputs?.password?.type).toBe("string");

    const typeStep = result.draft.steps.find((s) => "action" in s && s.action === "browser_execute_js");
    expect(typeStep).toBeDefined();
    const code = (typeStep as { with?: Record<string, unknown> }).with?.["code"] as string;
    expect(code).toContain("{{input.password}}");

    const validation = validateProcedure(result.draft);
    expect(validation.valid).toBe(true);
    const bindings = validateBindings(result.draft);
    expect(bindings.valid).toBe(true);
  });

  it("flattens multi-tab events onto the dominant tab and warns", async () => {
    const fresh = await seed(
      {
        session_id: "ts_multi",
        started_at: 1_700_000_000_000,
        stopped_at: 1_700_000_010_000,
        scope: "all_tabs",
        event_count: 4,
      },
      [
        evt(1, {
          session_id: "ts_multi",
          tab_id: "t_1",
          url: "https://a.example/",
          step: { kind: "navigate", url: "https://a.example/" },
        }),
        evt(2, {
          session_id: "ts_multi",
          tab_id: "t_1",
          url: "https://a.example/",
          step: {
            kind: "click",
            target: { selector: "button", role: "button", name: "OK", tag: "button" },
            button: "left",
            modifiers: [],
          },
        }),
        evt(3, {
          session_id: "ts_multi",
          tab_id: "t_2",
          url: "https://b.example/",
          step: { kind: "navigate", url: "https://b.example/" },
        }),
      ],
    );

    const result = await distillSession("ts_multi", fresh);
    expect(result.warnings.some((w) => w.includes("dropped"))).toBe(true);
    expect(result.draft.steps.length).toBe(2); // only t_1 events
  });

  it("renders YAML that parses back to the same procedure shape", async () => {
    const fresh = await seed(
      {
        session_id: "ts_yaml",
        started_at: 1_700_000_000_000,
        stopped_at: 1_700_000_001_000,
        scope: "all_tabs",
        narration_hint: "test yaml roundtrip",
        event_count: 1,
      },
      [
        evt(1, {
          session_id: "ts_yaml",
          step: { kind: "navigate", url: "https://example.com/" },
        }),
      ],
    );

    const result = await distillSession("ts_yaml", fresh);
    // Strip leading comments (yaml package tolerates them, but parse the
    // body alone for clean comparison)
    const parsed = YAML.parse(result.yaml) as Record<string, unknown>;
    expect(parsed["schema_version"]).toBe(1);
    expect(parsed["kind"]).toBe("leaf");
    expect(Array.isArray(parsed["steps"])).toBe(true);
    const validation = validateProcedure(parsed);
    expect(validation.valid).toBe(true);
  });
});
