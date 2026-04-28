import type { JSONSchemaObject } from "./tools.js";

// ---------------------------------------------------------------------------
// TypeScript types
// ---------------------------------------------------------------------------

/** Allowed primitive types for a procedure input field. */
export type InputFieldType =
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object";

/** A single input parameter definition. */
export interface InputFieldDef {
  type: InputFieldType;
  required?: boolean;
  description?: string;
  /**
   * Marks the input as feeding a destructive surface (sends, payments,
   * posts, deletes). Set by the auto-teach distiller when the value
   * flows into a step classified as side-effecting. The auto-teach loop
   * uses this to require a dummy substitute during training runs.
   */
  destructive?: boolean;
}

/** A precondition check with an optional automatic fallback action. */
export interface PreconditionDef {
  url_matches?: string;
  fallback?: {
    action: string;
    with?: Record<string, unknown>;
  };
}

/**
 * Loose assertion shape emitted by procedures_compile (Phase 4) and
 * verified by procedures_execute (Phase 5 Step 2) during replay.
 *
 * All sub-fields are optional — a step declares only what it cares about.
 */
export interface ExpectedEffect {
  dom?: {
    any?: boolean;
    added_min?: number;
    removed_min?: number;
    attr_changes_min?: number;
    text_changes_min?: number;
  };
  url?: {
    changed?: boolean;
  };
  focus?: {
    changed?: boolean;
  };
  network?: {
    requests_started_min?: number;
    requests_completed_min?: number;
  };
  console_errors_max?: number;
}

/**
 * Selector stability tier — most stable first. Written by the auto-teach
 * distiller from the resolved-element metadata in page_effect; used by
 * future search re-ranking and by the auto-teach next-optimization picker
 * to decide whether a step is a candidate for cache_selector.
 */
export type SelectorTier =
  | "id"
  | "testid"
  | "role_name"
  | "text"
  | "css"
  | "xpath";

/** A concrete single-action step (non-for-each). */
export interface ActionStepDef {
  id: string;
  action: string;
  with?: Record<string, unknown>;
  wait_for?: {
    selector?: string;
    text?: string;
  };
  bind?: string;
  on_fail?: Array<{ action: string; with?: Record<string, unknown> }>;
  expected_effect?: ExpectedEffect;
  /** Selector stability tier — set by the auto-teach distiller. */
  selector_tier?: SelectorTier;
}

/** A for-each iteration step. */
export interface ForEachStepDef {
  id: string;
  for_each: string;
  as: string;
  do: Array<{ action: string; with?: Record<string, unknown> }>;
}

/** A procedure step — either a single action or a for-each loop. */
export type StepDef = ActionStepDef | ForEachStepDef;

/** A success assertion. */
export interface AssertionDef {
  toast_text?: string;
  url_matches?: string;
  selector_exists?: string;
}

/** Bridge-managed metadata (callers must not set these). */
export interface ProcedureMetaDef {
  version: number;
  created: string;
  last_verified?: string;
  success_count?: number;
  failure_count?: number;
  /**
   * draft  = saved but never verified against the live UI; excluded from
   *          procedures_search by default.
   * trusted = verified at least once (success_count >= 1) via procedures_save
   *           with bump_success: true.
   */
  status?: "draft" | "trusted";
}

/**
 * Side-effect classes a procedure performs. Written by the auto-teach
 * distiller from button-text + endpoint heuristics; surfaced to the
 * auto-teach loop so it can require dummy substitutes during training
 * runs and to the agent so it can choose to gate replays for the user.
 */
export type SideEffectClass =
  | "send_message"
  | "payment"
  | "post_public"
  | "modify_account"
  | "delete";

/** Aggregate selector-tier rollup written by the auto-teach distiller. */
export type ProcedureFragility = "low" | "medium" | "high";

/**
 * Full definition of a procedure YAML document (schema_version 1).
 *
 * Leaf procedures do NOT require `uses`.
 * Composite procedures MUST have `uses` (enforced by the JSON-Schema `if/then`).
 */
export interface ProcedureDef {
  schema_version: 1;
  name: string;
  description: string;
  kind: "leaf" | "composite";
  domain?: string;
  triggers?: string[];
  tags?: string[];
  inputs?: Record<string, InputFieldDef>;
  preconditions?: PreconditionDef[];
  uses?: string[];
  steps: StepDef[];
  success_criteria?: AssertionDef[];
  meta?: ProcedureMetaDef;
  /**
   * Aggregate selector fragility — set by the auto-teach distiller from
   * the worst per-step selector_tier. `high` if any step uses xpath /
   * nth-child css; `medium` if any step uses text-only matching;
   * `low` otherwise.
   */
  fragility?: ProcedureFragility;
  /**
   * Destructive surfaces this procedure exercises. Empty / missing means
   * the procedure is read-only as far as the distiller could tell. The
   * auto-teach loop refuses to replay a procedure with non-empty
   * side_effects unless dummy inputs cover every destructive input.
   */
  side_effects?: SideEffectClass[];
}

