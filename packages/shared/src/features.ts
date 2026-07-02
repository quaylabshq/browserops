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

export const FEATURES = ["procedures", "lore"] as const;

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
 * Default state per feature is set explicitly below. `procedures` ships
 * off so the agent's tools/list catalogue stays minimal for users who
 * only want basic browser automation. CDP-trusted input is universal —
 * every http(s) navigation attaches CDP by default — so there is no
 * dispatch-mode feature flag.
 */
export const FEATURE_METADATA: Record<FeatureName, FeatureMetadata> = {
  procedures: {
    description:
      "Procedure runtime — deterministic-first browser flows with semantic locators (auto-resolved via browser_propose_locator), retrying expect predicates, per-step LLM-fallback ladder (resume via procedures_resume), and drift-health auto-demote. Stored at ~/browserops/procedures/. Authored via the browserops-teach skill.",
    stability: "experimental",
    default: false,
  },
  lore: {
    description:
      "Cross-agent lore store at ~/browserops/lore/. Save/search/get/delete named markdown entries via MCP — visible to every MCP client (Cursor, Zed, Claude Code, custom SDK). Lets agents teach each other lessons that outlive a single session.",
    stability: "experimental",
    default: true,
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
