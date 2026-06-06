/**
 * Tiny shared helper: case-insensitive substring OR `/regex/flags`.
 *
 * Used by forbidden.ts and expectation.ts. Lifted out so both paths use
 * exactly the same matching rules.
 */
import { parseSerialisedRegex } from "@browserops/shared";

export function matchString(value: string, pattern: string): boolean {
  if (typeof value !== "string" || typeof pattern !== "string") return false;
  const re = parseSerialisedRegex(pattern);
  if (re !== undefined) return re.test(value);
  return value.toLowerCase().includes(pattern.toLowerCase());
}
