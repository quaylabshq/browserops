/**
 * Pure helper for browser.read byte-range pagination. Slices content by
 * JavaScript UTF-16 code units (i.e. `string.length` / `string.slice`),
 * matching the semantics callers get out of `indexOf` / `matchAll`. Mid-
 * surrogate and mid-tag slicing is permitted — callers searching for a
 * substring won't notice, and slicing is pure byte-addressing anyway.
 *
 * Contract:
 *   - `start > content.length` clamps to "", with next_start = null.
 *   - `length` > remaining returns the remainder; next_start = null.
 *   - Otherwise returns [start, start+length) and next_start = start + length.
 */

export interface ContentSlice {
  slice: string;
  total_length: number;
  next_start: number | null;
  truncated: boolean;
}

export function sliceContent(
  content: string,
  start: number,
  length: number,
): ContentSlice {
  const total = content.length;
  if (start >= total) {
    return { slice: "", total_length: total, next_start: null, truncated: false };
  }
  const end = Math.min(start + length, total);
  const slice = content.slice(start, end);
  const next = end < total ? end : null;
  return {
    slice,
    total_length: total,
    next_start: next,
    truncated: next !== null,
  };
}
