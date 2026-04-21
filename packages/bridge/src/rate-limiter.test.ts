import { beforeEach, describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limiter.js";

describe("RateLimiter", () => {
  let now: number;
  const clock = (): number => now;

  beforeEach(() => {
    now = 0;
  });

  it("weight-0 calls always succeed and do not consume", () => {
    const rl = new RateLimiter(16, 60, clock);
    for (let i = 0; i < 1000; i++) {
      expect(rl.tryConsume("t_1", 0)).toEqual({ ok: true });
    }
    // Budget untouched — can still spend the full 16 of weight-1.
    for (let i = 0; i < 16; i++) {
      expect(rl.tryConsume("t_1", 1).ok).toBe(true);
    }
    expect(rl.tryConsume("t_1", 1).ok).toBe(false);
  });

  it("per-tab cap kicks in at 16 weight-1 calls / minute", () => {
    const rl = new RateLimiter(16, 600, clock);
    for (let i = 0; i < 16; i++) {
      expect(rl.tryConsume("t_1", 1).ok).toBe(true);
    }
    const result = rl.tryConsume("t_1", 1);
    expect(result.ok).toBe(false);
    expect(result.scope).toBe("tab");
    expect(result.retry_after_ms).toBeGreaterThan(0);
  });

  it("global cap kicks in across tabs", () => {
    const rl = new RateLimiter(100, 10, clock);
    for (let i = 0; i < 10; i++) {
      expect(rl.tryConsume(`t_${i}`, 1).ok).toBe(true);
    }
    const result = rl.tryConsume("t_11", 1);
    expect(result.ok).toBe(false);
    expect(result.scope).toBe("global");
  });

  it("global-first ordering: no per-tab charge on global denial", () => {
    const rl = new RateLimiter(16, 1, clock);
    expect(rl.tryConsume("t_1", 1).ok).toBe(true); // consumes 1 global + 1 tab
    expect(rl.tryConsume("t_1", 1).ok).toBe(false); // global denied
    // Advance one minute → global refills to 1, tab refills to 16.
    now = 60_000;
    expect(rl.tryConsume("t_1", 1).ok).toBe(true);
  });

  it("bucket refills continuously", () => {
    const rl = new RateLimiter(16, 60, clock);
    for (let i = 0; i < 16; i++) rl.tryConsume("t_1", 1);
    expect(rl.tryConsume("t_1", 1).ok).toBe(false);
    // 3.75 s = (1/16) of a minute → 1 token.
    now = 3_750;
    expect(rl.tryConsume("t_1", 1).ok).toBe(true);
  });

  it("half-weight actions cost half a token", () => {
    const rl = new RateLimiter(16, 60, clock);
    for (let i = 0; i < 32; i++) {
      expect(rl.tryConsume("t_1", 0.5).ok).toBe(true);
    }
    expect(rl.tryConsume("t_1", 0.5).ok).toBe(false);
  });

  it("forgetTab clears a per-tab bucket", () => {
    const rl = new RateLimiter(2, 100, clock);
    rl.tryConsume("t_1", 1);
    rl.tryConsume("t_1", 1);
    expect(rl.tryConsume("t_1", 1).ok).toBe(false);
    rl.forgetTab("t_1");
    expect(rl.tryConsume("t_1", 1).ok).toBe(true);
  });
});