// ---------------------------------------------------------------------------
// JSON-Schema (authoritative — validator uses this directly)
// ---------------------------------------------------------------------------

/** Inline schema for a precondition object. */
const preconditionSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    url_matches: {
      type: "string",
      description: "Regex matched against the current tab URL.",
    },
    fallback: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string" },
        with: { type: "object", additionalProperties: true },
      },
    },
  },
};

/** Inline schema for a success-assertion object. */
const assertionSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    toast_text: { type: "string" },
    url_matches: { type: "string" },
    selector_exists: { type: "string" },
  },
};

/** Inline schema for bridge-managed metadata. */
const metaSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["version", "created"],
  properties: {
    version: { type: "number", minimum: 1 },
    created: { type: "string" },
    last_verified: { type: "string" },
    success_count: { type: "number", minimum: 0 },
    failure_count: { type: "number", minimum: 0 },
    status: { enum: ["draft", "trusted"] as const },
  },
};

/** Inline schema for a do-action item used in on_fail or for-each do arrays. */
const doActionSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string" },
    with: { type: "object", additionalProperties: true },
  },
};

/**
 * Inline schema for an expected_effect object on a step.
 *
 * All fields are optional — a step declares only the assertions it cares
 * about. Sub-objects use additionalProperties:false so typos inside are
 * caught at validation time.
 */
const expectedEffectSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    dom: {
      type: "object",
      additionalProperties: false,
      properties: {
        any: { type: "boolean" },
        added_min: { type: "number", minimum: 0 },
        removed_min: { type: "number", minimum: 0 },
        attr_changes_min: { type: "number", minimum: 0 },
        text_changes_min: { type: "number", minimum: 0 },
      },
    },
    url: {
      type: "object",
      additionalProperties: false,
      properties: {
        changed: { type: "boolean" },
      },
    },
    focus: {
      type: "object",
      additionalProperties: false,
      properties: {
        changed: { type: "boolean" },
      },
    },
    network: {
      type: "object",
      additionalProperties: false,
      properties: {
        requests_started_min: { type: "number", minimum: 0 },
        requests_completed_min: { type: "number", minimum: 0 },
      },
    },
    console_errors_max: { type: "number", minimum: 0 },
  },
};

const SELECTOR_TIERS = ["id", "testid", "role_name", "text", "css", "xpath"] as const;

/** Inline schema for a single step (action or for-each). */
const stepSchema: JSONSchemaObject = {
  type: "object",
  required: ["id"],
  additionalProperties: true,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 80 },
    action: { type: "string" },
    with: { type: "object", additionalProperties: true },
    wait_for: {
      type: "object",
      additionalProperties: false,
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
      },
    },
    bind: { type: "string" },
    on_fail: {
      type: "array",
      items: doActionSchema,
      maxItems: 5,
    },
    for_each: { type: "string" },
    as: { type: "string" },
    do: {
      type: "array",
      items: doActionSchema,
      minItems: 1,
      maxItems: 40,
    },
    expected_effect: {
      ...expectedEffectSchema,
      description:
        "Loose assertions about the page-level effect of this step. " +
        "Emitted by procedures_compile; verified by procedures_execute during replay.",
    },
    selector_tier: {
      enum: SELECTOR_TIERS,
      description:
        "Selector stability tier (most stable first). Written by the " +
        "auto-teach distiller from page_effect element metadata; used by " +
        "future search re-ranking and the auto-teach optimization picker.",
    },
  },
};

/**
 * Authoritative JSON-Schema for procedure YAML documents (schema_version 1).
 *
 * Key constraints:
 *   - `name` must match ^[a-z][a-z0-9_.-]{0,79}$
 *   - `kind: "composite"` requires `uses` (enforced via if/then)
 *   - `steps` 1..40, `uses` ≤20, `inputs` ≤20 properties, `preconditions` ≤5, `tags` ≤10, `triggers` ≤10
 */
