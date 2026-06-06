import { describe, expect, it } from "vitest";
import {
  evaluateExpect,
  pollExpect,
  type Observation,
} from "./expectation.js";

describe("evaluateExpect", () => {
  it("undefined expect always matches", () => {
    expect(evaluateExpect(undefined, undefined).matched).toBe(true);
  });

  it("present expect with no observation does NOT match", () => {
    const r = evaluateExpect({ text_visible: "x" }, undefined);
    expect(r.matched).toBe(false);
  });

  it("url_matches as regex", () => {
    const obs: Observation = { url: "https://example.com/foo" };
    expect(evaluateExpect({ url_matches: "/example\\.com/" }, obs).matched).toBe(
      true,
    );
    expect(evaluateExpect({ url_matches: "/^other\\.com/" }, obs).matched).toBe(
      false,
    );
  });

  it("text_visible substring + regex", () => {
    const obs: Observation = { text: "Welcome to the dashboard." };
    expect(evaluateExpect({ text_visible: "dashboard" }, obs).matched).toBe(true);
    expect(
      evaluateExpect({ text_visible: "/^Welcome/" }, obs).matched,
    ).toBe(true);
    expect(
      evaluateExpect({ text_visible: "nope" }, obs).matched,
    ).toBe(false);
  });

  it("text_invisible asserts absence", () => {
    const obs: Observation = { text: "All good." };
    expect(
      evaluateExpect({ text_invisible: "Error" }, obs).matched,
    ).toBe(true);
    expect(
      evaluateExpect({ text_invisible: "good" }, obs).matched,
    ).toBe(false);
  });

  it("new_dialog: true requires at least one new dialog", () => {
    expect(
      evaluateExpect({ new_dialog: true }, { new_dialogs: [{ name: "x" }] })
        .matched,
    ).toBe(true);
    expect(
      evaluateExpect({ new_dialog: true }, { new_dialogs: [] }).matched,
    ).toBe(false);
  });

  it("new_dialog: pattern requires a matching name", () => {
    expect(
      evaluateExpect(
        { new_dialog: "/^Send/" },
        { new_dialogs: [{ name: "Send mail?" }] },
      ).matched,
    ).toBe(true);
    expect(
      evaluateExpect(
        { new_dialog: "/^Delete/" },
        { new_dialogs: [{ name: "Send mail?" }] },
      ).matched,
    ).toBe(false);
  });

  it("network_endpoint pattern", () => {
    expect(
      evaluateExpect(
        { network_endpoint: "/sendmessage" },
        { network_endpoints: ["/api/sendmessage"] },
      ).matched,
    ).toBe(true);
    expect(
      evaluateExpect(
        { network_endpoint: "/sendmessage" },
        { network_endpoints: ["/other"] },
      ).matched,
    ).toBe(false);
  });

  it("dom_added_min compares page_effect.dom.added", () => {
    expect(
      evaluateExpect(
        { dom_added_min: 5 },
        {
          page_effect: {
            dom: { added: 6, removed: 0, attr_changes: 0, text_changes: 0 },
            url: { changed: false },
            focus: { changed: false },
            network: {
              requests_started: 0,
              requests_completed: 0,
              in_flight_at_end: 0,
            },
            console_errors: 0,
            window_ms: 100,
          },
        },
      ).matched,
    ).toBe(true);
  });

  it("console_errors_max upper bound", () => {
    expect(
      evaluateExpect(
        { console_errors_max: 0 },
        { console_errors: 0 },
      ).matched,
    ).toBe(true);
    expect(
      evaluateExpect(
        { console_errors_max: 0 },
        { console_errors: 2 },
      ).matched,
    ).toBe(false);
  });
});

describe("pollExpect", () => {
  it("returns matched immediately when first observation passes", async () => {
    const r = await pollExpect(
      { text_visible: "hi" },
      async () => ({ text: "hi there" }),
    );
    expect(r.matched).toBe(true);
  });

  it("polls until match within timeout", async () => {
    let calls = 0;
    const r = await pollExpect(
      { text_visible: "ready", timeout_ms: 1000, poll_interval_ms: 10 },
      async () => {
        calls++;
        return calls < 3 ? { text: "loading" } : { text: "ready" };
      },
    );
    expect(r.matched).toBe(true);
    expect(calls).toBe(3);
  });

  it("times out with last reason", async () => {
    const fakeNow = (() => {
      let t = 0;
      return () => (t += 100);
    })();
    const r = await pollExpect(
      { text_visible: "never", timeout_ms: 250, poll_interval_ms: 50 },
      async () => ({ text: "still nope" }),
      { now: fakeNow, sleep: async () => {} },
    );
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/never/);
  });

  it("with undefined expect, still calls getObservation once and returns matched", async () => {
    let calls = 0;
    const r = await pollExpect(undefined, async () => {
      calls++;
      return { text: "x" };
    });
    expect(r.matched).toBe(true);
    expect(calls).toBe(1);
  });
});
