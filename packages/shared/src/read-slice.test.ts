import { describe, expect, it } from "vitest";
import { sliceContent } from "./read-slice.js";

describe("sliceContent", () => {
  it("returns the first length chars and next_start on partial reads", () => {
    const res = sliceContent("abcdef", 0, 3);
    expect(res).toEqual({
      slice: "abc",
      total_length: 6,
      next_start: 3,
      truncated: true,
    });
  });

  it("returns the final slice with next_start=null when it reaches total_length", () => {
    const res = sliceContent("abcdef", 3, 3);
    expect(res).toEqual({
      slice: "def",
      total_length: 6,
      next_start: null,
      truncated: false,
    });
  });

  it("clamps start == total_length to empty slice", () => {
    expect(sliceContent("abcdef", 6, 3)).toEqual({
      slice: "",
      total_length: 6,
      next_start: null,
      truncated: false,
    });
  });

  it("clamps start > total_length without error", () => {
    expect(sliceContent("abcdef", 100, 3)).toEqual({
      slice: "",
      total_length: 6,
      next_start: null,
      truncated: false,
    });
  });

  it("returns the whole content when length exceeds total", () => {
    const res = sliceContent("abc", 0, 100);
    expect(res.slice).toBe("abc");
    expect(res.total_length).toBe(3);
    expect(res.next_start).toBeNull();
    expect(res.truncated).toBe(false);
  });

  it("operates on UTF-16 code units (mid-surrogate slicing permitted)", () => {
    // Musical symbol G clef is U+1D11E = surrogate pair [0xD834, 0xDD1E].
    const content = "A𝄞B";
    expect(content.length).toBe(4);
    const res = sliceContent(content, 1, 1);
    expect(res.slice).toBe("\uD834"); // lone high surrogate
    expect(res.next_start).toBe(2);
  });

  it("sets truncated=false when the slice reaches the end exactly", () => {
    const res = sliceContent("abc", 0, 3);
    expect(res.truncated).toBe(false);
    expect(res.next_start).toBeNull();
  });
});
