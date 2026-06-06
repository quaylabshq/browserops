import { describe, expect, it } from "vitest";
import type { StepDef } from "@browserops/shared";
import { applyRetry, applyRelocate } from "./fallback.js";

describe("applyRetry", () => {
  it("returns retry while attempts remain", () => {
    const step: StepDef = {
      id: "s1",
      do: "click",
      fallback: { strategy: "retry", retry: { attempts: 3, backoff_ms: 100 } },
    };
    const d = applyRetry(step, 0);
    expect(d.action).toBe("retry");
    expect(d.backoff_ms).toBe(100);
    expect(d.attempt).toBe(1);
  });

  it("gives up at the configured attempts cap", () => {
    const step: StepDef = {
      id: "s1",
      do: "click",
      fallback: { strategy: "retry", retry: { attempts: 2 } },
    };
    expect(applyRetry(step, 2).action).toBe("give_up");
  });

  it("uses defaults when retry config missing", () => {
    const step: StepDef = { id: "s1", do: "click", fallback: { strategy: "retry" } };
    const d = applyRetry(step, 0);
    expect(d.action).toBe("retry");
    expect(d.backoff_ms).toBeGreaterThan(0);
  });
});

describe("applyRelocate", () => {
  it("drops role when widen_role is true", () => {
    const step: StepDef = {
      id: "s1",
      do: "click",
      locator: { role: "button", name: "Send" },
      fallback: { strategy: "relocate", relocate: { widen_role: true } },
    };
    const r = applyRelocate(step);
    expect(r.action).toBe("retry_with");
    expect(r.locator?.role).toBeUndefined();
    expect(r.locator?.name).toBe("Send");
  });

  it("relaxes anchored regex name when widen_name is true", () => {
    const step: StepDef = {
      id: "s1",
      do: "click",
      locator: { role: "button", name: "/^send$/i" },
      fallback: { strategy: "relocate", relocate: { widen_name: true } },
    };
    const r = applyRelocate(step);
    expect(r.action).toBe("retry_with");
    expect(r.locator?.name).toBe("send");
  });

  it("adds has_text from goal when consider_text is true", () => {
    const step: StepDef = {
      id: "s1",
      do: "click",
      goal: "Click the Schedule send button to defer the message",
      locator: { role: "button" },
      fallback: { strategy: "relocate", relocate: { consider_text: true } },
    };
    const r = applyRelocate(step);
    expect(r.action).toBe("retry_with");
    expect(r.locator?.has_text).toBeDefined();
  });

  it("gives up when no widening produces a change", () => {
    const step: StepDef = {
      id: "s1",
      do: "click",
      locator: { name: "Send" },
      fallback: { strategy: "relocate", relocate: { widen_role: true } },
    };
    const r = applyRelocate(step);
    // role not present → drop produces no change
    expect(r.action).toBe("give_up");
  });

  it("gives up when relocate config missing", () => {
    const step: StepDef = {
      id: "s1",
      do: "click",
      locator: { role: "button", name: "Send" },
      fallback: { strategy: "relocate" },
    };
    expect(applyRelocate(step).action).toBe("give_up");
  });
});
