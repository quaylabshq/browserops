import { describe, expect, it } from "vitest";
import { redact, isAllowedEvent } from "./redact.js";

describe("redact", () => {
  it("returns empty for unknown event", () => {
    expect(redact("never_heard_of_it", { tool_name: "browser_navigate" })).toEqual({});
  });

  it("isAllowedEvent reflects domain prefixes + per-tool gate", () => {
    expect(isAllowedEvent("cli.doctor_ran")).toBe(true);
    expect(isAllowedEvent("root.daemon_started")).toBe(true);
    expect(isAllowedEvent("mcp.browser_navigate")).toBe(true);
    expect(isAllowedEvent("mcp.browser_secret_thing")).toBe(false); // not in TOOL_DEF_MAP
    expect(isAllowedEvent("nope")).toBe(false);
  });

  it("mcp.<tool> drops keys not in MCP common allowlist", () => {
    const out = redact("mcp.browser_navigate", {
      tool_name: "browser_navigate",
      url: "https://secret.example/path?token=abc",
      params: { url: "https://secret.example", token: "abc" },
      message: "navigation failed: 401",
      tab_url: "https://secret.example",
      tab_title: "Inbox - Gmail",
      tab_hostname: "mail.google.com",
      ok: true,
      is_external_url: true,
    });
    expect(out).toEqual({
      tool_name: "browser_navigate",
      tab_hostname: "mail.google.com",
      ok: true,
      is_external_url: true,
    });
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("secret.example");
    expect(serialised).not.toContain("token=abc");
    expect(serialised).not.toContain("Inbox");
    expect(serialised).not.toContain("navigation failed");
  });

  it("mcp.* event with non-canonical tool_name property drops it", () => {
    const out = redact("mcp.browser_navigate", {
      tool_name: "browser_secret_thing", // doesn't exist in TOOL_DEF_MAP
      ok: true,
    });
    expect(out).not.toHaveProperty("tool_name");
    expect(out["ok"]).toBe(true);
  });

  it("mcp.* drops events whose tool isn't in TOOL_DEF_MAP", () => {
    expect(redact("mcp.browser_secret_thing", { tool_name: "browser_secret_thing", ok: true })).toEqual({});
  });

  it("collapses non-canonical error_code to UNKNOWN", () => {
    const out = redact("mcp.browser_navigate", {
      tool_name: "browser_navigate",
      ok: false,
      error_code: "401: bearer abc123 was rejected by upstream auth",
    });
    expect(out["error_code"]).toBe("UNKNOWN");
  });

  it("preserves canonical error_code", () => {
    const out = redact("mcp.browser_navigate", {
      tool_name: "browser_navigate",
      ok: false,
      error_code: "TAB_NOT_FOUND",
    });
    expect(out["error_code"]).toBe("TAB_NOT_FOUND");
  });

  it("common props pass through any allowed event", () => {
    const out = redact("root.session_started", {
      client_name: "Claude Code",
      bridge_version: "0.0.7",
      os_platform: "darwin",
      not_in_allowlist: "drop me",
    });
    expect(out).toEqual({
      client_name: "Claude Code",
      bridge_version: "0.0.7",
      os_platform: "darwin",
    });
  });

  it("memory_* per-tool extras", () => {
    const out = redact("mcp.memory_save", {
      tool_name: "memory_save",
      memory_name: "user_github",
      memory_body: "saket@mem0.ai",
      ok: true,
    });
    expect(out["memory_name"]).toBe("user_github");
    expect(out).not.toHaveProperty("memory_body");
  });

  it("screenshot per-tool extras", () => {
    const out = redact("mcp.browser_screenshot", {
      tool_name: "browser_screenshot",
      ok: true,
      screenshot_width_px: 1440,
      screenshot_height_px: 900,
      screenshot_format: "png",
      image_base64: "iVBORw0KGgo...",
    });
    expect(out).toEqual({
      tool_name: "browser_screenshot",
      ok: true,
      screenshot_width_px: 1440,
      screenshot_height_px: 900,
      screenshot_format: "png",
    });
  });

  it("procedures_execute extras", () => {
    const out = redact("mcp.procedures_execute", {
      tool_name: "procedures_execute",
      ok: true,
      procedure_name: "tempmail.get_email",
      procedure_steps_executed: 5,
      step_results: [{ step_id: "1" }],
    });
    expect(out["procedure_name"]).toBe("tempmail.get_email");
    expect(out["procedure_steps_executed"]).toBe(5);
    expect(out).not.toHaveProperty("step_results");
  });

  it("cli.feature_enabled allowlist", () => {
    const out = redact("cli.feature_enabled", {
      feature_name: "procedures",
      enabled: true, // not in allowlist for this event
      exit_code: 0,
      duration_ms: 12,
    });
    expect(out).toEqual({
      feature_name: "procedures",
      exit_code: 0,
      duration_ms: 12,
    });
  });

  it("cli.identify_set never carries the email itself", () => {
    const out = redact("cli.identify_set", {
      via: "init",
      email: "saket@mem0.ai",
      exit_code: 0,
      duration_ms: 5,
    });
    expect(out).not.toHaveProperty("email");
    expect(out["via"]).toBe("init");
  });

  it("root.daemon_started", () => {
    const out = redact("root.daemon_started", {
      approval_mode: "auto",
      enabled_features: ["procedures"],
      extension_connected: false,
      bridge_version: "0.0.7",
      // adversarial:
      pair_code: "abc123",
    });
    expect(out["approval_mode"]).toBe("auto");
    expect(out["enabled_features"]).toEqual(["procedures"]);
    expect(out["bridge_version"]).toBe("0.0.7");
    expect(out).not.toHaveProperty("pair_code");
  });
});
