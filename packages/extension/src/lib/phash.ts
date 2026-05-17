// dHash (difference hash) — 64-bit perceptual hash for viewport screenshots.
//
// Used by the captureEffect wrapper to detect "did the page visibly change"
// between pre- and post-action screenshots. ~30 ms per call at 256x160 input
// resolution, which is the budgeted per-action overhead.
//
// Algorithm:
//   1. Resize input to 9x8 grayscale.
//   2. For each of the 8 rows, compare each pixel to its right neighbor.
//      Set bit if left > right.
//   3. 8 rows × 8 comparisons = 64 bits.

const HASH_W = 9;
const HASH_H = 8;

export type DHash = bigint;

export async function dhash(pixels: ImageData): Promise<DHash> {
  const small = await resizeToGray(pixels, HASH_W, HASH_H);
  let bits = 0n;
  let bit = 0;
  for (let y = 0; y < HASH_H; y++) {
    for (let x = 0; x < HASH_W - 1; x++) {
      const left = small[y * HASH_W + x];
      const right = small[y * HASH_W + x + 1];
      if (left > right) {
        bits |= 1n << BigInt(bit);
      }
      bit++;
    }
  }
  return bits;
}

export function distance(a: DHash, b: DHash): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export function normalizedDistance(a: DHash, b: DHash): number {
  return distance(a, b) / 64;
}

async function resizeToGray(
  src: ImageData,
  w: number,
  h: number,
): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("OffscreenCanvas 2D context unavailable");
  }
  // Draw the source image scaled down. ImageBitmap goes through the GPU path
  // for the resize, which is faster than manual sampling.
  const bitmap = await createImageBitmap(src, {
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: "low",
  });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    // Rec. 601 luma — cheap, good enough for hashing.
    out[i] = (r * 299 + g * 587 + b * 114) / 1000;
  }
  return out;
}
