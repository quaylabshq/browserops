import { describe, expect, it } from "vitest";
import type { AutoTeachTraceRecord } from "@browserops/shared";
import { distill } from "./distiller.js";
import { normalize } from "./distiller-ir.js";
import { collapseRetries } from "./stage-collapse.js";
import { removeDeadReads } from "./stage-dead-reads.js";

function rec(
  i: number,
  method: string,
  params: Record<string, unknown> = {},
  ok = true,
  page_effect?: AutoTeachTraceRecord["page_effect"],
): AutoTeachTraceRecord {
  return {
    ts: i,
    run_index: 0,
    method,
    params,
    ok,
    duration_ms: 100,
    ...(page_effect !== undefined ? { page_effect } : {}),
  };
}

describe("normalize", () => {
  it("drops non-browser_* records and sorts by ts", () => {
    const records: AutoTeachTraceRecord[] = [
      rec(3, "browser_click", { ref: 1 }),
      rec(2, "procedures_get", { name: "x" }),
      rec(1, "browser_navigate", { url: "https://example.com" }),
    ];
    const ir = normalize(records);
    expect(ir).toHaveLength(2);
    expect(ir[0]?.method).toBe("browser_navigate");
    expect(ir[1]?.method).toBe("browser_click");
  });

  it("preserves page_effect when present", () => {
    const pe = {
      dom: { added: 5, removed: 0, attr_changes: 0, text_changes: 0 },
      url: { changed: false },
      focus: { changed: false },
      network: { requests_started: 0, requests_completed: 0, in_flight_at_end: 0 },
      console_errors: 0,
      window_ms: 300,
    };
    const ir = normalize([rec(1, "browser_click", { ref: 1 }, true, pe)]);
    expect(ir[0]?.page_effect).toEqual(pe);
  });
});

describe("collapseRetries", () => {
  it("keeps the successful tail of a retry chain", () => {
    const ir = normalize([
      rec(1, "browser_click", { tab_id: "t_1", ref: 5 }, false),
      rec(2, "browser_click", { tab_id: "t_1", ref: 5 }, false),
      rec(3, "browser_click", { tab_id: "t_1", ref: 5 }, true),
    ]);
    const collapsed = collapseRetries(ir);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.ts).toBe(3);
    expect(collapsed[0]?.ok).toBe(true);
    expect(collapsed[0]?.retry_tail).toBe(true);
  });

  it("does not collapse calls with different methods", () => {
    const ir = normalize([
      rec(1, "browser_click", { ref: 5 }),
      rec(2, "browser_navigate", { url: "x" }),
    ]);
    const collapsed = collapseRetries(ir);
    expect(collapsed).toHaveLength(2);
  });

  it("does not collapse calls with different similarity-key params", () => {
    const ir = normalize([
      rec(1, "browser_click", { tab_id: "t_1", ref: 5 }),
      rec(2, "browser_click", { tab_id: "t_1", ref: 6 }),
    ]);
    const collapsed = collapseRetries(ir);
    expect(collapsed).toHaveLength(2);
  });

  it("keeps last attempt when every step in chain failed", () => {
    const ir = normalize([
      rec(1, "browser_click", { tab_id: "t_1", ref: 5 }, false),
      rec(2, "browser_click", { tab_id: "t_1", ref: 5 }, false),
    ]);
    const collapsed = collapseRetries(ir);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.ts).toBe(2);
    expect(collapsed[0]?.ok).toBe(false);
  });

  it("treats retries more than 5s apart as separate chains", () => {
    const ir = normalize([
      rec(1000, "browser_click", { tab_id: "t_1", ref: 5 }),
      rec(7000, "browser_click", { tab_id: "t_1", ref: 5 }),
    ]);
    const collapsed = collapseRetries(ir);
    expect(collapsed).toHaveLength(2);
  });
});

describe("removeDeadReads", () => {
  it("drops a browser_read whose result no later step consumes", () => {
    const ir = normalize([
      rec(1, "browser_read", {}),
      rec(2, "browser_navigate", { url: "https://example.com" }),
    ]);
    const cleaned = removeDeadReads(ir);
    expect(cleaned.map((s) => s.method)).toEqual(["browser_navigate"]);
  });

  it("keeps browser_quick_read when a later step uses ref:N", () => {
    const ir = normalize([
      rec(1, "browser_quick_read", { text: "Login" }),
      rec(2, "browser_click", { ref: 7 }),
    ]);
    const cleaned = removeDeadReads(ir);
    expect(cleaned.map((s) => s.method)).toEqual([
      "browser_quick_read",
      "browser_click",
    ]);
  });

  it("keeps a read when later step's params contain a substring of the read's text", () => {
    const ir = normalize([
      rec(1, "browser_quick_read", { text: "Submit" }),
      rec(2, "browser_click_by_text", { text: "Submit" }),
    ]);
    const cleaned = removeDeadReads(ir);
    expect(cleaned).toHaveLength(2);
  });

  it("never drops non-read steps", () => {
    const ir = normalize([
      rec(1, "browser_click", { ref: 1 }),
      rec(2, "browser_navigate", { url: "x" }),
    ]);
    const cleaned = removeDeadReads(ir);
    expect(cleaned).toHaveLength(2);
  });
});

describe("distill — end-to-end", () => {
  it("emits a single-leaf draft from a clean trace", () => {
    const records: AutoTeachTraceRecord[] = [
      rec(1, "browser_navigate", { url: "https://example.com" }, true, {
        dom: { added: 5, removed: 0, attr_changes: 0, text_changes: 0 },
        url: { changed: true, after: "https://example.com" },
        focus: { changed: false },
        network: { requests_started: 1, requests_completed: 1, in_flight_at_end: 0 },
        console_errors: 0,
        window_ms: 300,
      }),
      rec(2, "browser_click_by_text", { text: "Sign in" }),
    ];
    const result = distill(records, { goal: "demo flow" });
    expect(result.composite_name).toBeNull();
    expect(result.leaves).toHaveLength(1);
    expect(result.yaml).toContain("schema_version: 1");
    expect(result.yaml).toContain("browser_navigate");
    expect(result.yaml).toContain("browser_click_by_text");
  });

  it("collapses retries and drops dead reads end-to-end", () => {
    const records: AutoTeachTraceRecord[] = [
      rec(1, "browser_read", {}), // dead — nothing nearby uses ref:N or matches a query
      rec(2, "browser_click_by_text", { tab_id: "t_1", text: "Login" }, false),
      rec(3, "browser_click_by_text", { tab_id: "t_1", text: "Login" }, true),
      rec(4, "browser_navigate", { url: "https://example.com" }),
    ];
    const result = distill(records, { goal: "x" });
    expect(result.yaml).not.toContain("browser_read");
    // 4 input rows → 2 surviving (dead read dropped, retry collapsed)
    const stepCount = (result.yaml.match(/^ {2}- id:/gm) ?? []).length;
    expect(stepCount).toBe(2);
  });

  it("flags click-by-text on 'send' as a side_effect", () => {
    const records: AutoTeachTraceRecord[] = [
      rec(1, "browser_click_by_text", { text: "Send" }),
    ];
    const result = distill(records, { goal: "send a thing" });
    expect(result.leaves[0]?.side_effects).toContain("send_message");
  });

  it("emits a placeholder leaf and a validation_error for an empty trace", () => {
    const result = distill([], { goal: "nothing" });
    expect(result.leaves).toHaveLength(1);
    expect(result.validation_errors[0]).toMatch(/no browser_/);
  });
});
