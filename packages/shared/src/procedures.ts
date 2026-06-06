import type { JSONSchemaObject } from "./tools.js";
import type { Locator, RegexLike } from "./locator.js";
import { LOCATOR_SCHEMA } from "./locator.js";

/**
 * Procedure schema (v1, unified).
 *
 * One artefact, one runtime. Procedures are deterministic-first browser
 * flows: each step targets an element via a semantic Locator descriptor
 * (re-resolved against the live a11y tree every step), polls a retrying
 * `expect:` predicate, and escalates through an explicit per-step
 * fallback ladder (`strict | retry | relocate | relocate_then_llm | llm`)
 * when reality doesn't match the spec.
 *
 * Safety: the top-level `forbidden{locators, actions}` block is enforced
 * on every dispatch, INCLUDING LLM-proposed `procedures_resume` patches.
 *
 * Storage: ~/browserops/procedures/<dotted-name>/procedure.yaml
 */

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
   * posts, deletes). Author-supplied; the browserops-teach skill uses
   * this to choose safe dummies during verification.
   */
  destructive?: boolean;
}

/**
 * Side-effect classes a procedure performs. Surfaced to the agent so
 * callers can gate execution before running a destructive procedure.
 */
export type SideEffectClass =
  | "send_message"
  | "payment"
  | "post_public"
  | "modify_account"
  | "delete";

/**
 * Forbidden block — runtime safety bar. The execute loop refuses any
 * dispatch whose locator overlaps `locators[]` or whose action name is
 * in `actions[]`. This guard runs on EVERY dispatch, including those
 * originating from an LLM-proposed `procedures_resume` patch.
 */
export interface ForbiddenDef {
  locators?: Locator[];
  actions?: string[];
}

/**
 * Retrying predicate evaluated after a step's dispatch. Polled by the
 * execute loop until match or `timeout_ms`.
 */
export interface ExpectDef {
  url_matches?: RegexLike;
  text_visible?: RegexLike;
  text_invisible?: RegexLike;
  new_dialog?: boolean | RegexLike;
  network_endpoint?: RegexLike;
  network_endpoint_seen?: RegexLike;
  value_contains?: {
    locator?: Locator;
    ref?: number;
    substring: string;
  };
  visual_delta_at_least?: number;
  focus_moved_to?: { locator?: Locator };
  dom_added_min?: number;
  dom_removed_min?: number;
  console_errors_max?: number;
  timeout_ms?: number;
  poll_interval_ms?: number;
}

/** Top-level verify block — same predicate set as expect; evaluated once after last step. */
export type VerifyDef = ExpectDef;

/** Fallback strategy declared per step. */
export type FallbackStrategy =
  | "strict"
  | "retry"
  | "relocate"
  | "relocate_then_llm"
  | "llm";

export interface FallbackDef {
  strategy: FallbackStrategy;
  budget?: {
    tool_calls?: number;
    tokens?: number;
  };
  retry?: {
    attempts?: number;
    backoff_ms?: number;
  };
  relocate?: {
    widen_role?: boolean;
    widen_name?: boolean;
    consider_text?: boolean;
  };
}

/** Auto-wait actionability poll caps. */
export interface AutoWaitDef {
  timeout_ms?: number;
  poll_interval_ms?: number;
}

/**
 * Step-level `do:` taxonomy. `procedure_call` recurses into another saved
 * procedure (the only composition primitive). The rest map to a single
 * browser_* MCP tool; the underlying primitive args go in `with:`.
 */
export type StepAction =
  | "click"
  | "type"
  | "press"
  | "hover"
  | "navigate"
  | "scroll"
  | "wait"
  | "observe"
  | "procedure_call"
  | "js";

/** A concrete single-action procedure step. */
export interface StepDef {
  id: string;
  goal?: string;
  do: StepAction;
  /**
   * Locator descriptor — required for click/type/press/hover.
   * Optional for navigate/scroll/wait/observe/js/procedure_call where
   * the action doesn't address an element.
   */
  locator?: Locator;
  /** Free-form `with:` params for the underlying primitive — substituted before dispatch. */
  with?: Record<string, unknown>;
  auto_wait?: AutoWaitDef;
  expect?: ExpectDef;
  fallback?: FallbackDef;
  bind?: string;
}

/**
 * Per-step locator drift health record. Maintained by the execute loop on
 * every successful resolution. The auto-demote check on save reads
 * `relocates / runs`, `ambiguous_resolves / runs`, and `target_changed`
 * to decide whether a trusted procedure should be demoted to draft.
 */
