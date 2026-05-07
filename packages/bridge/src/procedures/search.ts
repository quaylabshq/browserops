/**
 * Weighted-field search ranker for the procedure catalogue.
 *
 * Pure function over a parsed Manifest (from index.json). Scoring model:
 *   10 × name-token overlap
 *    8 × trigger-token overlap
 *    5 × domain match (0 or 1)
 *    3 × description-token overlap
 *    2 × input-name-token overlap
 *    2 × tag-token overlap
 *   +0.5 × step-body-token overlap (deep mode only, applied after normalisation)
 *
 * Normalised: score = raw / (queryTokens.length * 10), capped at 1.0.
 */
import * as path from "node:path";
import YAML from "yaml";
import { tokenize } from "@browserops/shared";
import type { ManifestEntry, Manifest } from "./index-builder.js";
import { readProcedureYaml } from "./store.js";
import { CodedError } from "./store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SearchOptions {
  /** Maximum results to return. Default 10, clamped to [1, 25]. */
  limit?: number;
  /** Minimum score threshold. Default 0.2, clamped to [0, 1]. */
  min_score?: number;
  /** Filter to entries with this domain. */
  domain?: string;
  /** Scope filter. Default "all". */
  scope?: "all" | "shared" | `composite:${string}`;
  /** When true, also tokenise step bodies for matching. Default false. */
  deep?: boolean;
  /** When true, include status:draft entries. Default false. */
  include_drafts?: boolean;
}

export interface SearchMatch {
  name: string;
  kind: "leaf" | "composite";
  domain: string | null;
  description: string;
  inputs: string[];
  triggers: string[];
  score: number;
  snippet?: string;
}

