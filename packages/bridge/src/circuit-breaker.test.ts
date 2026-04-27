import { beforeEach, describe, expect, it } from "vitest";
import {
  checkBreaker,
  recordResult,
  _resetBreakerForTests,
  _BREAKER_CONSTANTS,
} from "./circuit-breaker.js";

describe("circuit-breaker", () => {
  beforeEach(() => {
    _resetBreakerForTests();
  });

  it("does not trip on the first or second identical failure (threshold = 2 prior failures)", () => {
    const call = {
      method: "browser_click",
      params: { tab_id: "t_1", ref: 42 },
    };

    // 1st call: no entry yet → not tripped.
    expect(checkBreaker(call, 1_000).tripped).toBe(false);
    recordResult(call, { ok: false, error_code: "REF_NOT_FOUND" }, 1_000);

    // 2nd call: 1 prior failure < threshold (2) → not tripped.
    expect(checkBreaker(call, 2_000).tripped).toBe(false);
    recordResult(call, { ok: false, error_code: "REF_NOT_FOUND" }, 2_000);

    // 3rd call: 2 prior failures == threshold → tripped.
    const result = checkBreaker(call, 3_000);
    expect(result.tripped).toBe(true);
    if (result.tripped) {
      expect(result.error.code).toBe("REPEATED_FAILURE");
      expect(result.error.diagnostic.method).toBe("browser_click");
      expect(result.error.diagnostic.tab_id).toBe("t_1");
      expect(result.error.diagnostic.ref_or_selector).toBe("ref:42");
      expect(result.error.diagnostic.last_error_code).toBe("REF_NOT_FOUND");
      expect(result.error.diagnostic.repeat_count).toBe(2);
      expect(result.error.diagnostic.window_seconds).toBe(30);
      expect(result.error.next_action).toContain("browser_quick_read");
      expect(result.error.next_action).toContain("2 times");
    }
  });

  it("resets the counter when the same call succeeds between failures", () => {
    const call = {
      method: "browser_click",
      params: { tab_id: "t_1", ref: 42 },
    };

    // Two failures → would trip on the third.
    recordResult(call, { ok: false, error_code: "REF_NOT_FOUND" }, 1_000);
    recordResult(call, { ok: false, error_code: "REF_NOT_FOUND" }, 2_000);
    expect(checkBreaker(call, 2_500).tripped).toBe(true);

    // Success clears the entry.
    recordResult(call, { ok: true }, 3_000);
    expect(checkBreaker(call, 3_500).tripped).toBe(false);

    // Need to accumulate two fresh failures again before tripping.
    recordResult(call, { ok: false, error_code: "REF_NOT_FOUND" }, 4_000);
    expect(checkBreaker(call, 4_500).tripped).toBe(false);
    recordResult(call, { ok: false, error_code: "REF_NOT_FOUND" }, 5_000);
    expect(checkBreaker(call, 5_500).tripped).toBe(true);
  });

  it("does not trip when params differ — different ref, same method/tab", () => {
    const callA = {
      method: "browser_click",
      params: { tab_id: "t_1", ref: 42 },
    };
    const callB = {
      method: "browser_click",
      params: { tab_id: "t_1", ref: 43 },
    };

    recordResult(callA, { ok: false, error_code: "REF_NOT_FOUND" }, 1_000);
    recordResult(callA, { ok: false, error_code: "REF_NOT_FOUND" }, 2_000);

    // callA would now trip…
    expect(checkBreaker(callA, 3_000).tripped).toBe(true);
    // …but callB has its own counter.
    expect(checkBreaker(callB, 3_000).tripped).toBe(false);
  });

  it("does not trip when args body differs (same method/tab/ref, different other args)", () => {
    const callA = {
      method: "browser_type",
      params: { tab_id: "t_1", ref: 7, text: "hello" },
    };
    const callB = {
      method: "browser_type",
      params: { tab_id: "t_1", ref: 7, text: "goodbye" },
    };

    recordResult(callA, { ok: false, error_code: "WRITE_NOT_REFLECTED" }, 1_000);
    recordResult(callA, { ok: false, error_code: "WRITE_NOT_REFLECTED" }, 2_000);

    expect(checkBreaker(callA, 3_000).tripped).toBe(true);
    expect(checkBreaker(callB, 3_000).tripped).toBe(false);
  });

  it("does not trip when the failure window has elapsed", () => {
    const call = {
      method: "browser_click",
      params: { tab_id: "t_1", ref: 42 },
    };

    recordResult(call, { ok: false, error_code: "REF_NOT_FOUND" }, 1_000);
    recordResult(call, { ok: false, error_code: "REF_NOT_FOUND" }, 2_000);

    // Inside the window → tripped.
    expect(checkBreaker(call, 10_000).tripped).toBe(true);

    // Past WINDOW_MS from first_seen_at (1_000 + 30_000 = 31_000) → not tripped.
    expect(checkBreaker(call, 31_500).tripped).toBe(false);
  });

  it("falls back to 'no_tab' / 'no_target' sentinels when params lack tab_id/ref/selector", () => {
    const call = {
      method: "browser_list_tabs",
      params: {},
    };

    recordResult(call, { ok: false, error_code: "INTERNAL" }, 1_000);
    recordResult(call, { ok: false, error_code: "INTERNAL" }, 2_000);

    const result = checkBreaker(call, 3_000);
    expect(result.tripped).toBe(true);
    if (result.tripped) {
      expect(result.error.diagnostic.tab_id).toBe("no_tab");
      expect(result.error.diagnostic.ref_or_selector).toBe("no_target");
    }
  });

  it("treats string selector as the target when ref is absent", () => {
    const call = {
      method: "browser_click_by_text",
      params: { tab_id: "t_1", selector: "Submit" },
    };

    recordResult(call, { ok: false, error_code: "TEXT_NOT_FOUND" }, 1_000);
    recordResult(call, { ok: false, error_code: "TEXT_NOT_FOUND" }, 2_000);

    const result = checkBreaker(call, 3_000);
    expect(result.tripped).toBe(true);
    if (result.tripped) {
      expect(result.error.diagnostic.ref_or_selector).toBe("sel:Submit");
    }
  });

  it("constants match the spec (threshold 2 prior failures, 30s window)", () => {
    expect(_BREAKER_CONSTANTS.FAILURE_THRESHOLD).toBe(2);
    expect(_BREAKER_CONSTANTS.WINDOW_MS).toBe(30_000);
  });
});
