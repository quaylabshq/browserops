import { describe, expect, it, vi, afterEach } from "vitest";
import { dhash, distance, normalizedDistance } from "./phash.js";

// dhash() depends on OffscreenCanvas + createImageBitmap, neither of which
// exist in the node test environment. We stub them so getImageData returns a
// caller-supplied 9x8 RGBA pattern verbatim — that lets us drive the bit-
// extraction logic with deterministic inputs and assert hashing properties.

function installCanvasMock(getPixels: () => Uint8ClampedArray) {
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          drawImage: () => {},
          getImageData: () => ({ data: getPixels(), width: 9, height: 8 }),
        };
      }
    },
  );
  vi.stubGlobal("createImageBitmap", async () => ({ close: () => {} }));
}

// Build a 9x8 RGBA pattern from an 8-bit grayscale array of length 72.
function grayToRGBA(gray: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(9 * 8 * 4);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

// A smooth horizontal gradient: pixels increase left-to-right within each row.
// dhash compares left > right per row, so this should produce mostly 0 bits.
function gradient(): number[] {
  const out: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      out.push(x * 28);
    }
  }
  return out;
}

// Invert each pixel in a gray pattern.
function invert(gray: number[]): number[] {
  return gray.map((v) => 255 - v);
}

// Add bounded uniform noise to each pixel.
function addNoise(gray: number[], amplitude: number, seed: number): number[] {
  let s = seed;
  return gray.map((v) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const n = (s % (amplitude * 2 + 1)) - amplitude;
    return Math.max(0, Math.min(255, v + n));
  });
}

// A fake placeholder ImageData — its contents don't matter because the mock
// returns the patched pixels regardless.
const placeholder = {} as ImageData;

describe("dhash", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("identical images have distance 0", async () => {
    const pattern = grayToRGBA(gradient());
    installCanvasMock(() => pattern);
    const a = await dhash(placeholder);
    const b = await dhash(placeholder);
    expect(distance(a, b)).toBe(0);
  });

  it("inverted images are not identical", async () => {
    const base = gradient();
    let pixels = grayToRGBA(base);
    installCanvasMock(() => pixels);
    const a = await dhash(placeholder);
    pixels = grayToRGBA(invert(base));
    const b = await dhash(placeholder);
    expect(distance(a, b)).toBeGreaterThan(0);
  });

  it("small noise yields a small distance", async () => {
    const base = gradient();
    let pixels = grayToRGBA(base);
    installCanvasMock(() => pixels);
    const a = await dhash(placeholder);
    pixels = grayToRGBA(addNoise(base, 3, 42));
    const b = await dhash(placeholder);
    expect(distance(a, b)).toBeLessThanOrEqual(5);
  });

  it("large structural change yields a large distance", async () => {
    let pixels = grayToRGBA(gradient());
    installCanvasMock(() => pixels);
    const a = await dhash(placeholder);
    // Replace gradient with a checkerboard — completely different structure.
    const checker: number[] = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 9; x++) {
        checker.push((x + y) % 2 === 0 ? 0 : 255);
      }
    }
    pixels = grayToRGBA(checker);
    const b = await dhash(placeholder);
    expect(distance(a, b)).toBeGreaterThanOrEqual(20);
  });
});

describe("distance / normalizedDistance", () => {
  it("returns 0 for identical hashes", () => {
    expect(distance(0xdeadbeefn, 0xdeadbeefn)).toBe(0);
    expect(normalizedDistance(0xdeadbeefn, 0xdeadbeefn)).toBe(0);
  });

  it("returns 64 for fully inverted hashes", () => {
    const ones = (1n << 64n) - 1n;
    expect(distance(0n, ones)).toBe(64);
    expect(normalizedDistance(0n, ones)).toBe(1);
  });

  it("returns 1 for a single-bit difference", () => {
    expect(distance(0n, 1n)).toBe(1);
    expect(distance(1n << 33n, 0n)).toBe(1);
  });
});
