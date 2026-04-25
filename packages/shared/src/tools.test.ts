import { describe, expect, it } from "vitest";
import { TOOL_DEFS, TOOL_DEF_MAP } from "./tools.js";
import { ERROR_CODES } from "./errors.js";

describe("TOOL_DEFS catalogue", () => {
  it("contains 33 tools (25 browser + 8 procedures)", () => {
    expect(TOOL_DEFS).toHaveLength(33);
  });

  it("every tool name is prefixed browser_ or procedures_ and unique", () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names)
      expect(n.startsWith("browser_") || n.startsWith("procedures_")).toBe(true);
  });

  it("every tool name matches the MCP-recommended pattern ^[a-zA-Z0-9_-]+$", () => {
    const pattern = /^[a-zA-Z0-9_-]+$/;
    for (const t of TOOL_DEFS) {
      expect(t.name).toMatch(pattern);
    }
  });

  it("TOOL_DEF_MAP matches the array", () => {
    for (const t of TOOL_DEFS) {
      expect(TOOL_DEF_MAP[t.name]).toBe(t);
    }
  });

  it("action_weight is 0, 0.5, or 1", () => {
    for (const t of TOOL_DEFS) {
      expect([0, 0.5, 1]).toContain(t.action_weight);
    }
  });

  it("risky is always / conditional / never", () => {
    for (const t of TOOL_DEFS) {
      expect(["always", "conditional", "never"]).toContain(t.risky);
    }
  });

  it("error codes are all in the canonical set", () => {
    const canonical = new Set<string>(ERROR_CODES);
    for (const t of TOOL_DEFS) {
      for (const code of t.errorCodes) {
        expect(canonical.has(code)).toBe(true);
      }
    }
  });

  it("execute_js is always risky", () => {
    const exec = TOOL_DEF_MAP["browser_execute_js"];
    expect(exec?.risky).toBe("always");
  });

  it("click and type are conditional risky", () => {
    expect(TOOL_DEF_MAP["browser_click"]?.risky).toBe("conditional");
    expect(TOOL_DEF_MAP["browser_type"]?.risky).toBe("conditional");
  });

  it("read and screenshot cost 0.5", () => {
    expect(TOOL_DEF_MAP["browser_read"]?.action_weight).toBe(0.5);
    expect(TOOL_DEF_MAP["browser_screenshot"]?.action_weight).toBe(0.5);
  });

  it("observation tools cost 0", () => {
    expect(TOOL_DEF_MAP["browser_list_tabs"]?.action_weight).toBe(0);
    expect(TOOL_DEF_MAP["browser_current_tab"]?.action_weight).toBe(0);
    expect(TOOL_DEF_MAP["browser_wait_for"]?.action_weight).toBe(0);
  });
});

describe("browser_read schema", () => {
  const read = TOOL_DEF_MAP["browser_read"];
  const props = read?.inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const outProps = read?.outputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;

  it("verbose defaults to false", () => {
    expect(props?.verbose?.default).toBe(false);
    expect(props?.verbose?.type).toBe("boolean");
  });

  it("start defaults to 0 and has min=0", () => {
    expect(props?.start?.default).toBe(0);
    expect(props?.start?.minimum).toBe(0);
    expect(props?.start?.type).toBe("integer");
  });

  it("length has a default and bounds within max_length range", () => {
    expect(props?.length?.default).toBe(131072);
    expect(props?.length?.minimum).toBe(1024);
    expect(props?.length?.maximum).toBe(1048576);
  });

  it("selector is optional with length bounds", () => {
    expect(props?.selector?.minLength).toBe(1);
    expect(props?.selector?.maxLength).toBe(1024);
    expect(read?.inputSchema.required).toEqual(["tab_id", "mode"]);
  });

  it("output schema exposes pagination fields", () => {
    expect(outProps?.total_length?.type).toBe("integer");
    expect(outProps?.matched_selector?.type).toBe("boolean");
    expect(outProps?.next_start).toBeDefined();
  });
});

