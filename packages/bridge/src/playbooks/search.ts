/**
 * Coverage-based search ranker for the playbook catalogue.
 *
 * Same scoring model as procedures/search.ts — coverage / |distinct query
 * tokens|, with legacyRaw tie-break, scope filter, draft fallback. Re-
 * implemented here against PlaybookManifestEntry rather than importing to
 * keep the two systems decoupled (different entry shapes, different deep-
 * mode tokenisation rules).
 */
import * as path from "node:path";
import YAML from "yaml";
import { tokenize } from "@browserops/shared";
import type {
  PlaybookManifestEntry,
  PlaybookManifest,
} from "./index-builder.js";
import { readPlaybookYaml, CodedError } from "./store.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PlaybookSearchOptions {
  limit?: number;
  min_score?: number;
  domain?: string;
  scope?: "all" | "shared" | `composite:${string}`;
  deep?: boolean;
  include_drafts?: boolean;
}

export interface PlaybookSearchMatch {
  name: string;
  kind: "leaf" | "composite";
  domain: string | null;
  description: string;
  goal?: string;
  inputs: string[];
  triggers: string[];
  side_effects: string[];
  score: number;
  snippet?: string;
}

export interface PlaybookSearchResult {
  matches: PlaybookSearchMatch[];
  total: number;
  truncated: boolean;
  drafts?: PlaybookSearchMatch[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function overlapCount(queryTokens: string[], targetTokens: Set<string>): number {
  let count = 0;
  for (const qt of queryTokens) {
    if (targetTokens.has(qt)) count++;
  }
  return count;
}

function unionTokens(strings: string[]): Set<string> {
  const set = new Set<string>();
  for (const s of strings) {
    for (const t of tokenize(s)) set.add(t);
  }
  return set;
}

function tokenSet(s: string): Set<string> {
  return new Set(tokenize(s));
}

function scoreCoverage(
  entry: PlaybookManifestEntry,
  name: string,
  dedupedQueryTokens: string[],
  extraTokens?: Set<string>,
): {
  coverage: number;
  coverageRatio: number;
  legacyRaw: number;
  fromName: number;
  fromTriggers: number;
  fromDescription: number;
} {
  const nameTokens = tokenSet(name.split(".").join(" "));
  const triggerTokens = unionTokens(entry.triggers);
  const descTokens = tokenSet(entry.description);
  const goalTokens = entry.goal ? tokenSet(entry.goal) : new Set<string>();
  const inputTokens = unionTokens(entry.inputs);
  const tagTokens = unionTokens(entry.tags);

  const fromName = overlapCount(dedupedQueryTokens, nameTokens);
  const fromTriggers = overlapCount(dedupedQueryTokens, triggerTokens);

  let domainContrib = 0;
  let domainToken: string | undefined;
  if (entry.domain) {
    domainToken = tokenize(entry.domain)[0];
    if (domainToken !== undefined && dedupedQueryTokens.includes(domainToken)) {
      domainContrib = 1;
    }
  }

  const fromDescription = overlapCount(dedupedQueryTokens, descTokens);
  const fromGoal = overlapCount(dedupedQueryTokens, goalTokens);
  const fromInputs = overlapCount(dedupedQueryTokens, inputTokens);
  const fromTags = overlapCount(dedupedQueryTokens, tagTokens);

  const legacyRaw =
    10 * fromName +
    8 * fromTriggers +
    5 * domainContrib +
    4 * fromGoal +
    3 * fromDescription +
    2 * fromInputs +
    2 * fromTags;

  const union = new Set<string>();
  for (const t of nameTokens) union.add(t);
  for (const t of triggerTokens) union.add(t);
  for (const t of descTokens) union.add(t);
  for (const t of goalTokens) union.add(t);
  for (const t of inputTokens) union.add(t);
  for (const t of tagTokens) union.add(t);
  if (domainToken !== undefined) union.add(domainToken);
  if (extraTokens) {
    for (const t of extraTokens) union.add(t);
  }

  let coverage = 0;
  for (const qt of dedupedQueryTokens) {
    if (union.has(qt)) coverage++;
  }
  const coverageRatio =
    dedupedQueryTokens.length === 0 ? 0 : coverage / dedupedQueryTokens.length;

  return {
    coverage,
    coverageRatio,
    legacyRaw,
    fromName,
    fromTriggers,
    fromDescription,
  };
}

/**
 * Extract step-body tokens from a parsed playbook YAML object.
 * Walks step.do + step.with for every step, plus step.locator role/name.
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

  for (const step of steps) {
    if (typeof step !== "object" || step === null) continue;
    const s = step as Record<string, unknown>;

    if (typeof s["do"] === "string") {
      for (const t of tokenize(s["do"])) set.add(t);
    }
    if (typeof s["goal"] === "string") {
      for (const t of tokenize(s["goal"])) set.add(t);
    }
    if (s["with"] !== undefined && s["with"] !== null) {
      for (const t of tokenize(JSON.stringify(s["with"]))) set.add(t);
    }
    const locator = s["locator"] as Record<string, unknown> | undefined;
    if (locator) {
      if (typeof locator["role"] === "string") {
        for (const t of tokenize(locator["role"])) set.add(t);
      }
      if (typeof locator["name"] === "string") {
        for (const t of tokenize(locator["name"])) set.add(t);
      }
    }
  }

  return set;
}

function isShared(entry: PlaybookManifestEntry): boolean {
  return entry.owner === null && entry.path.startsWith("shared/");
}

function passesScopeFilter(
  entryName: string,
  entry: PlaybookManifestEntry,
  scope: "all" | "shared" | `composite:${string}`,
): boolean {
  if (scope === "all") return true;
  if (scope === "shared") return isShared(entry);
  const prefix = "composite:";
  const compositeName = scope.slice(prefix.length);
  return entryName === compositeName || entry.owner === compositeName;
}

function pickSnippet(
  entry: PlaybookManifestEntry,
  queryTokens: string[],
): string | undefined {
  for (const trigger of entry.triggers) {
    const triggerTokens = new Set(tokenize(trigger));
    if (queryTokens.every((qt) => triggerTokens.has(qt))) {
      return trigger.slice(0, 60);
    }
  }

  if (entry.goal && entry.goal.length > 10) {
    return entry.goal.slice(0, 60);
  }

  if (entry.description.length > 10) {
    return entry.description.slice(0, 60);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function search(
  root: string,
  manifest: PlaybookManifest,
  query: string,
  options?: PlaybookSearchOptions,
): Promise<PlaybookSearchResult> {
  if (query.trim() === "") {
    throw new CodedError("INVALID_PARAMS", "search query must not be empty", {
      query,
    });
  }

  const queryTokens = Array.from(new Set(tokenize(query)));

  if (queryTokens.length === 0) {
    return { matches: [], total: 0, truncated: false };
  }

  const limit = Math.min(25, Math.max(1, options?.limit ?? 10));
  const minScore = Math.min(1, Math.max(0, options?.min_score ?? 0.2));
  const domain = options?.domain;
  const scope: "all" | "shared" | `composite:${string}` =
    options?.scope ?? "all";
  const deep = options?.deep ?? false;
  const includeDrafts = options?.include_drafts ?? false;

  const primary = await rankAndCollect(root, manifest, queryTokens, {
    domain,
    scope,
    deep,
    limit,
    minScore,
    acceptEntry: (entry) => includeDrafts || entry.status !== "draft",
  });

  if (!includeDrafts && primary.matches.length === 0) {
    const draftRun = await rankAndCollect(root, manifest, queryTokens, {
      domain,
      scope,
      deep,
      limit,
      minScore,
      acceptEntry: (entry) => entry.status === "draft",
    });
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
  acceptEntry: (entry: PlaybookManifestEntry) => boolean;
}

async function rankAndCollect(
  root: string,
  manifest: PlaybookManifest,
  queryTokens: string[],
  opts: RankOptions,
): Promise<{
  matches: PlaybookSearchMatch[];
  total: number;
  truncated: boolean;
}> {
  interface Candidate {
    name: string;
    entry: PlaybookManifestEntry;
    score: number;
    legacyRaw: number;
    fromName: number;
    fromTriggers: number;
    fromDescription: number;
  }

  const candidates: Candidate[] = [];

  for (const [name, entry] of Object.entries(manifest.playbooks)) {
    if (opts.domain !== undefined && entry.domain !== opts.domain) continue;
    if (!passesScopeFilter(name, entry, opts.scope)) continue;
    if (!opts.acceptEntry(entry)) continue;

    let scored = scoreCoverage(entry, name, queryTokens);

    if (opts.deep && scored.coverage > 0) {
      try {
        const yamlText = await readPlaybookYaml(path.join(root, entry.path));
        const parsed = YAML.parse(yamlText) as unknown;
        const stepTokens = extractStepTokens(parsed);
        if (stepTokens.size > 0) {
          const widened = scoreCoverage(entry, name, queryTokens, stepTokens);
          const stepOverlap = overlapCount(queryTokens, stepTokens);
          scored = {
            ...widened,
            legacyRaw: widened.legacyRaw + 0.5 * stepOverlap,
          };
        }
      } catch {
        // continue with shallow score
      }
    }

    if (scored.coverageRatio >= opts.minScore) {
      candidates.push({
        name,
        entry,
        score: scored.coverageRatio,
        legacyRaw: scored.legacyRaw,
        fromName: scored.fromName,
        fromTriggers: scored.fromTriggers,
        fromDescription: scored.fromDescription,
      });
    }
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.legacyRaw !== a.legacyRaw) return b.legacyRaw - a.legacyRaw;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const total = candidates.length;
  const truncated = total > opts.limit;
  const topCandidates = candidates.slice(0, opts.limit);

  const matches: PlaybookSearchMatch[] = topCandidates.map((c) => {
    const nonNameScore = c.fromTriggers * 8 + c.fromDescription * 3;
    const nameScore = c.fromName * 10;
    const includeSnippet = nonNameScore > nameScore;

    const match: PlaybookSearchMatch = {
      name: c.name,
      kind: c.entry.kind,
      domain: c.entry.domain,
      description: c.entry.description,
      inputs: c.entry.inputs,
      triggers: c.entry.triggers,
      side_effects: c.entry.side_effects,
      score: c.score,
    };

    if (c.entry.goal !== undefined) match.goal = c.entry.goal;

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
