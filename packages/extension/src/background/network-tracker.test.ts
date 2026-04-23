import { describe, expect, it, beforeEach, vi } from "vitest";
import { NetworkTracker } from "./network-tracker.js";

// Stub chrome APIs before importing the class. We call listeners directly, so
// the chrome.webRequest / chrome.tabs registration is a no-op here.
vi.stubGlobal("chrome", {
  webRequest: {
    onBeforeRequest: { addListener: vi.fn() },
    onCompleted: { addListener: vi.fn() },
    onErrorOccurred: { addListener: vi.fn() },
  },
  tabs: {
    onRemoved: { addListener: vi.fn() },
  },
});

describe("NetworkTracker", () => {
  let tracker: NetworkTracker;

  beforeEach(() => {
    tracker = new NetworkTracker();
  });

  it("snapshot returns zeros for an unknown tab", () => {
    expect(tracker.snapshot(99)).toEqual({ totalStarted: 0, totalCompleted: 0, inFlight: 0 });
  });

  it("inFlight returns 0 for an unknown tab", () => {
    expect(tracker.inFlight(99)).toBe(0);
  });

  it("tracks a single request lifecycle", () => {
    tracker._onBeforeRequest({ tabId: 1, requestId: "r1" });

    expect(tracker.inFlight(1)).toBe(1);
    expect(tracker.snapshot(1)).toEqual({ totalStarted: 1, totalCompleted: 0, inFlight: 1 });

    tracker._onCompleted({ tabId: 1, requestId: "r1" });

    expect(tracker.inFlight(1)).toBe(0);
    expect(tracker.snapshot(1)).toEqual({ totalStarted: 1, totalCompleted: 1, inFlight: 0 });
  });

  it("tracks multiple concurrent requests", () => {
    tracker._onBeforeRequest({ tabId: 2, requestId: "a" });
    tracker._onBeforeRequest({ tabId: 2, requestId: "b" });
    tracker._onBeforeRequest({ tabId: 2, requestId: "c" });

    expect(tracker.snapshot(2)).toEqual({ totalStarted: 3, totalCompleted: 0, inFlight: 3 });

    tracker._onCompleted({ tabId: 2, requestId: "a" });
    tracker._onCompleted({ tabId: 2, requestId: "b" });

    expect(tracker.snapshot(2)).toEqual({ totalStarted: 3, totalCompleted: 2, inFlight: 1 });

    tracker._onCompleted({ tabId: 2, requestId: "c" });

    expect(tracker.snapshot(2)).toEqual({ totalStarted: 3, totalCompleted: 3, inFlight: 0 });
    expect(tracker.inFlight(2)).toBe(0);
  });

  it("counters are monotonic across multiple request waves", () => {
    tracker._onBeforeRequest({ tabId: 3, requestId: "x1" });
    tracker._onCompleted({ tabId: 3, requestId: "x1" });

    tracker._onBeforeRequest({ tabId: 3, requestId: "x2" });
    tracker._onCompleted({ tabId: 3, requestId: "x2" });

    expect(tracker.snapshot(3)).toEqual({ totalStarted: 2, totalCompleted: 2, inFlight: 0 });
  });

  it("isolates counters per tab", () => {
    tracker._onBeforeRequest({ tabId: 10, requestId: "t10" });
    tracker._onBeforeRequest({ tabId: 20, requestId: "t20" });
    tracker._onCompleted({ tabId: 10, requestId: "t10" });

    expect(tracker.snapshot(10)).toEqual({ totalStarted: 1, totalCompleted: 1, inFlight: 0 });
    expect(tracker.snapshot(20)).toEqual({ totalStarted: 1, totalCompleted: 0, inFlight: 1 });
  });

  it("ignores events with tabId < 0", () => {
    tracker._onBeforeRequest({ tabId: -1, requestId: "bg" });
    tracker._onCompleted({ tabId: -1, requestId: "bg" });

    expect(tracker.snapshot(-1)).toEqual({ totalStarted: 0, totalCompleted: 0, inFlight: 0 });
  });

  it("forgetTab clears all state", () => {
    tracker._onBeforeRequest({ tabId: 5, requestId: "f1" });
    tracker.forgetTab(5);

    expect(tracker.snapshot(5)).toEqual({ totalStarted: 0, totalCompleted: 0, inFlight: 0 });
    expect(tracker.inFlight(5)).toBe(0);
  });

  it("completed event for unknown tab is a no-op", () => {
    tracker._onCompleted({ tabId: 77, requestId: "ghost" });
    expect(tracker.snapshot(77)).toEqual({ totalStarted: 0, totalCompleted: 0, inFlight: 0 });
  });
});
