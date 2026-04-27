/** Default gated-domain glob list. User extends via ~/.browserops/gated-domains.json on the bridge side. */
export const DEFAULT_GATED_DOMAINS: readonly string[] = [
  "mail.google.com",
  "*.slack.com",
  "*.notion.so",
  "linear.app",
  "discord.com",
  "*.discord.com",
  "*.figma.com",
  "app.gmail.com",
];

/** One-line directive surfaced to the agent on navigate/current_tab when a match. */
export const GATED_DOMAIN_DIRECTIVE =
  "Gated domain: prefer browser_execute_js over click/type/press. CDP is auto-attached for trusted-input dispatch.";

/** Extract hostname or null on parse error. */
export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Match a URL against a list of glob patterns. Patterns: leading "*." matches
 * any subdomain depth (including the bare apex); otherwise exact host.
 * Case-insensitive. Returns false on URL parse error.
 */
export function matchGatedDomain(url: string, patterns: readonly string[]): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  return patterns.some((p) => {
    const pat = p.toLowerCase();
    if (pat.startsWith("*.")) {
      const suffix = pat.slice(2);
      return host === suffix || host.endsWith("." + suffix);
    }
    return host === pat;
  });
}