export interface StepHealth {
  /** Total resolution attempts for this step across all runs. */
  runs: number;
  /** How many times the original locator missed and relocate kicked in. */
  relocates: number;
  /** Resolutions where the locator matched >1 element and we picked the first. */
  ambiguous_resolves: number;
  /** Times the locator resolved to a DIFFERENT ref than the previously recorded target. */
  target_changed: number;
  /** Rolling average match-count from browser_locate. */
  avg_match_count?: number;
  /** Stability tier of the most recent successful descriptor (1/2/3). */
  last_tier?: 1 | 2 | 3;
  /** ref the locator resolved to most recently (used to detect changes). */
  last_ref?: number;
}

/** meta.health — top-level health block keyed by step id. */
export interface HealthDef {
  updated: string;
  steps: Record<string, StepHealth>;
}

/** Bridge-managed metadata. Caller-supplied values are ignored on save. */
export interface ProcedureMetaDef {
  version: number;
  created: string;
  last_verified?: string;
  /**
   * draft   = saved but never verified against the live UI; excluded from
   *           procedures_search by default.
   * trusted = verified at least once via procedures_save with bump_success.
   */
  status?: "draft" | "trusted";
  /** Per-step locator-drift health, used by the auto-demote check on save. */
  health?: HealthDef;
}

/**
 * Full definition of a procedure YAML document (schema_version 1).
 *
 * Leaf procedures do NOT require `uses`.
 * Composite procedures MUST have `uses` (enforced by JSON-Schema if/then).
 */
export interface ProcedureDef {
  schema_version: 1;
  name: string;
  description: string;
  kind: "leaf" | "composite";
  goal?: string;
  domain?: string;
  triggers?: string[];
  tags?: string[];
  side_effects?: SideEffectClass[];
  inputs?: Record<string, InputFieldDef>;
  forbidden?: ForbiddenDef;
  verify?: VerifyDef;
  uses?: string[];
  steps: StepDef[];
  meta?: ProcedureMetaDef;
}

// ---------------------------------------------------------------------------
// JSON-Schema (authoritative — validator uses this directly)
// ---------------------------------------------------------------------------

const expectSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    url_matches: { type: "string", maxLength: 400 },
    text_visible: { type: "string", maxLength: 400 },
    text_invisible: { type: "string", maxLength: 400 },
    new_dialog: {
      oneOf: [{ type: "boolean" }, { type: "string", maxLength: 200 }],
    },
    network_endpoint: { type: "string", maxLength: 400 },
    network_endpoint_seen: { type: "string", maxLength: 400 },
    value_contains: {
      type: "object",
      additionalProperties: false,
      required: ["substring"],
      properties: {
        locator: LOCATOR_SCHEMA as JSONSchemaObject,
        ref: { type: "integer", minimum: 1 },
        substring: { type: "string", maxLength: 400 },
      },
    },
    visual_delta_at_least: { type: "number", minimum: 0, maximum: 1 },
    focus_moved_to: {
      type: "object",
      additionalProperties: false,
      properties: { locator: LOCATOR_SCHEMA as JSONSchemaObject },
    },
    dom_added_min: { type: "integer", minimum: 0 },
    dom_removed_min: { type: "integer", minimum: 0 },
    console_errors_max: { type: "integer", minimum: 0 },
    timeout_ms: { type: "integer", minimum: 0, maximum: 60000 },
    poll_interval_ms: { type: "integer", minimum: 50, maximum: 5000 },
  },
};

const fallbackSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["strategy"],
  properties: {
    strategy: {
      enum: ["strict", "retry", "relocate", "relocate_then_llm", "llm"] as const,
    },
    budget: {
      type: "object",
      additionalProperties: false,
      properties: {
        tool_calls: { type: "integer", minimum: 0, maximum: 50 },
        tokens: { type: "integer", minimum: 0, maximum: 50000 },
      },
    },
    retry: {
      type: "object",
      additionalProperties: false,
      properties: {
        attempts: { type: "integer", minimum: 1, maximum: 10 },
        backoff_ms: { type: "integer", minimum: 0, maximum: 30000 },
      },
    },
    relocate: {
      type: "object",
      additionalProperties: false,
      properties: {
        widen_role: { type: "boolean" },
        widen_name: { type: "boolean" },
        consider_text: { type: "boolean" },
      },
    },
  },
};

const autoWaitSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    timeout_ms: { type: "integer", minimum: 0, maximum: 60000 },
    poll_interval_ms: { type: "integer", minimum: 50, maximum: 5000 },
  },
};

const forbiddenSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    locators: {
      type: "array",
      items: LOCATOR_SCHEMA as JSONSchemaObject,
      maxItems: 20,
    },
    actions: {
      type: "array",
      items: { type: "string", maxLength: 80 },
      maxItems: 20,
      uniqueItems: true,
    },
  },
};

const stepSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "do"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 80 },
    goal: { type: "string", minLength: 1, maxLength: 200 },
    do: {
      enum: [
        "click",
        "type",
        "press",
        "hover",
        "navigate",
        "scroll",
        "wait",
        "observe",
        "procedure_call",
        "js",
      ] as const,
    },
    locator: LOCATOR_SCHEMA as JSONSchemaObject,
    with: { type: "object", additionalProperties: true },
    auto_wait: autoWaitSchema,
    expect: expectSchema,
    fallback: fallbackSchema,
    bind: { type: "string", minLength: 1, maxLength: 80 },
  },
};

const stepHealthSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["runs", "relocates", "ambiguous_resolves", "target_changed"],
  properties: {
    runs: { type: "integer", minimum: 0 },
    relocates: { type: "integer", minimum: 0 },
    ambiguous_resolves: { type: "integer", minimum: 0 },
    target_changed: { type: "integer", minimum: 0 },
    avg_match_count: { type: "number", minimum: 0 },
    last_tier: { enum: [1, 2, 3] as const },
    last_ref: { type: "integer", minimum: 1 },
  },
};

const healthSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["updated", "steps"],
  properties: {
    updated: { type: "string" },
    steps: {
      type: "object",
      additionalProperties: stepHealthSchema,
      maxProperties: 60,
    },
  },
};

const procedureMetaSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["version", "created"],
  properties: {
    version: { type: "number", minimum: 1 },
    created: { type: "string" },
    last_verified: { type: "string" },
    status: { enum: ["draft", "trusted"] as const },
    health: healthSchema,
  },
};

/**
 * Authoritative JSON-Schema for procedure YAML documents (schema_version 1).
 *
 * Key constraints:
 *   - `name` matches ^[a-z][a-z0-9_.-]{0,79}$
 *   - `kind: "composite"` requires `uses` (enforced via if/then)
 *   - `steps` 1..60, `uses` ≤20, `inputs` ≤20 properties, `tags`/`triggers` ≤10
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
    },
    description: { type: "string", minLength: 1, maxLength: 200 },
    kind: { enum: ["leaf", "composite"] as const },
    goal: { type: "string", maxLength: 200 },
    domain: { type: "string", pattern: "^[a-z][a-z0-9_-]*$", maxLength: 40 },
    triggers: {
      type: "array",
      items: { type: "string", maxLength: 80 },
      maxItems: 10,
    },
    tags: {
      type: "array",
      items: { type: "string", pattern: "^[a-z0-9_-]+$", maxLength: 24 },
      maxItems: 10,
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
    },
    inputs: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: {
            enum: ["string", "number", "boolean", "array", "object"] as const,
          },
          required: { type: "boolean", default: true },
          description: { type: "string", maxLength: 200 },
          destructive: { type: "boolean" },
        },
      },
      maxProperties: 20,
    },
    forbidden: forbiddenSchema,
    verify: expectSchema,
    uses: {
      type: "array",
      items: { type: "string" },
      uniqueItems: true,
      maxItems: 20,
    },
    steps: {
      type: "array",
      items: stepSchema,
      minItems: 1,
      maxItems: 60,
    },
    meta: procedureMetaSchema,
  },
  if: { properties: { kind: { const: "composite" } } },
  then: { required: ["uses"] },
};

// ---------------------------------------------------------------------------
// Search tokenizer
// ---------------------------------------------------------------------------

/** Fixed English stop-word list for the procedure search tokenizer. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else",
  "of", "for", "in", "on", "at", "to", "from", "by", "with",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "has", "have", "had", "do", "does", "did",
  "me", "my", "you", "your", "he", "his", "she", "her",
  "it", "its", "we", "our", "they", "their", "them", "us",
  "this", "that", "these", "those",
  "what", "which", "who", "whom", "where", "when", "why", "how",
  "dont", "just", "so", "not", "no", "yes", "maybe", "also",
  "please", "want", "need",
]);

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
    if (t.endsWith("ing") && t.length - 3 >= 3) return t.slice(0, -3);
    if (t.endsWith("ed") && t.length - 2 >= 3) return t.slice(0, -2);
    if (t.endsWith("s") && t.length - 1 >= 3) return t.slice(0, -1);
    return t;
  });
}
