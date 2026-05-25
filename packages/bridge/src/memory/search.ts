/**
 * Ranker for the v2 memory store.
 *
 * Supports scope/origin/kind filters and token-coverage ranking.
 *
 * Ranking: confidence-first when a `confidenceOf` function is provided
 * (Phase 3.2 wires this); falls back to token-coverage + legacyRaw
 * tie-break when no confidence function is given.
 *
 * Legacy MemoryEntry search (searchMemories) is preserved for backward
 * compatibility with the old markdown-based store tests and the legacy
 * handlers path.
 */
import {
  tokenize,
  type MemoryEntry,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type MemorySearchMatch,
  type MemoryType,
} from "@browserops/shared";

// ---------------------------------------------------------------------------
// Legacy search (MemoryEntry / markdown) — preserved for backward compat
// ---------------------------------------------------------------------------

export interface MemorySearchOptions {
  /** Filter to entries with this type. */
  type?: MemoryType;
  /** Maximum results to return. Default 10, clamped to [1, 25]. */
  limit?: number;
  /** Minimum score threshold. Default 0.2, clamped to [0, 1]. */
  min_score?: number;
}

export interface MemorySearchResult {
  matches: MemorySearchMatch[];
  total: number;
  truncated: boolean;
}

const SNIPPET_MAX = 120;

function tokenSet(s: string): Set<string> {
  return new Set(tokenize(s));
}

function overlap(queryTokens: string[], target: Set<string>): number {
  let n = 0;
  for (const t of queryTokens) if (target.has(t)) n++;
  return n;
}

function bodySnippet(body: string): string {
  const trimmed = body.trim().replace(/\s+/g, " ");
  return trimmed.length <= SNIPPET_MAX ? trimmed : trimmed.slice(0, SNIPPET_MAX - 1) + "…";
}

