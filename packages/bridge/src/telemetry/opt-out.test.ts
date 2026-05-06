import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTelemetryEnabled } from "./opt-out.js";

describe("isTelemetryEnabled", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bops-opt-"));
    configPath = join(dir, "config.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to enabled when no signals", async () => {
    const enabled = await isTelemetryEnabled({ env: {}, configPath });
    expect(enabled).toBe(true);
  });

  it("DO_NOT_TRACK=1 disables", async () => {
    expect(
      await isTelemetryEnabled({ env: { DO_NOT_TRACK: "1" }, configPath }),
    ).toBe(false);
  });

  it("DO_NOT_TRACK takes precedence over BROWSEROPS_TELEMETRY=1", async () => {
    expect(
      await isTelemetryEnabled({
        env: { DO_NOT_TRACK: "1", BROWSEROPS_TELEMETRY: "1" },
        configPath,
      }),
    ).toBe(false);
  });

  it("BROWSEROPS_TELEMETRY=0 disables", async () => {
    expect(
      await isTelemetryEnabled({
        env: { BROWSEROPS_TELEMETRY: "0" },
        configPath,
      }),
    ).toBe(false);
  });

  it("BROWSEROPS_TELEMETRY=off disables", async () => {
    expect(
      await isTelemetryEnabled({
        env: { BROWSEROPS_TELEMETRY: "off" },
        configPath,
      }),
    ).toBe(false);
  });

  it("BROWSEROPS_TELEMETRY=1 overrides config disable", async () => {
    writeFileSync(configPath, JSON.stringify({ telemetry: false }), "utf8");
    expect(
      await isTelemetryEnabled({
        env: { BROWSEROPS_TELEMETRY: "1" },
        configPath,
      }),
    ).toBe(true);
  });

  it("config.json telemetry:false disables", async () => {
    writeFileSync(configPath, JSON.stringify({ telemetry: false }), "utf8");
    expect(await isTelemetryEnabled({ env: {}, configPath })).toBe(false);
  });

  it("config.json telemetry:true enables", async () => {
    writeFileSync(configPath, JSON.stringify({ telemetry: true }), "utf8");
    expect(await isTelemetryEnabled({ env: {}, configPath })).toBe(true);
  });

  it("ignores malformed config", async () => {
    writeFileSync(configPath, "{ not: json", "utf8");
    expect(await isTelemetryEnabled({ env: {}, configPath })).toBe(true);
  });

  it("ignores non-boolean telemetry field", async () => {
    writeFileSync(configPath, JSON.stringify({ telemetry: "yes" }), "utf8");
    expect(await isTelemetryEnabled({ env: {}, configPath })).toBe(true);
  });
});
