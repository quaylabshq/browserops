/**
 * Coverage-based ranker for the lore store.
 *
 *   score = (distinct query tokens that appear anywhere in the entry's
 *            indexed-field tokens) / |distinct query tokens|
 *
 * Indexed fields: name + description + type + body. legacyRaw is a
 * weighted tie-breaker that favours name/description matches over body
 * matches, so an entry whose name or one-liner contains the query
 * outranks one where the same tokens only appear deep in the body.
 *
 * Kept deliberately smaller than procedures/search.ts: no scope/domain
 * filters, no draft/trusted split, no deep-mode YAML loading. Memories
 * are flat markdown files; their "deep" content is already loaded in
 * memory by the time the ranker runs.
 */
import { tokenize, type LoreEntry, type LoreSearchMatch, type LoreType } from "@browserops/shared";

export interface LoreSearchOptions {
  /** Filter to entries with this type. */
  type?: LoreType;
  /** Maximum results to return. Default 10, clamped to [1, 25]. */
  limit?: number;
  /** Minimum score threshold. Default 0.2, clamped to [0, 1]. */
  min_score?: number;
}

export interface LoreSearchResult {
  matches: LoreSearchMatch[];
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

export function searchLore(
  entries: LoreEntry[],
  query: string,
  options?: LoreSearchOptions,
): LoreSearchResult {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0) return { matches: [], total: 0, truncated: false };

  const limit = Math.min(25, Math.max(1, options?.limit ?? 10));
  const minScore = Math.min(1, Math.max(0, options?.min_score ?? 0.2));
  const typeFilter = options?.type;

  interface Scored {
    match: LoreSearchMatch;
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