export const PROCEDURE_SCHEMA: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "name", "description", "kind", "steps"],
  properties: {
    schema_version: {
      const: 1,
      description: "Schema version; must be 1 for v1 procedures.",
    },
    name: {
      type: "string",
      pattern: "^[a-z][a-z0-9_.-]{0,79}$",
      description:
        "Unique identifier across the whole tree. Dotted prefix (x.y) is domain-scoped.",
    },
    description: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "One-sentence description surfaced in search results.",
    },
    kind: {
      enum: ["leaf", "composite"] as const,
      description:
        "leaf = atomic procedure; composite = orchestrates sub-procedures via uses:.",
    },
    domain: {
      type: "string",
      pattern: "^[a-z][a-z0-9_-]*$",
      maxLength: 40,
      description:
        "Optional domain tag. If name has dotted prefix (x.y), defaults to x at index build time.",
    },
    triggers: {
      type: "array",
      items: { type: "string", maxLength: 80 },
      maxItems: 10,
      description:
        "Author-written phrases in request voice used for semantic search.",
    },
    tags: {
      type: "array",
      items: {
        type: "string",
        pattern: "^[a-z0-9_-]+$",
        maxLength: 24,
      },
      maxItems: 10,
      description: "Short lowercase tokens for faceted filtering.",
    },
    inputs: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: {
            enum: [
              "string",
              "number",
              "boolean",
              "array",
              "object",
            ] as const,
          },
          required: { type: "boolean", default: true },
          description: { type: "string", maxLength: 200 },
          destructive: {
            type: "boolean",
            description:
              "True when this input feeds a destructive surface (sends, " +
              "payments, posts, deletes). Set by the auto-teach " +
              "distiller; the auto-teach loop requires a dummy " +
              "substitute for every destructive input during training.",
          },
        },
      },
      maxProperties: 20,
      description: "Named input parameters accepted by the procedure.",
    },
    preconditions: {
      type: "array",
      items: preconditionSchema,
      maxItems: 5,
      description:
        "Declarative checks evaluated before steps; may trigger a fallback action.",
    },
    uses: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      maxItems: 20,
      description:
        "Required for composite kind. Names of sub-procedures referenced in steps.",
    },
    steps: {
      type: "array",
      items: stepSchema,
      minItems: 1,
      maxItems: 40,
      description: "Ordered list of steps. Each step is an action or for-each.",
    },
    success_criteria: {
      type: "array",
      items: assertionSchema,
      maxItems: 5,
      description: "Optional assertions checked after all steps complete.",
    },
    meta: {
      ...metaSchema,
      description:
        "Bridge-managed metadata. Submitted values are ignored on save.",
    },
    fragility: {
      enum: ["low", "medium", "high"] as const,
      description:
        "Aggregate selector fragility, derived from the worst per-step " +
        "selector_tier across the procedure. Written by the auto-teach " +
        "distiller.",
    },
    side_effects: {
      type: "array",
      items: {
        enum: [
          "send_message",
          "payment",
          "post_public",
          "modify_account",
          "delete",
        ] as const,
      },
      uniqueItems: true,
      maxItems: 5,
      description:
        "Destructive surfaces this procedure exercises. Empty / missing " +
        "means read-only. The auto-teach loop refuses to replay any " +
        "procedure with non-empty side_effects unless every destructive " +
        "input has a dummy substitute supplied for the run.",
    },
  },
  if: {
    properties: { kind: { const: "composite" } },
  },
  then: {
    required: ["uses"],
  },
};

// ---------------------------------------------------------------------------
// Stop words
// ---------------------------------------------------------------------------

/**
 * Fixed English stop-word list for the procedure search tokenizer.
 * Exact tokens from step 4.
 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "of",
  "for",
  "in",
  "on",
  "at",
  "to",
  "from",
  "by",
  "with",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "me",
  "my",
  "you",
  "your",
  "he",
  "his",
  "she",
  "her",
  "it",
  "its",
  "we",
  "our",
  "they",
  "their",
  "them",
  "us",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "where",
  "when",
  "why",
  "how",
  "do",
  "dont",
  "just",
  "so",
  "not",
  "no",
  "yes",
  "maybe",
  "also",
  "please",
  "want",
  "need",
]);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Tokenize a string for procedure search indexing and query matching.
 *
 * Algorithm:
 *   1. Lowercase.
 *   2. Split on /[^a-z0-9]+/ (any non-alphanumeric run is a delimiter).
 *   3. Drop empty tokens and tokens of length ≤1.
 *   4. Drop tokens in STOP_WORDS.
 *   5. Light stemming: strip trailing `s`, `ing`, `ed` if the remaining
 *      token is ≥3 chars. Conservative — one pass, first match wins.
 */
export function tokenize(s: string): string[] {
  const tokens = s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
    .filter((t) => !STOP_WORDS.has(t));

  return tokens.map((t) => {
    // Strip trailing "ing" if remaining ≥3 chars
    if (t.endsWith("ing") && t.length - 3 >= 3) {
      return t.slice(0, -3);
    }
    // Strip trailing "ed" if remaining ≥3 chars
    if (t.endsWith("ed") && t.length - 2 >= 3) {
      return t.slice(0, -2);
    }
    // Strip trailing "s" if remaining ≥3 chars
    if (t.endsWith("s") && t.length - 1 >= 3) {
      return t.slice(0, -1);
    }
    return t;
  });
}
