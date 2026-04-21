import { describe, expect, it } from "vitest";
import { isEvent, isHello, isHelloAck, isRequest, isResponse } from "./protocol.js";

describe("envelope type guards", () => {
  it("identifies hello", () => {
    expect(isHello({ type: "hello", token: "x", extension_version: "0", protocol_version: 1 })).toBe(
      true,
    );
    expect(isHello({ type: "hello_ack" })).toBe(false);
    expect(isHello(null)).toBe(false);
    expect(isHello("hello")).toBe(false);
  });

  it("identifies hello_ack", () => {
    expect(isHelloAck({ type: "hello_ack", bridge_version: "0.1.0", protocol_version: 1 })).toBe(
      true,
    );
    expect(isHelloAck({ type: "hello" })).toBe(false);
  });

  it("identifies request / response / event", () => {
    expect(isRequest({ type: "request", id: "a", method: "x", params: {}, timeout_ms: 1 })).toBe(
      true,
    );
    expect(isResponse({ type: "response", id: "a", ok: true, result: 42 })).toBe(true);
    expect(isEvent({ type: "event", name: "tab_closed", payload: {} })).toBe(true);
    expect(isRequest({ type: "event" })).toBe(false);
  });

  it("rejects non-objects across the board", () => {
    for (const v of [undefined, null, 1, "str", [], true]) {
      expect(isHello(v)).toBe(false);
      expect(isRequest(v)).toBe(false);
      expect(isResponse(v)).toBe(false);
      expect(isEvent(v)).toBe(false);
    }
  });
});