describe("browser_query_selector schema", () => {
  const tool = TOOL_DEF_MAP["browser_query_selector"];
  const inProps = tool?.inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const outProps = tool?.outputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;

  it("is registered", () => {
    expect(tool).toBeDefined();
  });

  it("is observation-weight and never risky", () => {
    expect(tool?.action_weight).toBe(0);
    expect(tool?.risky).toBe("never");
  });

  it("requires tab_id and selector", () => {
    expect(tool?.inputSchema.required).toEqual(["tab_id", "selector"]);
  });

  it("selector is 1-2048 chars", () => {
    expect(inProps?.selector?.minLength).toBe(1);
    expect(inProps?.selector?.maxLength).toBe(2048);
  });

  it("all defaults to false", () => {
    expect(inProps?.all?.default).toBe(false);
  });

  it("output exposes match and matches/total/truncated", () => {
    expect(outProps?.match).toBeDefined();
    expect(outProps?.matches?.maxItems).toBe(50);
    expect(outProps?.total?.type).toBe("integer");
    expect(outProps?.truncated?.type).toBe("boolean");
  });

  it("does not include REF error codes (not ref-based)", () => {
    const codes = tool?.errorCodes ?? [];
    for (const code of codes) {
      expect(code).not.toBe("REF_STALE");
      expect(code).not.toBe("REF_NOT_FOUND");
    }
  });
});

describe("browser_find_and_replace schema", () => {
  const tool = TOOL_DEF_MAP["browser_find_and_replace"];
  const props = tool?.inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;

  it("is registered", () => {
    expect(tool).toBeDefined();
  });

  it("is conditionally risky", () => {
    expect(tool?.risky).toBe("conditional");
  });

  it("requires tab_id, find, and replace", () => {
    expect(tool?.inputSchema.required).toEqual(["tab_id", "find", "replace"]);
  });

  it("occurrence defaults to first", () => {
    expect(props?.occurrence?.default).toBe("first");
  });

  it("case_sensitive defaults to true", () => {
    expect(props?.case_sensitive?.default).toBe(true);
  });

  it("accepts TEXT_NOT_FOUND as a possible error code", () => {
    expect(tool?.errorCodes).toContain("TEXT_NOT_FOUND");
  });
});

describe("browser_screenshot schema", () => {
  const shot = TOOL_DEF_MAP["browser_screenshot"];
  const props = shot?.inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;

  it("defaults to jpeg at quality 40 with max_dimension 1024", () => {
    expect(props?.format?.default).toBe("jpeg");
    expect(props?.quality?.default).toBe(40);
    expect(props?.max_dimension?.default).toBe(1024);
  });

  it("full_quality defaults to false", () => {
    expect(props?.full_quality?.default).toBe(false);
  });

  it("only tab_id is required", () => {
    expect(shot?.inputSchema.required).toEqual(["tab_id"]);
  });

  it("max_dimension is bounded to [1, 8192]", () => {
    expect(props?.max_dimension?.minimum).toBe(1);
    expect(props?.max_dimension?.maximum).toBe(8192);
  });
});

describe("procedures_list", () => {
  const tool = TOOL_DEF_MAP["procedures_list"];

  it("is registered", () => {
    expect(tool).toBeDefined();
  });

  it("is observation-weight and never risky", () => {
    expect(tool?.action_weight).toBe(0);
    expect(tool?.risky).toBe("never");
  });

  it("errorCodes contains PROC_NOT_FOUND", () => {
    expect(tool?.errorCodes).toContain("PROC_NOT_FOUND");
  });

  it("has no required inputs", () => {
    expect(tool?.inputSchema.required).toBeUndefined();
  });
});

