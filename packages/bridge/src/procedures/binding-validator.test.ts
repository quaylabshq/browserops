import { describe, expect, it } from "vitest";
import { validateBindings } from "./binding-validator.js";

function proc(steps: unknown[], inputs: Record<string, unknown> = {}): unknown {
  return {
    schema_version: 1,
    name: "test.proc",
    description: "test",
    kind: "leaf",
    inputs,
    steps,
  };
}

describe("validateBindings", () => {
  it("accepts {{tab_id}}", () => {
    const result = validateBindings(
      proc([
        {
          id: "s1",
          action: "browser_navigate",
          with: { tab_id: "{{tab_id}}", url: "https://example.com" },
        },
      ]),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts a declared {{input.x}}", () => {
    const result = validateBindings(
      proc(
        [
          {
            id: "s1",
            action: "browser_navigate",
            with: { tab_id: "{{tab_id}}", url: "{{input.target_url}}" },
          },
        ],
        { target_url: { type: "string" } },
      ),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects an undeclared {{input.x}}", () => {
    const result = validateBindings(
      proc([
        {
          id: "s1",
          action: "browser_navigate",
          with: { tab_id: "{{tab_id}}", url: "{{input.missing}}" },
        },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toContain("undeclared input");
    expect(result.errors?.[0]?.message).toContain("missing");
  });

  it("accepts a bound reference to a real outputSchema field", () => {
    const result = validateBindings(
      proc([
        {
          id: "read_page",
          action: "browser_read",
          with: { tab_id: "{{tab_id}}", mode: "a11y_tree" },
          bind: "page",
        },
        {
          id: "type_into",
          action: "browser_type",
          with: { tab_id: "{{tab_id}}", ref: "{{page.refs.input}}", text: "hi" },
        },
      ]),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects a bound reference to a field not in the tool's outputSchema (magic_url-class bug)", () => {
    const result = validateBindings(
      proc([
        {
          id: "read_page",
          action: "browser_read",
          with: { tab_id: "{{tab_id}}", mode: "a11y_tree" },
          bind: "page",
        },
        {
          id: "use_bad",
          action: "browser_navigate",
          with: { tab_id: "{{tab_id}}", url: "{{page.magic_url}}" },
        },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toContain("magic_url");
    expect(result.errors?.[0]?.message).toContain("browser_read");
  });

  it("rejects a reference to an unbound name", () => {
    const result = validateBindings(
      proc([
        {
          id: "s1",
          action: "browser_navigate",
          with: { tab_id: "{{tab_id}}", url: "{{ghost.field}}" },
        },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toContain("unknown bind");
    expect(result.errors?.[0]?.message).toContain("ghost");
  });

  it("rejects a reference that points forward to a later step", () => {
    const result = validateBindings(
      proc([
        {
          id: "early",
          action: "browser_navigate",
          with: { tab_id: "{{tab_id}}", url: "{{later.refs.x}}" },
        },
        {
          id: "later",
          action: "browser_read",
          with: { tab_id: "{{tab_id}}", mode: "a11y_tree" },
          bind: "later",
        },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toContain("unknown bind");
  });

  it("rejects a step that references its own bind name", () => {
    // The step's bind is registered AFTER its own with/ checks.
    const result = validateBindings(
      proc([
        {
          id: "self_ref",
          action: "browser_read",
          with: { tab_id: "{{tab_id}}", mode: "a11y_tree", selector: "{{self_ref.refs.x}}" },
          bind: "self_ref",
        },
      ]),
    );
    expect(result.valid).toBe(false);
  });

  it("skips field-validation for sub-procedure (non-tool) actions", () => {
    // Sub-procedure outputs aren't declared today; skipping is the documented
    // behaviour. The composite re-author flow catches these by execution.
    const result = validateBindings(
      proc([
        {
          id: "wait",
          action: "tempmail.wait_for_magic_link",
          with: { tab_id: "{{tab_id}}" },
          bind: "magic",
        },
        {
          id: "go",
          action: "browser_navigate",
          with: { tab_id: "{{tab_id}}", url: "{{magic.anything_at_all}}" },
        },
      ]),
    );
    expect(result.valid).toBe(true);
  });

  it("validates references inside on_fail blocks", () => {
    const result = validateBindings(
      proc([
        {
          id: "s1",
          action: "browser_click",
          with: { tab_id: "{{tab_id}}", ref: 1 },
          on_fail: [
            {
              action: "browser_navigate",
              with: { tab_id: "{{tab_id}}", url: "{{ghost.field}}" },
            },
          ],
        },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.instancePath).toBe("/steps/0/on_fail/0/with/url");
  });

  it("validates for_each expression and exposes `as` as opaque inside do[]", () => {
    const result = validateBindings(
      proc([
        {
          id: "list",
          action: "browser_read",
          with: { tab_id: "{{tab_id}}", mode: "a11y_tree" },
          bind: "page",
        },
        {
          id: "iter",
          for_each: "{{page.refs}}",
          as: "row",
          do: [
            {
              action: "browser_click",
              with: { tab_id: "{{tab_id}}", ref: "{{row.id}}" },
            },
          ],
        },
      ]),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects unknown-shape bare references", () => {
    const result = validateBindings(
      proc([
        {
          id: "s1",
          action: "browser_navigate",
          with: { tab_id: "{{tab_id}}", url: "{{unknown_thing}}" },
        },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toContain("unknown reference");
  });

  it("ignores non-string values without crashing", () => {
    const result = validateBindings(
      proc([
        {
          id: "s1",
          action: "browser_type",
          with: { tab_id: "{{tab_id}}", ref: 42, text: "literal", clear_first: true },
        },
      ]),
    );
    expect(result.valid).toBe(true);
  });
});