export interface SearchResult {
  /** Matches after filtering + limit truncation. */
  matches: SearchMatch[];
  /** Total candidates that passed min_score (before limit). */
  total: number;
  /** True when total > matches.length. */
  truncated: boolean;
  /**
   * Draft procedures surfaced as a fallback when the trusted-only result set
   * was empty. Present only when `include_drafts` was false AND `matches` came
   * back empty AND there exists at least one draft entry that scores. Limited
   * to the same `limit` as `matches`. Use to recover untested procedures the
   * agent would otherwise miss; treat them as suggestions, not trusted hits.
   */
  drafts?: SearchMatch[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Count of query tokens that appear in the target token set.
 */
function overlapCount(queryTokens: string[], targetTokens: Set<string>): number {
  let count = 0;
  for (const qt of queryTokens) {
    if (targetTokens.has(qt)) {
      count++;
    }
  }
  return count;
}

/**
 * Tokenise each string in an array and union the result into a Set.
 */
function unionTokens(strings: string[]): Set<string> {
  const set = new Set<string>();
  for (const s of strings) {
    for (const t of tokenize(s)) {
      set.add(t);
    }
  }
  return set;
}

/** Tokenise a single string into a Set. */
function tokenSet(s: string): Set<string> {
  return new Set(tokenize(s));
}

/**
 * Compute the shallow raw score for a manifest entry against query tokens.
 *
 * Returns { raw, fromName, fromTriggers, fromDescription }
 * where the breakdown is used later for snippet selection.
 */
function shallowScore(
  entry: ManifestEntry,
  name: string,
  queryTokens: string[],
): {
  raw: number;
  fromName: number;
  fromTriggers: number;
  fromDescription: number;
} {
  // name tokens: split on dots to separate domain prefix from stem
  const nameTokens = tokenSet(name.split(".").join(" "));
  const triggerTokens = unionTokens(entry.triggers);
  const descTokens = tokenSet(entry.description);
  const inputTokens = unionTokens(entry.inputs);
  const tagTokens = unionTokens(entry.tags);

  const fromName = overlapCount(queryTokens, nameTokens);
  const fromTriggers = overlapCount(queryTokens, triggerTokens);

  // Domain match: 0 or 1
  let domainContrib = 0;
  if (entry.domain) {
    const domainToken = tokenize(entry.domain)[0];
    if (domainToken !== undefined && queryTokens.includes(domainToken)) {
      domainContrib = 1;
    }
  }

  const fromDescription = overlapCount(queryTokens, descTokens);
  const fromInputs = overlapCount(queryTokens, inputTokens);
  const fromTags = overlapCount(queryTokens, tagTokens);

  const raw =
    10 * fromName +
    8 * fromTriggers +
    5 * domainContrib +
    3 * fromDescription +
    2 * fromInputs +
    2 * fromTags;

  return { raw, fromName, fromTriggers, fromDescription };
}

/**
 * Extract step-body tokens from a parsed procedure YAML object.
 *
 * Concatenates `action` + JSON.stringify(with || {}) for every step,
 * including nested for_each.do steps.
 */
function extractStepTokens(parsed: unknown): Set<string> {
  const set = new Set<string>();

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("steps" in parsed) ||
    !Array.isArray((parsed as Record<string, unknown>)["steps"])
  ) {
    return set;
  }

  const steps = (parsed as Record<string, unknown>)["steps"] as unknown[];

  function processStep(step: unknown): void {
    if (typeof step !== "object" || step === null) return;
    const s = step as Record<string, unknown>;

    // Regular action step
    if (typeof s["action"] === "string") {
      const text = s["action"] + " " + JSON.stringify(s["with"] ?? {});
      for (const t of tokenize(text)) {
        set.add(t);
      }
    }

    // for_each.do steps
    if (Array.isArray(s["do"])) {
      for (const doStep of s["do"] as unknown[]) {
        processStep(doStep);
      }
    }

    // on_fail steps
    if (Array.isArray(s["on_fail"])) {
      for (const failStep of s["on_fail"] as unknown[]) {
        processStep(failStep);
      }
    }
  }

  for (const step of steps) {
    processStep(step);
  }

  return set;
}

/**
 * True when the entry is a top-level shared entry (owner null, path under shared/).
 */
function isShared(entry: ManifestEntry): boolean {
  return entry.owner === null && entry.path.startsWith("shared/");
}

/**
 * Determine whether an entry passes the scope filter.
 */
function passesScopeFilter(
  entryName: string,
  entry: ManifestEntry,
  scope: "all" | "shared" | `composite:${string}`,
): boolean {
  if (scope === "all") return true;
  if (scope === "shared") return isShared(entry);
  // scope === "composite:X"
  const prefix = "composite:";
  const compositeName = scope.slice(prefix.length);
  // Include the composite itself OR any sub owned by it
  return entryName === compositeName || entry.owner === compositeName;
}

/**
 * Pick a snippet string for a match where triggers/description drove the score.
 *
 * - If any trigger contains all query tokens (any order), use that trigger (≤60 chars).
 * - Otherwise use the description sliced to 60 chars.
 * - Returns undefined when neither is helpful.
 */
function pickSnippet(
  entry: ManifestEntry,
  queryTokens: string[],
): string | undefined {
  // Try triggers first
  for (const trigger of entry.triggers) {
    const triggerTokens = new Set(tokenize(trigger));
    if (queryTokens.every((qt) => triggerTokens.has(qt))) {
      return trigger.slice(0, 60);
    }
  }

  // Fall back to description if it's informative (longer than 10 chars)
  if (entry.description.length > 10) {
    return entry.description.slice(0, 60);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

/**
 * Search the procedure manifest for entries matching `query`.
 *
 * @param root     - Procedures root directory. Used only when `deep: true`.
 * @param manifest - Parsed index.json manifest.
 * @param query    - Raw query string from the caller.
 * @param options  - Search options (limit, min_score, domain, scope, deep).
 */
export async function search(
  root: string,
  manifest: Manifest,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult> {
  // Validate: empty query
  if (query.trim() === "") {
    throw new CodedError(
      "INVALID_PARAMS",
      "search query must not be empty",
      { query },
    );
  }

  // Tokenise query
  const queryTokens = tokenize(query);

  // All stop-words / no tokens → zero-match (not an error)
  if (queryTokens.length === 0) {
    return { matches: [], total: 0, truncated: false };
  }

  // Resolve options with defaults and clamping
  const limit = Math.min(25, Math.max(1, options?.limit ?? 10));
  const minScore = Math.min(1, Math.max(0, options?.min_score ?? 0.2));
  const domain = options?.domain;
  const scope: "all" | "shared" | `composite:${string}` =
    options?.scope ?? "all";
  const deep = options?.deep ?? false;
  const includeDrafts = options?.include_drafts ?? false;

  // Normalisation denominator
  const normDenom = queryTokens.length * 10;

  const primary = await rankAndCollect(
    root,
    manifest,
    queryTokens,
    {
      domain,
      scope,
      deep,
      limit,
      minScore,
      normDenom,
      acceptEntry: (entry) => includeDrafts || entry.status !== "draft",
    },
  );

  // Draft fallback: when the caller did not opt into drafts AND the trusted
  // result set is empty, surface drafts under a separate `drafts` key so the
  // agent can use them as a recovery hint instead of silently missing them.
  if (!includeDrafts && primary.matches.length === 0) {
    const draftRun = await rankAndCollect(
      root,
      manifest,
      queryTokens,
      {
        domain,
        scope,
        deep,
        limit,
        minScore,
        normDenom,
        acceptEntry: (entry) => entry.status === "draft",
      },
    );
    if (draftRun.matches.length > 0) {
      return { ...primary, drafts: draftRun.matches };
    }
  }

  return primary;
}

interface RankOptions {
  domain: string | undefined;
  scope: "all" | "shared" | `composite:${string}`;
  deep: boolean;
  limit: number;
  minScore: number;
  normDenom: number;
  acceptEntry: (entry: ManifestEntry) => boolean;
}

/**
 * Score every manifest entry that passes the supplied filters, sort by score,
 * and produce a SearchResult-shaped slice (matches/total/truncated). Pulled
 * out of `search` so the trusted-only and drafts-only passes can share scoring.
 */
async function rankAndCollect(
  root: string,
  manifest: Manifest,
  queryTokens: string[],
  opts: RankOptions,
): Promise<{ matches: SearchMatch[]; total: number; truncated: boolean }> {
  interface Candidate {
    name: string;
    entry: ManifestEntry;
    score: number;
    fromName: number;
    fromTriggers: number;
    fromDescription: number;
  }

  const candidates: Candidate[] = [];

  for (const [name, entry] of Object.entries(manifest.procedures)) {
    if (opts.domain !== undefined && entry.domain !== opts.domain) continue;
    if (!passesScopeFilter(name, entry, opts.scope)) continue;
    if (!opts.acceptEntry(entry)) continue;

    const { raw, fromName, fromTriggers, fromDescription } = shallowScore(
      entry,
      name,
      queryTokens,
    );

    let score = Math.min(1, raw / opts.normDenom);

    if (opts.deep && raw > 0) {
      try {
        const yamlText = await readProcedureYaml(path.join(root, entry.path));
        const parsed = YAML.parse(yamlText) as unknown;
        const stepTokens = extractStepTokens(parsed);
        const stepOverlap = overlapCount(queryTokens, stepTokens);
        score = Math.min(1, score + (0.5 * stepOverlap) / opts.normDenom);
      } catch {
        // If loading fails (e.g. file deleted between index and search),
        // proceed with shallow score only.
      }
    }

    if (score >= opts.minScore) {
      candidates.push({ name, entry, score, fromName, fromTriggers, fromDescription });
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const total = candidates.length;
  const truncated = total > opts.limit;
  const topCandidates = candidates.slice(0, opts.limit);

  const matches: SearchMatch[] = topCandidates.map((c) => {
    const nonNameScore = c.fromTriggers * 8 + c.fromDescription * 3;
    const nameScore = c.fromName * 10;
    const includeSnippet = nonNameScore > nameScore;

    const match: SearchMatch = {
      name: c.name,
      kind: c.entry.kind,
      domain: c.entry.domain,
      description: c.entry.description,
      inputs: c.entry.inputs,
      triggers: c.entry.triggers,
      score: c.score,
    };

    if (includeSnippet) {
      const snippet = pickSnippet(c.entry, queryTokens);
      if (snippet !== undefined) {
        match.snippet = snippet;
      }
    }

    return match;
  });

  return { matches, total, truncated };
}
