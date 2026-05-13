import { describe, expect, it } from "vitest";
import { isTelemetryEnabled } from "./opt-out.js";

describe("isTelemetryEnabled", () => {
  it("defaults to enabled when DO_NOT_TRACK unset", () => {
    expect(isTelemetryEnabled({ env: {} })).toBe(true);
  });

  it("DO_NOT_TRACK=1 disables", () => {
    expect(isTelemetryEnabled({ env: { DO_NOT_TRACK: "1" } })).toBe(false);
  });

  it("DO_NOT_TRACK=true disables", () => {
    expect(isTelemetryEnabled({ env: { DO_NOT_TRACK: "true" } })).toBe(false);
  });

  it("DO_NOT_TRACK=yes disables", () => {
    expect(isTelemetryEnabled({ env: { DO_NOT_TRACK: "yes" } })).toBe(false);
  });

  it("DO_NOT_TRACK=on disables", () => {
    expect(isTelemetryEnabled({ env: { DO_NOT_TRACK: "on" } })).toBe(false);
  });

  it("DO_NOT_TRACK=0 keeps telemetry on", () => {
    expect(isTelemetryEnabled({ env: { DO_NOT_TRACK: "0" } })).toBe(true);
  });

  it("DO_NOT_TRACK=anything-else keeps telemetry on", () => {
    expect(isTelemetryEnabled({ env: { DO_NOT_TRACK: "false" } })).toBe(true);
    expect(isTelemetryEnabled({ env: { DO_NOT_TRACK: "" } })).toBe(true);
  });
});
