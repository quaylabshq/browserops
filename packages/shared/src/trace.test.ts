import { describe, it } from "vitest";
import type { TraceEvent } from "./trace.js";

describe("TraceEvent", () => {
  it("accepts a valid success event", () => {
    const event: TraceEvent = {
      id: "req_001",
      timestamp: "2026-04-24T05:00:00.000Z",
      tool_name: "browser_click",
      duration_ms: 123,
      input: { tab_id: "t_1", ref: "ref_42" },
      result: { ok: true, value: { clicked: true } },
    };
    void event;
  });

  it("accepts a valid error event", () => {
    const event: TraceEvent = {
      id: "req_002",
      timestamp: "2026-04-24T05:00:01.000Z",
      tool_name: "browser_type",
      duration_ms: 55,
      input: { tab_id: "t_1", ref: "ref_7", text: "hello" },
      result: {
        ok: false,
        error_code: "WRITE_NOT_REFLECTED",
        error_message: "Typed text was not found in the element after write.",
      },
    };
    void event;
  });

  it("rejects an event missing the required id field", () => {
    // @ts-expect-error — id is required; omitting it must be a type error
    const bad: TraceEvent = {
      timestamp: "2026-04-24T05:00:02.000Z",
      tool_name: "browser_navigate",
      duration_ms: 200,
      input: { tab_id: "t_2", url: "https://example.com" },
      result: { ok: true, value: null },
    };
    void bad;
  });

  it("input accepts arbitrary JSON-safe shapes (primitives, objects, arrays)", () => {
    const event: TraceEvent = {
      id: "req_003",
      timestamp: "2026-04-24T05:00:03.000Z",
      tool_name: "browser_execute_js",
      duration_ms: 10,
      input: {
        tab_id: "t_3",
        script: "return document.title;",
        nested: { a: 1, b: [true, null, "x"] },
        count: 42,
        flag: false,
      },
      result: { ok: true, value: "Page Title" },
    };
    void event;
  });

  it("result.value for ok:true accepts any JSON shape", () => {
    const event: TraceEvent = {
      id: "req_004",
      timestamp: "2026-04-24T05:00:04.000Z",
      tool_name: "browser_read",
      duration_ms: 300,
      input: { tab_id: "t_4" },
      result: {
        ok: true,
        value: {
          text: "some content",
          refs: ["ref_1", "ref_2"],
          page_effect: {
            dom: { added: 0, removed: 0, attr_changes: 0, text_changes: 0 },
          },
        },
      },
    };
    void event;
  });
});
