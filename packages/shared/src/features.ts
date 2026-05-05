/**
 * Feature flag manifest.
 *
 * Tools and extension-router methods are tagged with an optional `feature`
 * name. The bridge and the extension consult an `enabledFeatures: Set<string>`
 * (sourced from ~/.browserops/config.json + the BROWSEROPS_FEATURES env var)
 * to decide whether to expose, register, or accept calls into those code
 * paths. Untagged tools / methods are core and always-on.
 *
 * Adding a new optional surface = add a name to FEATURES, an entry to
 * FEATURE_METADATA, tag the relevant ToolDef.feature and router handler
 * options. Two enforcement points (mcp-server tools/list+dispatch and
 * extension router dispatch) cover everything else.
 */

export const FEATURES = [
  "teach",
  "procedures",
  "gated-domains",
  "autoteach",
] as const;

export type FeatureName = (typeof FEATURES)[number];

export interface FeatureMetadata {
  /** One-line user-facing description shown in `browserops feature list`. */
  description: string;
  /** Stability label surfaced in the CLI and in tool descriptions. */
  stability: "stable" | "experimental";
  /** Whether the feature is on when no config / env override is present. */
  default: boolean;
}

/**
 * Default state per feature is set explicitly below. `teach` and
 * `procedures` ship off so the agent's tools/list catalogue stays minimal
 * for users who only want basic browser automation. `gated-domains` ships
 * on because the in-band advisor and auto-CDP only deliver value when the
 * agent actually sees them — users who want to avoid Chrome's
 * "controlled by automation" banner on Gmail/Slack/etc. can disable it
 * with `browserops feature disable gated-domains`.
 */
export const FEATURE_METADATA: Record<FeatureName, FeatureMetadata> = {
  teach: {
    description:
      "Teach mode — record a user demonstration in real Chrome and distill it into a procedure.",
    stability: "experimental",
    default: false,
  },
  procedures: {
    description:
      "Procedure runtime — list/search/save/run named, parameterised action graphs from ~/browserops/procedures/.",
    stability: "experimental",
    default: false,
  },
  "gated-domains": {
    description:
      "Auto-attach CDP and bias the agent toward browser_execute_js on a curated list of rich-editor / SPA domains (Gmail, Slack, Notion, Linear, Discord, …). Extend the list via ~/.browserops/gated-domains.json.",
    stability: "experimental",
    default: true,
  },
  autoteach: {
    description:
      "Auto-teach — bootstrap a procedure from one user demonstration, then iteratively replay-and-optimize with one change per run until convergence. Requires the procedures and teach features to also be enabled when the loop is in demo mode.",
    stability: "experimental",
    default: false,
  },
};

/** Names of all known features as a readonly Set, useful for membership checks. */
export const KNOWN_FEATURES: ReadonlySet<string> = new Set(FEATURES);

export function isFeatureName(value: unknown): value is FeatureName {
  return typeof value === "string" && KNOWN_FEATURES.has(value);
}

/**
 * Parse a comma-separated `BROWSEROPS_FEATURES` env value into a feature set.
 * Unknown names are silently skipped so a typo doesn't crash boot — the bridge
 * logs a warning. Empty string and undefined return an empty set.
 */
export function parseFeaturesEnv(raw: string | undefined): {
  enabled: Set<FeatureName>;
  unknown: string[];
} {
  const enabled = new Set<FeatureName>();
  const unknown: string[] = [];
  if (raw === undefined || raw.trim() === "") return { enabled, unknown };
  for (const tokenRaw of raw.split(",")) {
    const token = tokenRaw.trim();
    if (token === "") continue;
    if (isFeatureName(token)) enabled.add(token);
    else unknown.push(token);
  }
  return { enabled, unknown };
}

/**
 * Resolve a feature set from a partial record (typically loaded from
 * config.json). Falls back to FEATURE_METADATA[name].default for any name
 * not explicitly listed.
 */
export function resolveFeatures(
  partial: Partial<Record<FeatureName, boolean>> | undefined,
): Set<FeatureName> {
  const out = new Set<FeatureName>();
  for (const name of FEATURES) {
    const explicit = partial?.[name];
    const enabled = typeof explicit === "boolean" ? explicit : FEATURE_METADATA[name].default;
    if (enabled) out.add(name);
  }
  return out;
}
