import { readFile } from "node:fs/promises";
import { DEFAULT_GATED_DOMAINS, matchGatedDomain } from "@browserops/shared";
import { gatedDomainsPath } from "./paths.js";

export interface GatedDomainMatcher {
  matches(url: string): boolean;
  patterns: readonly string[];
}

export async function loadGatedDomainMatcher(): Promise<GatedDomainMatcher> {
  const patterns = [...DEFAULT_GATED_DOMAINS];
  try {
    const raw = await readFile(gatedDomainsPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const p of parsed) {
        if (typeof p === "string" && p.length > 0) patterns.push(p);
      }
    }
  } catch (err: unknown) {
    if (!isENOENT(err)) {
      process.stderr.write(
        `browserops: failed to read ${gatedDomainsPath()}: ${(err as Error).message}\n`,
      );
    }
  }

  return {
    patterns,
    matches(url: string): boolean {
      return matchGatedDomain(url, patterns);
    },
  };
}

function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
