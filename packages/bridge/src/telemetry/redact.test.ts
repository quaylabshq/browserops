import { describe, expect, it } from "vitest";
import { redact, isAllowedEvent } from "./redact.js";

describe("redact", () => {
  it("returns empty for unknown event", () => {
    expect(redact("never_heard_of_it", { tool_name: "browser_navigate" })).toEqual({});
  });

  it("isAllowedEvent reflects allowlist", () => {
    expect(isAllowedEvent("tool_called")).toBe(true);
    expect(isAllowedEvent("session_created")).toBe(true);
    expect(isAllowedEvent("nope")).toBe(false);
  });

  it("drops keys not in allowlist", () => {
    const out = redact("tool_called", {
      tool_name: "browser_navigate",
      url: "https://secret.example/path?token=abc",
      params: { url: "https://secret.example", token: "abc" },
      message: "navigation failed: 401",
      tab_url: "https://secret.example",
      tab_title: "Inbox - Gmail",
      tab_hostname: "mail.google.com",
      ok: true,
    });
    expect(out).toEqual({
      tool_name: "browser_navigate",
      tab_hostname: "mail.google.com",
      ok: true,
    });
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("secret");
    expect(serialised).not.toContain("token=abc");
    expect(serialised).not.toContain("Inbox");
    expect(serialised).not.toContain("navigation failed");
  });

  it("drops unknown tool_name", () => {
    const out = redact("tool_called", {
      tool_name: "browser_secret_thing",
      ok: true,
    });
    expect(out).not.toHaveProperty("tool_name");
    expect(out["ok"]).toBe(true);
  });

  it("collapses non-canonical error_code to UNKNOWN", () => {
    const out = redact("tool_called", {
      tool_name: "browser_navigate",
      ok: false,
      error_code: "401: bearer abc123 was rejected by upstream auth",
    });
    expect(out["error_code"]).toBe("UNKNOWN");
  });

  it("preserves canonical error_code", () => {
    const out = redact("tool_called", {
      tool_name: "browser_navigate",
      ok: false,
      error_code: "TAB_NOT_FOUND",
    });
    expect(out["error_code"]).toBe("TAB_NOT_FOUND");
  });

  it("passes common props through any allowed event", () => {
    const out = redact("session_created", {
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

  it("drops payloads that try to smuggle params content", () => {
    const out = redact("tool_called", {
      tool_name: "browser_type",
      param_keys: ["tab_id", "ref", "text"],
      // Adversarial: try to sneak content in via a property whose name
      // looks plausible.
      input_text: "MY PASSWORD",
      typed_value: "secret",
    });
    expect(out).toEqual({
      tool_name: "browser_type",
      param_keys: ["tab_id", "ref", "text"],
    });
  });

  it("lore_op event allowlist", () => {
    const out = redact("tool_called", {
      tool_name: "lore_save",
      lore_op: "save",
      lore_name: "user_github",
      lore_body: "user@example.com",
    });
    expect(out["lore_op"]).toBe("save");
    expect(out["lore_name"]).toBe("user_github");
    expect(out).not.toHaveProperty("lore_body");
  });

  it("screenshot dimensions allowlist", () => {
    const out = redact("tool_called", {
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
});
