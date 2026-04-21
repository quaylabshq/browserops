import { readFile } from "node:fs/promises";
import { riskyDomainsPath } from "./paths.js";

/**
 * Starter sensitive-domain list. User extends via ~/.browserops/risky-domains.json.
 * See plans/06-autonomy-safety.md §4.2.
 */
const DEFAULT_PATTERNS: readonly string[] = [
  "*.chase.com",
  "*.bankofamerica.com",
  "*.wellsfargo.com",
  "*.citibank.com",
  "*.hsbc.com",
  "paypal.com",
  "*.paypal.com",
  "venmo.com",
  "*.venmo.com",
  "1password.com",
  "bitwarden.com",
  "*.coinbase.com",
  "robinhood.com",
];

export interface RiskyDomainMatcher {
  matches(url: string): boolean;
  patterns: readonly string[];
}

export async function loadRiskyDomainMatcher(): Promise<RiskyDomainMatcher> {
  const patterns = [...DEFAULT_PATTERNS];
  try {
    const raw = await readFile(riskyDomainsPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const p of parsed) {
        if (typeof p === "string" && p.length > 0) patterns.push(p);
      }
    }
  } catch (err: unknown) {
    if (!isENOENT(err)) {
      process.stderr.write(
        `browserops: failed to read ${riskyDomainsPath()}: ${(err as Error).message}\n`,
      );
    }
  }

  return {
    patterns,
    matches(url: string): boolean {
      const host = hostOf(url);
      if (!host) return false;
      return patterns.some((p) => matchGlob(host, p));
    },
  };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Minimal glob matcher: leading `*.` means any subdomain level, otherwise
 * exact host match (case-insensitive). No other wildcards supported.
 */
function matchGlob(host: string, pattern: string): boolean {
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    return host === suffix || host.endsWith("." + suffix);
  }
  return host === p;
}

function isENOENT(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}