describe("procedures_search", () => {
  const tool = TOOL_DEF_MAP["procedures_search"];
  const props = tool?.inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;

  it("is registered", () => {
    expect(tool).toBeDefined();
  });

  it("is observation-weight and never risky", () => {
    expect(tool?.action_weight).toBe(0);
    expect(tool?.risky).toBe("never");
  });

  it("errorCodes contains PROC_NOT_FOUND", () => {
    expect(tool?.errorCodes).toContain("PROC_NOT_FOUND");
  });

  it("requires query", () => {
    expect(tool?.inputSchema.required).toContain("query");
  });

  it("limit defaults to 10 bounded [1, 25]", () => {
    expect(props?.limit?.default).toBe(10);
    expect(props?.limit?.minimum).toBe(1);
    expect(props?.limit?.maximum).toBe(25);
  });

  it("min_score defaults to 0.2 bounded [0, 1]", () => {
    expect(props?.min_score?.default).toBe(0.2);
    expect(props?.min_score?.minimum).toBe(0);
    expect(props?.min_score?.maximum).toBe(1);
  });
});

describe("procedures_get", () => {
  const tool = TOOL_DEF_MAP["procedures_get"];

  it("is registered", () => {
    expect(tool).toBeDefined();
  });

  it("is observation-weight and never risky", () => {
    expect(tool?.action_weight).toBe(0);
    expect(tool?.risky).toBe("never");
  });

  it("errorCodes contains PROC_NOT_FOUND", () => {
    expect(tool?.errorCodes).toContain("PROC_NOT_FOUND");
  });

  it("requires name", () => {
    expect(tool?.inputSchema.required).toContain("name");
  });
});

describe("procedures_save", () => {
  const tool = TOOL_DEF_MAP["procedures_save"];
  const props = tool?.inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;

  it("is registered", () => {
    expect(tool).toBeDefined();
  });

  it("is action_weight 0.5 and never risky", () => {
    expect(tool?.action_weight).toBe(0.5);
    expect(tool?.risky).toBe("never");
  });

  it("errorCodes contains PROC_NOT_FOUND", () => {
    expect(tool?.errorCodes).toContain("PROC_NOT_FOUND");
  });

  it("requires name and yaml", () => {
    expect(tool?.inputSchema.required).toContain("name");
    expect(tool?.inputSchema.required).toContain("yaml");
  });

  it("yaml is bounded to 64KB", () => {
    expect(props?.yaml?.maxLength).toBe(65536);
    expect(props?.yaml?.minLength).toBe(1);
  });

  it("overwrite defaults to false", () => {
    expect(props?.overwrite?.default).toBe(false);
  });
});

describe("procedures_promote", () => {
  const tool = TOOL_DEF_MAP["procedures_promote"];

  it("is registered", () => {
    expect(tool).toBeDefined();
  });

  it("is action_weight 0.5 and never risky", () => {
    expect(tool?.action_weight).toBe(0.5);
    expect(tool?.risky).toBe("never");
  });

  it("errorCodes contains PROC_NOT_FOUND", () => {
    expect(tool?.errorCodes).toContain("PROC_NOT_FOUND");
  });

  it("requires name and from_owner", () => {
    expect(tool?.inputSchema.required).toContain("name");
    expect(tool?.inputSchema.required).toContain("from_owner");
  });
});

describe("procedures_delete", () => {
  const tool = TOOL_DEF_MAP["procedures_delete"];
  const props = tool?.inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;

  it("is registered", () => {
    expect(tool).toBeDefined();
  });

  it("is action_weight 0.5 and never risky", () => {
    expect(tool?.action_weight).toBe(0.5);
    expect(tool?.risky).toBe("never");
  });

  it("errorCodes contains PROC_NOT_FOUND", () => {
    expect(tool?.errorCodes).toContain("PROC_NOT_FOUND");
  });

  it("requires name", () => {
    expect(tool?.inputSchema.required).toContain("name");
  });

  it("force defaults to false", () => {
    expect(props?.force?.default).toBe(false);
  });
});
