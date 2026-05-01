/** Module-scoped gated-domain pattern list. Updated on every HelloAck. */
let patterns: readonly string[] = [];

export function setGatedDomainPatterns(p: readonly string[]): void {
  patterns = p;
}

export function getGatedDomainPatterns(): readonly string[] {
  return patterns;
}
