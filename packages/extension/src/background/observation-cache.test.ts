import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import {
  put,
  get,
  purgeExpired,
  _clear,
  _size,
  type ObservationMetadata,
} from "./observation-cache.js";

function baseMeta(): Omit<ObservationMetadata, "created_at"> {
  return {
    tab_id: 1,
    css_pixel_dims: { w: 1280, h: 720 },
    screenshot_dims: { w: 640, h: 360 },
    scale: 0.5,
    scroll: { x: 0, y: 0 },
    dpr: 2,
    representation: "screenshot",
  };
}

describe("observation-cache", () => {
  beforeEach(() => {
    _clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    _clear();
  });

  it("put/get returns the same metadata for a fresh token", () => {
    const token = put(baseMeta());
    const out = get(token);
    expect(out).not.toBeNull();
    expect(out?.tab_id).toBe(1);
    expect(out?.scale).toBe(0.5);
    expect(out?.created_at).toBeTypeOf("number");
  });

  it("returns null after TTL elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = put(baseMeta());
    expect(get(token)).not.toBeNull();
    // 30 s TTL — advance past it.
    vi.setSystemTime(new Date("2026-01-01T00:00:31Z"));
    expect(get(token)).toBeNull();
  });

  it("purgeExpired drops aged entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const t1 = put(baseMeta());
    vi.setSystemTime(new Date("2026-01-01T00:00:31Z"));
    const t2 = put(baseMeta());
    purgeExpired();
    expect(get(t1)).toBeNull();
    expect(get(t2)).not.toBeNull();
  });

  it("evicts oldest when over MAX_ENTRIES (32)", () => {
    const tokens: string[] = [];
    for (let i = 0; i < 35; i++) tokens.push(put(baseMeta()));
    expect(_size()).toBeLessThanOrEqual(32);
    // First few inserted are gone.
    expect(get(tokens[0]!)).toBeNull();
    expect(get(tokens[1]!)).toBeNull();
    // Last inserted is still there.
    expect(get(tokens[34]!)).not.toBeNull();
  });
});
