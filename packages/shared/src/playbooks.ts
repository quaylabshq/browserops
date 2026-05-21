import type { JSONSchemaObject } from "./tools.js";
import type { Locator, RegexLike } from "./locator.js";
import { LOCATOR_SCHEMA } from "./locator.js";

// ---------------------------------------------------------------------------
// TypeScript types
// ---------------------------------------------------------------------------

/** Allowed primitive types for a playbook input field. */
export type PlaybookInputFieldType =
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object";

/** A single input parameter definition (mirrors procedures.InputFieldDef). */
export interface PlaybookInputFieldDef {
  type: PlaybookInputFieldType;
  required?: boolean;
  description?: string;
  /** Marks the input as feeding a destructive surface. */
  destructive?: boolean;
}

/**
 * Side-effect classes a playbook performs. Same enum as procedures so the
 * UI / safety bar / telemetry can share treatment.
 */
export type PlaybookSideEffect =
  | "send_message"
  | "payment"
  | "post_public"
  | "modify_account"
  | "delete";

/**
 * Forbidden block — runtime safety bar. The execute loop refuses any
 * dispatch whose locator matches `locators[]` or whose action name is
 * in `actions[]`, INCLUDING LLM-proposed remediation steps.
 */
export interface PlaybookForbiddenDef {
  locators?: Locator[];
  actions?: string[];
}

/**
 * Retrying predicate evaluated after a step's dispatch.
 * Polled by the execute loop until match or `timeout_ms`.
 */
export interface PlaybookExpectDef {
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
export type PlaybookVerifyDef = PlaybookExpectDef;

/** Fallback strategy declared per step. */
export type PlaybookFallbackStrategy =
  | "strict"
  | "retry"
  | "relocate"
  | "relocate_then_llm"
  | "llm";

export interface PlaybookFallbackDef {
  strategy: PlaybookFallbackStrategy;
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
export interface PlaybookAutoWaitDef {
  timeout_ms?: number;
  poll_interval_ms?: number;
}

/** Step-level `do:` taxonomy. */
export type PlaybookStepAction =
  | "click"
  | "type"
  | "press"
  | "hover"
  | "navigate"
  | "scroll"
  | "wait"
  | "observe"
  | "procedure_call"
  | "playbook_call"
  | "js";

/** A concrete single-action playbook step. */
export interface PlaybookStepDef {
  id: string;
  goal?: string;
  do: PlaybookStepAction;
  locator?: Locator;
  /** Free-form `with:` params for the underlying primitive — substituted before dispatch. */
  with?: Record<string, unknown>;
  auto_wait?: PlaybookAutoWaitDef;
  expect?: PlaybookExpectDef;
  fallback?: PlaybookFallbackDef;
  bind?: string;
}

/** Bridge-managed metadata. Caller-supplied values are ignored on save. */
export interface PlaybookMetaDef {
  version: number;
  created: string;
  last_verified?: string;
  /**
   * draft   = saved but never verified against the live UI; excluded from
   *           playbooks_search by default.
   * trusted = verified at least once via playbooks_save with bump_success.
   */
  status?: "draft" | "trusted";
}

/**
 * Full definition of a playbook YAML document (schema_version 1).
 *
 * Leaf playbooks do NOT require `uses`.
 * Composite playbooks MUST have `uses` (enforced by JSON-Schema if/then).
 */
export interface PlaybookDef {
  schema_version: 1;
  name: string;
  description: string;
  kind: "leaf" | "composite";
  goal?: string;
  domain?: string;
  triggers?: string[];
  tags?: string[];
  side_effects?: PlaybookSideEffect[];
  inputs?: Record<string, PlaybookInputFieldDef>;
  forbidden?: PlaybookForbiddenDef;
  verify?: PlaybookVerifyDef;
  uses?: string[];
  steps: PlaybookStepDef[];
  meta?: PlaybookMetaDef;
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
        "playbook_call",
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

const playbookMetaSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["version", "created"],
  properties: {
    version: { type: "number", minimum: 1 },
    created: { type: "string" },
    last_verified: { type: "string" },
    status: { enum: ["draft", "trusted"] as const },
  },
};

/**
 * Authoritative JSON-Schema for playbook YAML documents (schema_version 1).
 *
 * Key constraints:
 *   - `name` matches ^[a-z][a-z0-9_.-]{0,79}$
 *   - `kind: "composite"` requires `uses` (enforced via if/then)
 *   - `steps` 1..60, `uses` ≤20, `inputs` ≤20 properties, `tags`/`triggers` ≤10
 */
export const PLAYBOOK_SCHEMA: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "name", "description", "kind", "steps"],
  properties: {
    schema_version: {
      const: 1,
      description: "Schema version; must be 1 for v1 playbooks.",
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
    meta: playbookMetaSchema,
  },
  if: { properties: { kind: { const: "composite" } } },
  then: { required: ["uses"] },
};
