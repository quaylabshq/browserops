import { describe, it } from "vitest";
import type { PageEffect } from "./effects.js";

describe("PageEffect", () => {
  it("accepts a fully-populated valid PageEffect object", () => {
    const effect: PageEffect = {
      dom: { added: 3, removed: 1, attr_changes: 2, text_changes: 0 },
      url: { changed: true, before: "https://example.com/a", after: "https://example.com/b" },
      focus: { changed: true, before_selector: "#search", after_selector: "#results" },
      network: { requests_started: 4, requests_completed: 3, in_flight_at_end: 1 },
      window_ms: 500,
      truncated: false,
    };
    // type-level test: just constructing the object is the assertion
    void effect;
  });

  it("allows truncated to be omitted (optional field)", () => {
    const effect: PageEffect = {
      dom: { added: 0, removed: 0, attr_changes: 0, text_changes: 0 },
      url: { changed: false },
      focus: { changed: false },
      network: { requests_started: 0, requests_completed: 0, in_flight_at_end: 0 },
      window_ms: 100,
    };
    void effect;
  });

  it("allows optional url.before / url.after and focus selectors to be omitted", () => {
    const effect: PageEffect = {
      dom: { added: 1, removed: 0, attr_changes: 0, text_changes: 0 },
      url: { changed: false },
      focus: { changed: true, before_selector: null, after_selector: null },
      network: { requests_started: 1, requests_completed: 1, in_flight_at_end: 0 },
      window_ms: 250,
    };
    void effect;
  });

  it("allows focus selectors to be null", () => {
    const effect: PageEffect = {
      dom: { added: 0, removed: 0, attr_changes: 0, text_changes: 0 },
      url: { changed: false },
      focus: { changed: false, before_selector: null, after_selector: null },
      network: { requests_started: 0, requests_completed: 0, in_flight_at_end: 0 },
      window_ms: 50,
    };
    void effect;
  });

  it("rejects an object missing required dom fields", () => {
    const bad: PageEffect = {
      // @ts-expect-error — dom.added is required; omitting it must be a type error
      dom: { removed: 0, attr_changes: 0, text_changes: 0 },
      url: { changed: false },
      focus: { changed: false },
      network: { requests_started: 0, requests_completed: 0, in_flight_at_end: 0 },
      window_ms: 0,
    };
    void bad;
  });
});