export function searchMemories(
  entries: MemoryEntry[],
  query: string,
  options?: MemorySearchOptions,
): MemorySearchResult {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0) return { matches: [], total: 0, truncated: false };

  const limit = Math.min(25, Math.max(1, options?.limit ?? 10));
  const minScore = Math.min(1, Math.max(0, options?.min_score ?? 0.2));
  const typeFilter = options?.type;

  interface Scored {
    match: MemorySearchMatch;
    legacyRaw: number;
  }
  const scored: Scored[] = [];

  for (const entry of entries) {
    if (typeFilter !== undefined && entry.meta.type !== typeFilter) continue;

    const nameTokens = tokenSet(entry.meta.name.split(/[._-]/).join(" "));
    const descTokens = tokenSet(entry.meta.description);
    const bodyTokens = tokenSet(entry.body);
    const typeTokens = tokenSet(entry.meta.type);

    const fromName = overlap(queryTokens, nameTokens);
    const fromDesc = overlap(queryTokens, descTokens);
    const fromBody = overlap(queryTokens, bodyTokens);
    const fromType = overlap(queryTokens, typeTokens);

    const union = new Set<string>();
    for (const t of nameTokens) union.add(t);
    for (const t of descTokens) union.add(t);
    for (const t of bodyTokens) union.add(t);
    for (const t of typeTokens) union.add(t);

    const coverage = overlap(queryTokens, union);
    const score = coverage / queryTokens.length;
    if (score < minScore) continue;

    const legacyRaw = 10 * fromName + 5 * fromDesc + 1 * fromBody + 2 * fromType;

    scored.push({
      match: {
        name: entry.meta.name,
        description: entry.meta.description,
        type: entry.meta.type,
        score,
        snippet: bodySnippet(entry.body),
      },
      legacyRaw,
    });
  }

  scored.sort((a, b) => {
    if (b.match.score !== a.match.score) return b.match.score - a.match.score;
    if (b.legacyRaw !== a.legacyRaw) return b.legacyRaw - a.legacyRaw;
    return a.match.name < b.match.name ? -1 : a.match.name > b.match.name ? 1 : 0;
  });

  const total = scored.length;
  const truncated = total > limit;
  return {
    matches: scored.slice(0, limit).map((s) => s.match),
    total,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// v2 record search (MemoryRecord)
// ---------------------------------------------------------------------------

export interface RecordSearchOptions {
  /** Filter to records with this scope. */
  scope?: MemoryScope;
  /**
   * Filter to records for this origin (scheme://host[:port]).
   * Only records with scope==="site" and a matching origin will be included.
   */
  origin?: string;
  /** Filter to records with this kind. */
  kind?: MemoryKind;
  /** Maximum results to return. Default 10, clamped to [1, 25]. */
  limit?: number;
  /** Minimum score threshold. Default 0.2, clamped to [0, 1]. */
  min_score?: number;
  /**
   * Confidence seam for Phase 3.2.
   *
   * When provided, ranking is confidence-first (desc), then token-coverage,
   * then legacyRaw tie-break. When absent (or returning 0), falls back to
   * pure token-coverage ranking.
   *
   * Phase 3.2 wires this by passing `confidence` from confidence.ts.
   * Phase 2 callers omit it (defaulting to 0 for all records).
   */
  confidenceOf?: (record: MemoryRecord) => number;
}

export interface RecordSearchMatch {
  name: string;
  title: string;
  scope: MemoryScope;
  kind: MemoryKind;
  origin?: string;
  /** Token-coverage score in [0, 1]. */
  score: number;
  /**
   * Confidence score in [0, 1], as reported by the confidenceOf function.
   * Defaults to 0 when no confidenceOf is provided.
   */
  confidence: number;
  /** First ~120 chars of the most relevant detail field. */
  snippet: string;
}

export interface RecordSearchResult {
  matches: RecordSearchMatch[];
  total: number;
  truncated: boolean;
}

/** Extract the indexed text content from a MemoryRecord. */
function recordIndexText(r: MemoryRecord): string {
  const parts: string[] = [r.title, r.name.split(/[._-]/).join(" ")];
  if (r.detail.wall) parts.push(r.detail.wall);
  if (r.detail.door) parts.push(r.detail.door);
  if (r.detail.note) parts.push(r.detail.note);
  if (r.kind) parts.push(r.kind);
  if (r.scope) parts.push(r.scope);
  if (r.tags) parts.push(...r.tags);
  return parts.join(" ");
}

/** Build a snippet from the most relevant detail field. */
function recordSnippet(r: MemoryRecord): string {
  const text = r.detail.note ?? r.detail.wall ?? r.detail.door ?? r.title;
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length <= SNIPPET_MAX ? trimmed : trimmed.slice(0, SNIPPET_MAX - 1) + "…";
}

/**
 * Search v2 MemoryRecord entries with optional scope/origin/kind filters.
 *
 * Phase 2: rank by token coverage, with legacyRaw as tie-break.
 * Phase 3.2 seam: pass `confidenceOf` to rank by confidence first.
 */
export function searchRecords(
  records: MemoryRecord[],
  query: string,
  options?: RecordSearchOptions,
): RecordSearchResult {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0) return { matches: [], total: 0, truncated: false };

  const limit = Math.min(25, Math.max(1, options?.limit ?? 10));
  const minScore = Math.min(1, Math.max(0, options?.min_score ?? 0.2));
  const { scope: scopeFilter, origin: originFilter, kind: kindFilter, confidenceOf } = options ?? {};

  interface Scored {
    match: RecordSearchMatch;
    legacyRaw: number;
    confidence: number;
  }
  const scored: Scored[] = [];

  for (const record of records) {
    // Scope filter
    if (scopeFilter !== undefined && record.scope !== scopeFilter) continue;

    // Origin filter: only site-scoped records can match an origin filter
    if (originFilter !== undefined) {
      if (record.scope !== "site") continue;
      if (record.origin !== originFilter) continue;
    }

    // Kind filter
    if (kindFilter !== undefined && record.kind !== kindFilter) continue;

    const nameTokens = tokenSet(record.name.split(/[._-]/).join(" "));
    const titleTokens = tokenSet(record.title);
    const detailTokens = tokenSet(
      [record.detail.wall, record.detail.door, record.detail.note]
        .filter(Boolean)
        .join(" "),
    );
    const kindTokens = tokenSet(record.kind);
    const tagTokens = record.tags ? tokenSet(record.tags.join(" ")) : new Set<string>();

    const fromName = overlap(queryTokens, nameTokens);
    const fromTitle = overlap(queryTokens, titleTokens);
    const fromDetail = overlap(queryTokens, detailTokens);
    const fromKind = overlap(queryTokens, kindTokens);

    const union = new Set<string>();
    for (const t of nameTokens) union.add(t);
    for (const t of titleTokens) union.add(t);
    for (const t of detailTokens) union.add(t);
    for (const t of kindTokens) union.add(t);
    for (const t of tagTokens) union.add(t);

    const coverage = overlap(queryTokens, union);
    const score = coverage / queryTokens.length;
    if (score < minScore) continue;

    const legacyRaw =
      10 * fromName + 8 * fromTitle + 2 * fromDetail + 1 * fromKind;
    const confidence = confidenceOf ? confidenceOf(record) : 0;

    scored.push({
      match: {
        name: record.name,
        title: record.title,
        scope: record.scope,
        kind: record.kind,
        origin: record.origin,
        score,
        confidence,
        snippet: recordSnippet(record),
      },
      legacyRaw,
      confidence,
    });
  }

  // Sort: confidence-first (if any nonzero), then score, then legacyRaw, then name
  scored.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.match.score !== a.match.score) return b.match.score - a.match.score;
    if (b.legacyRaw !== a.legacyRaw) return b.legacyRaw - a.legacyRaw;
    return a.match.name < b.match.name ? -1 : a.match.name > b.match.name ? 1 : 0;
  });

  const total = scored.length;
  const truncated = total > limit;
  return {
    matches: scored.slice(0, limit).map((s) => s.match),
    total,
    truncated,
  };
}

// Re-export recordIndexText for tests
export { recordIndexText };
