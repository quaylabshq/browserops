import type { ErrorCode } from "./errors.js";
import type { FeatureName } from "./features.js";

/**
 * Minimal structural representation of a JSON Schema draft 2020-12 object
 * sufficient for describing v1 browser_* tool params and results.
 */
export type JSONSchemaObject = {
  type?: string | string[];
  properties?: Record<string, JSONSchemaObject>;
  required?: readonly string[];
  additionalProperties?: boolean | JSONSchemaObject;
  enum?: readonly unknown[];
  items?: JSONSchemaObject;
  oneOf?: readonly JSONSchemaObject[];
  anyOf?: readonly JSONSchemaObject[];
  const?: unknown;
  $ref?: string;
  $defs?: Record<string, JSONSchemaObject>;
  if?: JSONSchemaObject;
  then?: JSONSchemaObject;
  else?: JSONSchemaObject;
  not?: JSONSchemaObject;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
  default?: unknown;
  format?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  contentEncoding?: string;
};

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchemaObject;
  outputSchema: JSONSchemaObject;
  action_weight: 0 | 0.5 | 1;
  risky: "always" | "conditional" | "never";
  errorCodes: readonly ErrorCode[];
  /**
   * Optional feature gate. When set, the tool is hidden from tools/list and
   * tools/call returns FEATURE_DISABLED unless the feature is enabled in
   * the bridge config. Untagged tools are core and always-on.
   */
  feature?: FeatureName;
}

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const tabIdSchema: JSONSchemaObject = {
  type: "string",
  pattern: "^t_[0-9a-z]+$",
} as const;

const refSchema: JSONSchemaObject = {
  type: "integer",
  minimum: 1,
} as const;

const urlSchema: JSONSchemaObject = {
  type: "string",
  format: "uri",
  maxLength: 4096,
} as const;

const modifiersSchema: JSONSchemaObject = {
  type: "array",
  items: {
    type: "string",
    enum: ["Control", "Alt", "Shift", "Meta", "Primary"] as const,
    description:
      "Modifier key. `Primary` is a logical alias that the extension resolves at dispatch time to `Meta` on macOS or `Control` elsewhere — use it for portable chords like Primary+A (select all) or Primary+Z (undo).",
  },
  uniqueItems: true,
  maxItems: 4,
  default: [],
} as const;

const tabSummarySchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["tab_id", "url", "title", "active"] as const,
  properties: {
    tab_id: tabIdSchema,
    url: { type: "string" },
    title: { type: "string" },
    active: { type: "boolean" },
    window_id: { type: "integer" },
    index: { type: "integer", minimum: 0 },
  },
} as const;

// ---------------------------------------------------------------------------
// Shared page_effect schema fragment (returned by the four mutating tools
// when observe_effects is true / not suppressed).
// ---------------------------------------------------------------------------

// page_effect envelope produced by captureEffect — a structural delta
// covering the action window. ~100 tokens; lets the agent skip a re-read
// after most mutating actions.
const effectSchema: JSONSchemaObject = {
  type: "object",
  description:
    "Structural delta captured around every state-changing action: " +
    "mutations, network, visual hash diff, focus, new dialogs, a11y diff, " +
    "console errors. Returned alongside `page_effect` for forward " +
    "compatibility with the observation architecture.",
  properties: {
    url_changed: { type: "boolean" },
    title_changed: { type: "boolean" },
    mutations: {
      type: "object",
      properties: {
        added: { type: "integer", minimum: 0 },
        removed: { type: "integer", minimum: 0 },
        attr: { type: "integer", minimum: 0 },
        char: { type: "integer", minimum: 0 },
      },
      required: ["added", "removed", "attr", "char"] as const,
      additionalProperties: false,
    },
    network: {
      type: "object",
      properties: {
        requests: { type: "integer", minimum: 0 },
        failed: { type: "integer", minimum: 0 },
        endpoints: { type: "array", items: { type: "string" } },
      },
      required: ["requests", "failed", "endpoints"] as const,
      additionalProperties: false,
    },
    visual_hash_delta: { type: "number", minimum: 0, maximum: 1 },
    a11y_delta: {
      type: "object",
      properties: {
        added: { type: "integer", minimum: 0 },
        removed: { type: "integer", minimum: 0 },
        changed: { type: "integer", minimum: 0 },
      },
      required: ["added", "removed", "changed"] as const,
      additionalProperties: false,
    },
    focus_moved_to: { type: ["string", "null"] },
    new_dialogs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          role: { type: "string" },
          name: { type: "string" },
          ref: { type: "string" },
        },
        required: ["role", "name", "ref"] as const,
        additionalProperties: false,
      },
    },
    console_errors: { type: "integer", minimum: 0 },
    duration_ms: { type: "integer", minimum: 0 },
  },
  required: [
    "url_changed",
    "title_changed",
    "mutations",
    "network",
    "visual_hash_delta",
    "a11y_delta",
    "focus_moved_to",
    "new_dialogs",
    "console_errors",
    "duration_ms",
  ] as const,
  additionalProperties: false,
} as const;

const pageEffectSchema: JSONSchemaObject = {
  type: "object",
  description:
    "Measurable changes observed on the page in ~300ms after dispatch. " +
    "Omitted when observe_effects is false.",
  properties: {
    dom: {
      type: "object",
      properties: {
        added: { type: "integer", minimum: 0 },
        removed: { type: "integer", minimum: 0 },
        attr_changes: { type: "integer", minimum: 0 },
        text_changes: { type: "integer", minimum: 0 },
      },
      required: ["added", "removed", "attr_changes", "text_changes"] as const,
      additionalProperties: false,
    },
    url: {
      type: "object",
      properties: {
        changed: { type: "boolean" },
        before: { type: "string" },
        after: { type: "string" },
      },
      required: ["changed"] as const,
      additionalProperties: false,
    },
    focus: {
      type: "object",
      properties: {
        changed: { type: "boolean" },
        before_selector: { type: ["string", "null"] },
        after_selector: { type: ["string", "null"] },
      },
      required: ["changed"] as const,
      additionalProperties: false,
    },
    network: {
      type: "object",
      properties: {
        requests_started: { type: "integer", minimum: 0 },
        requests_completed: { type: "integer", minimum: 0 },
        in_flight_at_end: { type: "integer", minimum: 0 },
      },
      required: ["requests_started", "requests_completed", "in_flight_at_end"] as const,
      additionalProperties: false,
    },
    console_errors: { type: "integer", minimum: 0 },
    window_ms: { type: "integer", minimum: 0 },
    truncated: { type: "boolean" },
  },
  required: ["dom", "url", "focus", "network", "console_errors", "window_ms"] as const,
  additionalProperties: true, // forward-compat for Phase 2+
} as const;

const actionExpectationSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  description:
    "Predicate the agent expects to hold after the action. The handler polls the page until it matches or `timeout_ms` elapses, then returns `expectation_met` and (if false) `mismatch_reason`. Soft signal — never throws.",
  properties: {
    url_matches: { type: "string", description: "Regex matched against window.location.href." },
    new_dialog: {
      oneOf: [{ type: "boolean" }, { type: "string" }],
      description:
        "true requires any dialog to appear; a string is a regex against the dialog's accessible name.",
    },
    value_contains: {
      type: "object",
      additionalProperties: false,
      required: ["ref", "substring"] as const,
      properties: {
        ref: { type: "string" },
        substring: { type: "string" },
      },
    },
    mutations_at_least: { type: "integer", minimum: 0 },
    network_endpoint: { type: "string", description: "Regex matched against any captured endpoint." },
    focus_to: { type: "string", description: "CSS selector / ref expected to hold focus." },
    visual_delta_at_least: { type: "number", minimum: 0, maximum: 1 },
    title_matches: { type: "string" },
    timeout_ms: { type: "integer", minimum: 100, maximum: 30000, default: 3000 },
    poll_interval_ms: { type: "integer", minimum: 50, maximum: 5000, default: 100 },
  },
} as const;

const expectationOutputSchema = {
  expectation_met: { type: "boolean" } as const,
  mismatch_reason: { type: "string" } as const,
};

const observeEffectsInputSchema: JSONSchemaObject = {
  type: "boolean",
  default: true,
  description:
    "Observe page effects (DOM mutations, URL change, focus change, " +
    "network activity) in a short window after dispatch and return them " +
    "as page_effect. Set to false to skip observation for zero overhead.",
} as const;

const expectEffectInputSchema: JSONSchemaObject = {
  type: "string",
  enum: ["any", "dom", "navigation", "none"],
  description:
    "Assert what kind of effect should occur. 'any' = any non-zero " +
    "effect; 'dom' = DOM mutations required; 'navigation' = URL change " +
    "required; 'none' = no effect should occur. Mismatch adds a warning " +
    "to the response but does not throw.",
} as const;

const warningsOutputSchema: JSONSchemaObject = {
  type: "array",
  items: { type: "string" },
  description:
    "Human-readable mismatch descriptions when observed effect does not " +
    "match expect_effect. Omitted when there are no warnings.",
} as const;

// ---------------------------------------------------------------------------
// Error-code bundles
// ---------------------------------------------------------------------------

const BASE_CODES = ["TIMEOUT", "INTERNAL", "INVALID_PARAMS"] as const satisfies readonly ErrorCode[];
const TAB_CODES = ["TAB_NOT_FOUND"] as const satisfies readonly ErrorCode[];
const REF_CODES = [
  "REF_STALE",
  "REF_NOT_FOUND",
  "FRAME_UNREACHABLE",
  "CDP_ATTACH_FAILED",
] as const satisfies readonly ErrorCode[];
const MUTATING_CODES = ["RATE_LIMITED"] as const satisfies readonly ErrorCode[];
const RISKY_CODES = ["RISKY_ACTION_DENIED"] as const satisfies readonly ErrorCode[];
const PROCEDURE_CODES = [
  "PROCEDURE_NOT_FOUND",
  "PROCEDURE_ALREADY_EXISTS",
  "PROCEDURE_SCHEMA_INVALID",
  "PROCEDURE_IN_USE",
  "PROCEDURE_OWNER_INVALID",
  "PROCEDURE_RESUME_EXPIRED",
  "PROCEDURE_RESUME_INVALID",
  "PROCEDURE_BUDGET_EXCEEDED",
  "PROCEDURE_FORBIDDEN",
] as const satisfies readonly ErrorCode[];
const MEMORY_CODES = [
  "MEMORY_NOT_FOUND",
  "MEMORY_ALREADY_EXISTS",
  "MEMORY_SCHEMA_INVALID",
] as const satisfies readonly ErrorCode[];

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const listTabs: ToolDef = {
  name: "browser_list_tabs",
  description: "List all open tabs in the user's Chrome profile visible to the extension.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tabs"] as const,
    properties: {
      tabs: {
        type: "array",
        items: tabSummarySchema,
      },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES] as const,
} as const;

const currentTab: ToolDef = {
  name: "browser_current_tab",
  description: "Return the currently active tab in the focused window.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "url", "title", "active"] as const,
    properties: {
      tab_id: { type: "string" },
      url: { type: "string" },
      title: { type: "string" },
      active: { const: true },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...TAB_CODES] as const,
} as const;

const newTab: ToolDef = {
  name: "browser_new_tab",
  description: "Open a new tab, optionally at a URL, optionally making it active.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      url: urlSchema,
      active: { type: "boolean", default: true },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
      url: { type: "string" },
    },
  },
  action_weight: 1,
  risky: "never",
  errorCodes: [...BASE_CODES, ...MUTATING_CODES] as const,
} as const;

const closeTab: ToolDef = {
  name: "browser_close_tab",
  description: "Close a tab.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["closed"] as const,
    properties: {
      closed: { const: true },
    },
  },
  action_weight: 1,
  risky: "never",
  errorCodes: [...BASE_CODES, ...TAB_CODES, ...MUTATING_CODES] as const,
} as const;

const switchTab: ToolDef = {
  name: "browser_switch_tab",
  description: "Make the given tab active and focus its window.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "active"] as const,
    properties: {
      tab_id: { type: "string" },
      active: { const: true },
    },
  },
  action_weight: 0.5,
  risky: "never",
  errorCodes: [...BASE_CODES, ...TAB_CODES] as const,
} as const;

const navigate: ToolDef = {
  name: "browser_navigate",
  description: "Point the tab at a URL and optionally wait for page load. Returns `page_effect` when observe_effects is on, `warnings?` when expect_effect mismatches, and an `effect` page_effect envelope (mutations, network, visual hash diff, focus, new dialogs, a11y diff, console errors) for the action window.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "url"] as const,
    properties: {
      tab_id: tabIdSchema,
      url: urlSchema,
      wait_for_load: { type: "boolean", default: true },
      observe_effects: observeEffectsInputSchema,
      expect_effect: expectEffectInputSchema,
      expected: actionExpectationSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["final_url"] as const,
    properties: {
      final_url: { type: "string" },
      page_effect: pageEffectSchema,
      effect: effectSchema,
      ...expectationOutputSchema,
      warnings: warningsOutputSchema,
    },
  },
  action_weight: 1,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...MUTATING_CODES,
    "NAVIGATION_IN_PROGRESS",
    "CDP_ATTACH_FAILED",
  ] as const,
} as const;

const back: ToolDef = {
  name: "browser_back",
  description:
    "Go back one step in the tab's history. Response includes a `page_effect` envelope describing what changed during the action window.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["final_url"] as const,
    properties: {
      final_url: { type: "string" },
      effect: effectSchema,
    },
  },
  action_weight: 1,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...MUTATING_CODES,
    "NAVIGATION_IN_PROGRESS",
  ] as const,
} as const;

const forward: ToolDef = {
  name: "browser_forward",
  description:
    "Go forward one step in the tab's history. Response includes a `page_effect` envelope describing what changed during the action window.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["final_url"] as const,
    properties: {
      final_url: { type: "string" },
      effect: effectSchema,
    },
  },
  action_weight: 1,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...MUTATING_CODES,
    "NAVIGATION_IN_PROGRESS",
  ] as const,
} as const;

const reload: ToolDef = {
  name: "browser_reload",
  description:
    "Reload the current page. Response includes a `page_effect` envelope describing what changed during the action window.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
      bypass_cache: { type: "boolean", default: false },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["final_url"] as const,
    properties: {
      final_url: { type: "string" },
      effect: effectSchema,
    },
  },
  action_weight: 1,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...MUTATING_CODES,
    "NAVIGATION_IN_PROGRESS",
  ] as const,
} as const;

const screenshot: ToolDef = {
  name: "browser_screenshot",
  description:
    "Capture a JPEG (default) or PNG of the tab and return it base64-encoded. " +
    "Prefer the `intent` parameter over raw quality/dimension knobs: " +
    "'glance' (20% q, 512px — layout check), 'verify' (50% q, 1024px — default), " +
    "'read_text' (95% q, 2048px — read labels/errors), 'user_requested' (full quality, no downscale). " +
    "Explicit quality/max_dimension/full_quality values override intent defaults.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
      intent: {
        enum: ["glance", "verify", "read_text", "user_requested"] as const,
        description:
          "Quality preset. 'glance' for layout checks, 'verify' for state verification (default behavior), " +
          "'read_text' when you need to read text/labels/errors, 'user_requested' when the user explicitly asked " +
          "for a screenshot. Explicit quality/max_dimension/full_quality values override the preset.",
      },
      full_page: { type: "boolean", default: false },
      format: { enum: ["png", "jpeg"] as const, default: "jpeg" },
      quality: { type: "integer", minimum: 0, maximum: 100 },
      max_dimension: { type: "integer", minimum: 1, maximum: 8192 },
      full_quality: { type: "boolean" },
      dimensions: {
        type: "object",
        additionalProperties: false,
        description:
          "Action-grade dimensions hint. `longest_edge` (default 768) caps the longer image side; the other axis preserves aspect ratio. Wins over `max_dimension` when both are set.",
        properties: {
          longest_edge: { type: "integer", minimum: 1, maximum: 8192 },
        },
      },
      region: {
        type: "object",
        additionalProperties: false,
        description:
          "Crop to {x, y, w, h} in CSS pixels (relative to the viewport) before resizing to the target dimensions. Useful for focusing the agent on a specific UI region without paying for the full viewport.",
        required: ["x", "y", "w", "h"] as const,
        properties: {
          x: { type: "number", minimum: 0 },
          y: { type: "number", minimum: 0 },
          w: { type: "number", minimum: 0 },
          h: { type: "number", minimum: 0 },
        },
      },
      annotate: {
        description:
          "Overlay annotations. 'som' adds Set-of-Marks numbered labels on interactive elements and returns `som_map` mapping label → {ref, role, name}. 'none' (default) leaves the screenshot un-annotated.",
        enum: ["som", "none"] as const,
        default: "none",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["image_base64", "width", "height", "format"] as const,
    properties: {
      image_base64: { type: "string", contentEncoding: "base64" },
      width: { type: "integer", minimum: 1 },
      height: { type: "integer", minimum: 1 },
      format: { enum: ["png", "jpeg"] as const },
      observation_token: { type: "string" },
      css_pixel_dims: {
        type: "object",
        additionalProperties: false,
        required: ["w", "h"] as const,
        properties: { w: { type: "number" }, h: { type: "number" } },
      },
      screenshot_dims: {
        type: "object",
        additionalProperties: false,
        required: ["w", "h"] as const,
        properties: { w: { type: "number" }, h: { type: "number" } },
      },
      scale: { type: "number" },
      scroll: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y"] as const,
        properties: { x: { type: "number" }, y: { type: "number" } },
      },
      dpr: { type: "number" },
      representation: { enum: ["screenshot", "screenshot_som"] as const },
      som_map: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["ref"] as const,
          properties: {
            ref: { type: "string" },
            role: { type: "string" },
            name: { type: "string" },
          },
        },
      },
    },
  },
  action_weight: 0.5,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    "CDP_ATTACH_FAILED",
  ] as const,
} as const;

const read: ToolDef = {
  name: "browser_read",
  description:
    "Read structured page content in one of four modes (a11y_tree, markdown, sanitized_html, text). a11y_tree is the canonical source of refs. By default a11y_tree returns a compact tree dropping role='generic' / name-less nodes; pass verbose:true for the legacy full tree. " +
    "Prefer browser_quick_read when you only need to find a specific element by name or label — it is much cheaper and returns only matching refs.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "mode"] as const,
    properties: {
      tab_id: tabIdSchema,
      mode: { enum: ["a11y_tree", "markdown", "sanitized_html", "text"] as const },
      max_length: { type: "integer", minimum: 1024, maximum: 1048576, default: 131072 },
      viewport_only: { type: "boolean", default: false },
      augment: {
        type: "boolean",
        default: true,
        description:
          "When true (default), each ref in the response carries visual fields (bounds, visible, in_viewport, occluded_by, bg/fg colors, opacity, disabled_visual, display, flex_direction) sourced from a one-shot DOM lookup. Set false to skip the augmentation cost when only structural data is needed.",
      },
      scope: {
        description:
          "Restrict the read to a slice of the page. 'viewport' (default) filters a11y nodes to those intersecting the viewport rect — cheaper than reading the whole document on long pages. 'document' is the legacy full-page scope. 'ref:<id>' filters to the subtree rooted at the named ref.",
        type: "string",
        pattern: "^(viewport|document|ref:.+)$",
        default: "viewport",
      },
      verbose: { type: "boolean", default: false },
      selector: { type: "string", minLength: 1, maxLength: 1024 },
      start: { type: "integer", minimum: 0, default: 0 },
      length: { type: "integer", minimum: 1024, maximum: 1048576, default: 131072 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["content", "url", "title", "mode"] as const,
    properties: {
      content: { type: "string" },
      mode: { enum: ["a11y_tree", "markdown", "sanitized_html", "text"] as const },
      url: { type: "string" },
      title: { type: "string" },
      truncated: { type: "boolean", default: false },
      total_length: { type: "integer", minimum: 0 },
      next_start: { type: ["integer", "null"], minimum: 0 },
      matched_selector: { type: "boolean" },
      start: { type: "integer", minimum: 0 },
      length: { type: "integer", minimum: 0 },
      refs: {
        description:
          "Map from ref integer (as string key) to a minimal element summary. Populated only when mode == 'a11y_tree'. Each entry carries augmented visual fields (bounds, visible, etc.) when augment != false.",
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["role"] as const,
          properties: {
            role: { type: "string" },
            name: { type: "string" },
            value: { type: "string" },
            tag: { type: "string" },
            input_type: { type: "string" },
            bounds: {
              type: ["object", "null"],
              additionalProperties: false,
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
              },
            },
            visible: { type: "boolean" },
            in_viewport: { type: "boolean" },
            occluded_by: { type: ["string", "null"] },
            bg_color: { type: ["string", "null"] },
            fg_color: { type: ["string", "null"] },
            opacity: { type: "number" },
            disabled_visual: { type: "boolean" },
            display: { type: "string" },
            flex_direction: { type: "string" },
          },
        },
      },
    },
    if: { properties: { mode: { const: "a11y_tree" } } },
    then: { required: ["refs"] as const },
    else: {
      properties: {
        refs: {
          type: "object",
          maxProperties: 0,
          description: "Must be absent or empty when mode != 'a11y_tree'.",
        },
      },
    },
  },
  action_weight: 0.5,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...REF_CODES,
    ...MUTATING_CODES,
    "NAVIGATION_IN_PROGRESS",
  ] as const,
} as const;

const quickRead: ToolDef = {
  name: "browser_quick_read",
  description:
    "Fast, targeted search of the a11y tree for elements matching a text query. Returns only matching refs — much cheaper than browser_read. " +
    "Prefer this over browser_read when you need to find a specific element by name or label instead of reading the full page. " +
    "The query matches against accessible names (case-insensitive substring). " +
    "Note: replaces the current ref snapshot for the tab; refs from a prior browser_read become stale.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "query"] as const,
    properties: {
      tab_id: tabIdSchema,
      query: { type: "string", minLength: 1, maxLength: 200 },
      role: {
        type: "string",
        maxLength: 32,
        description: "Filter results to elements with this ARIA role (e.g. 'button', 'textbox', 'link').",
      },
      viewport_only: { type: "boolean", default: false },
      scope: {
        description:
          "Restrict the search to a slice of the page. 'viewport' (default) is faster than the legacy full-document walk on long pages. 'document' is the legacy full-page scope. 'ref:<id>' filters to the subtree rooted at the named ref.",
        type: "string",
        pattern: "^(viewport|document|ref:.+)$",
        default: "viewport",
      },
      augment: {
        type: "boolean",
        default: true,
        description:
          "When true (default), each match carries visual fields (visible, in_viewport, occluded_by, bg/fg colors, opacity, disabled_visual, display, flex_direction) sourced from a one-shot DOM lookup. Set false to skip the augmentation cost when only structural data is needed.",
      },
      only_enabled: {
        type: "boolean",
        default: false,
        description: "Filter to matches that are not `disabled_visual` (greyed out, pointer-events:none, etc.).",
      },
      only_visible: {
        type: "boolean",
        default: false,
        description: "Filter to matches whose computed visibility is true (display !== none, visibility !== hidden, opacity > 0.01).",
      },
      only_in_viewport: {
        type: "boolean",
        default: false,
        description: "Filter to matches whose bounding box intersects the viewport.",
      },
      within_region: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y", "w", "h"] as const,
        description: "Filter to matches whose bounding box intersects this CSS-pixel region (relative to the viewport).",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          w: { type: "number" },
          h: { type: "number" },
        },
      },
      near: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "radius_px"] as const,
        description:
          "Filter to matches whose bounding-box center is within `radius_px` CSS pixels of the named ref's center.",
        properties: {
          ref: { type: "string" },
          radius_px: { type: "number", minimum: 0 },
        },
      },
      best_match: {
        type: "boolean",
        default: false,
        description:
          "When true, return only the highest-confidence single match in `match` (not `matches`). Confidence is exact > prefix > substring with smaller-bounds tiebreaker.",
      },
      max_results: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["total", "query"] as const,
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["ref", "role", "name"] as const,
          properties: {
            ref: refSchema,
            selector: { type: "string" },
            role: { type: "string" },
            name: { type: "string" },
            attrs: { type: "object", additionalProperties: { type: "string" } },
            rect: {
              type: "object",
              additionalProperties: false,
              required: ["x", "y", "width", "height"] as const,
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
              },
            },
          },
        },
      },
      match: {
        description: "Set when best_match: true. The single highest-confidence match (or null when no matches found).",
        type: ["object", "null"],
        additionalProperties: true,
      },
      total: { type: "integer", minimum: 0 },
      query: { type: "string" },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...TAB_CODES] as const,
} as const;

const click: ToolDef = {
  name: "browser_click",
  description:
    "Click an element identified by ref. Fires pointer/mouse events on the element. Returns `{clicked, page_effect?, effect, warnings?}` — `effect` is the page_effect envelope (mutations, network, visual hash diff, focus, new dialogs, a11y diff, console errors).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "ref"] as const,
    properties: {
      tab_id: tabIdSchema,
      ref: refSchema,
      button: { enum: ["left", "middle", "right"] as const, default: "left" },
      click_count: { type: "integer", minimum: 1, maximum: 3, default: 1 },
      modifiers: modifiersSchema,
      overlay: {
        description:
          "How to handle the case where the click is occluded by an overlay (modal, scrim, consent banner). 'none' (default) reports occluded:true and a suggestion. 'simple' tries ESC + close-button hunt and retries the click once. 'smart' classifies the occluder (dialog/banner/toast/consent) and tries multiple strategies (ESC, close-button hunt up to 5 ancestor levels, backdrop click); reports which strategy worked.",
        enum: ["none", "simple", "smart"] as const,
        default: "none",
      },
      observe_effects: observeEffectsInputSchema,
      expect_effect: expectEffectInputSchema,
      expected: actionExpectationSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["clicked"] as const,
    properties: {
      clicked: { const: true },
      navigated: { type: "boolean" },
      ...expectationOutputSchema,
      // Set when overlay:'simple'|'smart' was on and the initial click was
      // occluded; indicates the overlay was dismissed and the click retried.
      dismissed_overlay: { type: "boolean" },
      // Present when the click coordinate hit-tested to a different element
      // (overlay, modal scrim, etc.). Caller should consider re-reading and
      // dismissing the overlay before retrying.
      occluded: { type: "boolean" },
      occluder: {
        type: "object",
        additionalProperties: false,
        properties: {
          tag: { type: "string" },
          text: { type: "string" },
          role: { type: ["string", "null"] },
        },
      },
      suggestion: {
        type: "string",
        description:
          "Actionable suggestion when click is occluded — e.g. which overlay to dismiss, " +
          "or a specific close-button ref to try.",
      },
      // True when the selector landed on a non-interactive descendant and
      // we walked up to the nearest interactive ancestor to dispatch on.
      retargeted: { type: "boolean" },
      page_effect: pageEffectSchema,
      effect: effectSchema,
      warnings: warningsOutputSchema,
    },
  },
  action_weight: 1,
  risky: "conditional",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...REF_CODES,
    ...MUTATING_CODES,
    ...RISKY_CODES,
  ] as const,
} as const;

const clickAt: ToolDef = {
  name: "browser_click_at",
  description:
    "Click at viewport coordinates (x, y) — no ref required. Escape hatch for canvas, maps, games, and anything the a11y walker can't address. With `coord_space: 'screenshot:<token>'`, x/y are interpreted in screenshot pixels and translated to CSS pixels via the observation cache. Response includes a `page_effect` envelope describing what changed during the action window.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "x", "y"] as const,
    properties: {
      tab_id: tabIdSchema,
      x: { type: "number", minimum: 0 },
      y: { type: "number", minimum: 0 },
      button: { enum: ["left", "middle", "right"] as const, default: "left" },
      modifiers: modifiersSchema,
      coord_space: {
        description:
          "Coordinate space for x,y. 'css' (default) treats them as CSS pixels relative to the viewport. 'screenshot:<token>' treats them as pixels inside the screenshot identified by the token (returned by browser_screenshot / browser_observe).",
        type: "string",
        pattern: "^(css|screenshot:.+)$",
        default: "css",
      },
      expected: actionExpectationSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["clicked", "x", "y"] as const,
    properties: {
      clicked: { const: true },
      x: { type: "number" },
      y: { type: "number" },
      effect: effectSchema,
      ...expectationOutputSchema,
      hit_element: {
        type: "object",
        additionalProperties: false,
        required: ["tag", "role", "name", "ref"] as const,
        properties: {
          tag: { type: "string" },
          role: { type: "string" },
          name: { type: "string" },
          ref: { type: "string" },
        },
      },
    },
  },
  action_weight: 1,
  risky: "conditional",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...MUTATING_CODES,
    ...RISKY_CODES,
    "CDP_ATTACH_FAILED",
  ] as const,
} as const;

const clickByText: ToolDef = {
  name: "browser_click_by_text",
  description:
    "Click the visible element whose accessible name matches the given text. Bypasses the a11y-tree ref mechanism — use this when browser_read didn't surface the element as a ref (common on SPA sites with div-wrapped click handlers), or when the agent knows the exact button label and doesn't want to pay for a full read first. Typically called from an operator sub-agent. Response includes a `page_effect` envelope describing what changed during the action window.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "text"] as const,
    properties: {
      tab_id: tabIdSchema,
      text: { type: "string", minLength: 1, maxLength: 256 },
      match: {
        description:
          "How to compare `text` against each candidate's accessible name.",
        enum: ["exact", "prefix", "substring"] as const,
        default: "substring",
      },
      role: {
        description:
          "If set, only match elements with this semantic role (button, link, etc.).",
        type: "string",
        maxLength: 32,
      },
      case_sensitive: { type: "boolean", default: false },
      button: { enum: ["left", "middle", "right"] as const, default: "left" },
      modifiers: modifiersSchema,
      expected: actionExpectationSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["clicked"] as const,
    properties: {
      clicked: { const: true },
      matched: {
        type: "object",
        additionalProperties: false,
        properties: {
          role: { type: "string" },
          name: { type: "string" },
          tag: { type: "string" },
        },
      },
      occluded: { type: "boolean" },
      occluder: {
        type: "object",
        additionalProperties: false,
        properties: {
          tag: { type: "string" },
          text: { type: "string" },
          role: { type: ["string", "null"] },
        },
      },
      effect: effectSchema,
      ...expectationOutputSchema,
    },
  },
  action_weight: 1,
  risky: "conditional",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...MUTATING_CODES,
    ...RISKY_CODES,
    "TEXT_NOT_FOUND",
  ] as const,
} as const;

const typeTool: ToolDef = {
  name: "browser_type",
  description:
    "Type text into an element identified by ref. Two dispatch modes: 'paste' (default, bulk Input.insertText — atomic, no per-character keydown events, so SPA shortcut handlers like Notion's space-for-AI overlay don't intercept the typed text mid-stream), 'keystroke' (fires per-character rawKeyDown/char/keyUp — needed for canvas-backed editors like Google Sheets cells that listen for real key events on a hidden input; also for autocompletes / per-keystroke validators). Default is 'paste' except when the ref's selector matches a known canvas editor (auto-routed to 'keystroke'). Returns `{typed, mode, page_effect?, effect, warnings?}` — `effect` is the page_effect envelope.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "text"] as const,
    properties: {
      tab_id: tabIdSchema,
      ref: {
        ...refSchema,
        description:
          "Optional. If omitted, text is inserted into document.activeElement via Input.insertText — call browser_click_at first to focus the target field. When provided, the handler clicks the ref to focus it and then types.",
      },
      text: { type: "string", maxLength: 32768 },
      mode: {
        description:
          "Dispatch mode. Omit for auto: 'paste' for most targets, 'keystroke' when the ref's selector matches a known canvas editor (e.g. Google Sheets cell). Force 'keystroke' when you need per-character keydown events (autocompletes, validators). Force 'paste' to skip key events entirely.",
        enum: ["keystroke", "paste"] as const,
      },
      submit: { type: "boolean", default: false },
      clear_mode: {
        description:
          "How to clear the field before typing. Omit to skip clearing entirely. 'value' assigns el.value='' — fastest, but silently skips contenteditable editors (Gmail body, Notion, Slack). 'select_all' uses a range/.select()+delete path with a keyboard-fallback — works on contenteditable. 'auto' picks 'value' for form inputs and 'select_all' for contenteditable, then verifies the field is empty and retries with select_all+keyboard-delete if not.",
        enum: ["value", "select_all", "auto"] as const,
      },
      delay_ms: { type: "integer", minimum: 0, maximum: 200, default: 0 },
      observe_effects: observeEffectsInputSchema,
      expect_effect: expectEffectInputSchema,
      expected: actionExpectationSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["typed"] as const,
    properties: {
      typed: { type: "integer", minimum: 0 },
      mode: { enum: ["keystroke", "paste"] as const },
      submitted: { type: "boolean" },
      navigated: { type: "boolean" },
      cleared: {
        type: "boolean",
        description: "True when the field was cleared before typing (clear_mode was set).",
      },
      page_effect: pageEffectSchema,
      effect: effectSchema,
      ...expectationOutputSchema,
      warnings: warningsOutputSchema,
    },
  },
  action_weight: 1,
  risky: "conditional",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...REF_CODES,
    ...MUTATING_CODES,
    ...RISKY_CODES,
  ] as const,
} as const;

const findAndReplace: ToolDef = {
  name: "browser_find_and_replace",
  description:
    "Replace a substring inside an editable element without clearing the whole field. Works on <input>, <textarea>, and contenteditable. Target resolves to `ref` if given, otherwise document.activeElement. Dispatches via beforeinput + execCommand insertText + Range fallback. Response includes a `page_effect` envelope describing what changed during the action window.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "find", "replace"] as const,
    properties: {
      tab_id: tabIdSchema,
      ref: refSchema,
      find: { type: "string", minLength: 1, maxLength: 4096 },
      replace: { type: "string", maxLength: 32768 },
      occurrence: { enum: ["first", "all"] as const, default: "first" },
      case_sensitive: { type: "boolean", default: true },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["replaced"] as const,
    properties: {
      replaced: { type: "integer", minimum: 0 },
      used_fallback: { type: "boolean" },
      effect: effectSchema,
    },
  },
  action_weight: 1,
  risky: "conditional",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...REF_CODES,
    ...MUTATING_CODES,
    ...RISKY_CODES,
    "TEXT_NOT_FOUND",
  ] as const,
} as const;

const press: ToolDef = {
  name: "browser_press",
  description:
    "Send a keyboard-only chord to the tab (CDP key names). Does not target a specific ref. Leading entries are treated as modifiers and the final entry as the key — e.g. [\"Primary\",\"KeyA\"] sends select-all. Use `Primary` instead of Meta/Control for portable chords; the extension resolves it to Meta on macOS and Control elsewhere at dispatch time. Returns `{pressed, page_effect?, effect, warnings?}` — `effect` is the page_effect envelope (mutations, network, visual hash diff, focus, new dialogs, a11y diff, console errors).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "keys"] as const,
    properties: {
      tab_id: tabIdSchema,
      keys: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "string",
          minLength: 1,
          maxLength: 32,
          description:
            "CDP key name (e.g. `KeyA`, `Enter`, `Escape`, `Delete`, `Backspace`, `Tab`, `ArrowLeft`) or one of the modifiers `Control`, `Alt`, `Shift`, `Meta`, `Primary`.",
        },
      },
      repeat: { type: "integer", minimum: 1, maximum: 20, default: 1 },
      observe_effects: observeEffectsInputSchema,
      expect_effect: expectEffectInputSchema,
      expected: actionExpectationSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pressed"] as const,
    properties: {
      pressed: { const: true },
      page_effect: pageEffectSchema,
      effect: effectSchema,
      ...expectationOutputSchema,
      warnings: warningsOutputSchema,
    },
  },
  action_weight: 1,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...MUTATING_CODES,
  ] as const,
} as const;

const scroll: ToolDef = {
  name: "browser_scroll",
  description:
    "Scroll the page (directional) or scroll a specific element into view (ref-based). Exactly one of direction or ref.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
      direction: { enum: ["up", "down", "left", "right", "top", "bottom"] as const },
      amount: {
        description:
          "Pixels, or 'page' for one viewport height/width. Ignored for 'top'/'bottom'.",
        oneOf: [
          { type: "integer", minimum: 1, maximum: 100000 },
          { const: "page" },
        ],
      },
      ref: refSchema,
    },
    oneOf: [
      { required: ["direction"] as const },
      { required: ["ref"] as const },
    ],
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["scroll_y"] as const,
    properties: {
      scroll_x: { type: "number" },
      scroll_y: { type: "number" },
    },
  },
  action_weight: 0.5,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...REF_CODES,
    ...MUTATING_CODES,
  ] as const,
} as const;

const hover: ToolDef = {
  name: "browser_hover",
  description:
    "Move the synthetic mouse over an element identified by ref (fires CSS :hover and pointer events). Also accepts (x, y) coords with `coord_space` like browser_click_at — useful for hovering over canvas / SoM-labeled regions. Response includes a `page_effect` envelope describing what changed during the action window.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
      ref: refSchema,
      x: { type: "number", minimum: 0 },
      y: { type: "number", minimum: 0 },
      coord_space: {
        description:
          "Coordinate space for x,y. 'css' (default) treats them as CSS pixels relative to the viewport. 'screenshot:<token>' treats them as pixels inside the screenshot identified by the token.",
        type: "string",
        pattern: "^(css|screenshot:.+)$",
        default: "css",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["hovered"] as const,
    properties: {
      hovered: { const: true },
      effect: effectSchema,
    },
  },
  action_weight: 0.5,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...REF_CODES,
    ...MUTATING_CODES,
  ] as const,
} as const;

const describeRef: ToolDef = {
  name: "browser_describe_ref",
  description:
    "Return the live state of an element referenced by a prior browser_read(a11y_tree). Cheaper than re-reading the whole tree when you just need to check \"is the button enabled yet?\", \"did my input land?\", or \"is the focus where I expect?\". Does not mutate the page.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "ref"] as const,
    properties: {
      tab_id: tabIdSchema,
      ref: refSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["ref", "role", "name", "tag", "visible"] as const,
    properties: {
      ref: refSchema,
      role: { type: "string" },
      name: { type: "string" },
      tag: { type: "string" },
      visible: { type: "boolean" },
      disabled: { type: "boolean" },
      focused: { type: "boolean" },
      checked: { type: "boolean" },
      value: { type: "string" },
      attrs: {
        type: "object",
        additionalProperties: { type: "string" },
      },
      aria: {
        type: "object",
        additionalProperties: { type: "string" },
      },
      rect: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y", "width", "height"] as const,
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
      },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...TAB_CODES, ...REF_CODES] as const,
} as const;

const elementStateSchemaProperties = {
  role: { type: "string" },
  name: { type: "string" },
  tag: { type: "string" },
  visible: { type: "boolean" },
  disabled: { type: "boolean" },
  focused: { type: "boolean" },
  checked: { type: "boolean" },
  value: { type: "string" },
  attrs: { type: "object", additionalProperties: { type: "string" } },
  aria: { type: "object", additionalProperties: { type: "string" } },
  rect: {
    type: "object",
    additionalProperties: false,
    required: ["x", "y", "width", "height"] as const,
    properties: {
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number" },
      height: { type: "number" },
    },
  },
} as const;

const elementStateSchema = {
  type: "object",
  additionalProperties: false,
  required: ["role", "name", "tag", "visible"] as const,
  properties: elementStateSchemaProperties,
} as const;

const querySelector: ToolDef = {
  name: "browser_query_selector",
  description:
    "Read-only CSS-selector inspector. Returns the same element-state shape as describe_ref, keyed on a selector rather than a ref — use when the a11y walker didn't emit a ref for the element you need (generic div, unusual role, etc.). all:true returns up to 50 matches with a `total` count for truncation detection. No ref assignment, no mutation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "selector"] as const,
    properties: {
      tab_id: tabIdSchema,
      selector: { type: "string", minLength: 1, maxLength: 2048 },
      all: { type: "boolean", default: false },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      match: elementStateSchema,
      matches: { type: "array", items: elementStateSchema, maxItems: 50 },
      total: { type: "integer", minimum: 0 },
      truncated: { type: "boolean" },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...TAB_CODES] as const,
} as const;

const waitFor: ToolDef = {
  name: "browser_wait_for",
  description:
    "Block until a ref, a text substring, or a URL pattern appears. Post-navigation/XHR synchronisation. " +
    "Optionally chain an action (then_click or then_type) to execute immediately after the condition is met, " +
    "eliminating a round-trip.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
      ref: refSchema,
      text: { type: "string", minLength: 1, maxLength: 1024 },
      url_pattern: { type: "string", minLength: 1, maxLength: 1024 },
      timeout_ms: { type: "integer", minimum: 100, maximum: 120000, default: 10000 },
      poll_ms: { type: "integer", minimum: 50, maximum: 5000, default: 250 },
      then_click: {
        type: "object",
        additionalProperties: false,
        required: ["ref"] as const,
        properties: { ref: refSchema },
        description: "After the wait condition is met, click this ref. Eliminates a round-trip. Mutually exclusive with then_type.",
      },
      then_type: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "text"] as const,
        properties: {
          ref: refSchema,
          text: { type: "string", maxLength: 32768 },
        },
        description: "After the wait condition is met, type into this ref. Eliminates a round-trip. Mutually exclusive with then_click.",
      },
    },
    anyOf: [
      { required: ["ref"] as const },
      { required: ["text"] as const },
      { required: ["url_pattern"] as const },
    ],
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["matched"] as const,
    properties: {
      matched: { enum: ["ref", "text", "url_pattern"] as const },
      elapsed_ms: { type: "integer", minimum: 0 },
      action_result: {
        type: "object",
        description: "Result of the chained action (then_click or then_type), if any.",
      },
    },
  },
  action_weight: 0.5,
  risky: "conditional",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...MUTATING_CODES,
    ...RISKY_CODES,
    "REF_STALE",
    "REF_NOT_FOUND",
    "CHAINED_ACTION_FAILED",
  ] as const,
} as const;

const waitForIdle: ToolDef = {
  name: "browser_wait_for_idle",
  description:
    "Block until the tab has no in-flight HTTP requests for `quiet_ms` consecutive milliseconds, or until `timeout_ms` elapses. Use after navigate/click when the DOM is drawn but async data is still loading — browser_wait_for only sees DOM signals, this sees the network. Requires webRequest permission.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
      quiet_ms: { type: "integer", minimum: 100, maximum: 30000, default: 500 },
      timeout_ms: { type: "integer", minimum: 100, maximum: 120000, default: 10000 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["idle", "elapsed_ms"] as const,
    properties: {
      idle: { const: true },
      elapsed_ms: { type: "integer", minimum: 0 },
      // Peak in-flight requests observed while waiting — useful for debugging
      // why a page feels slow.
      peak_in_flight: { type: "integer", minimum: 0 },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...TAB_CODES] as const,
} as const;

const executeJs: ToolDef = {
  name: "browser_execute_js",
  description:
    "Execute JavaScript inside the tab's main world. Always risky; gated on every invocation. Use when the input/click/read tools can't address the target (custom event filters, deeply virtualized DOM). CDP is auto-attached on every http(s) tab so trusted-input semantics apply.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "code"] as const,
    properties: {
      tab_id: tabIdSchema,
      code: { type: "string", minLength: 1, maxLength: 65536 },
      args: {
        type: "array",
        maxItems: 16,
        items: {},
      },
      await_promise: { type: "boolean", default: true },
      return_by_value: { type: "boolean", default: true },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["value"] as const,
    properties: {
      value: {},
      type: { type: "string" },
      subtype: { type: "string" },
      thrown: { type: "boolean", default: false },
    },
  },
  action_weight: 1,
  risky: "always",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...MUTATING_CODES,
    ...RISKY_CODES,
    "CDP_ATTACH_FAILED",
  ] as const,
} as const;

const setCdp: ToolDef = {
  name: "browser_set_cdp",
  description:
    "Enable or disable persistent CDP (Chrome DevTools Protocol) attachment for a tab. " +
    "CDP is auto-attached on every http(s) navigation so input dispatch is trusted by default; " +
    "the only reason to call this tool is to opt a specific tab OUT (enabled:false) when the " +
    "'controlled by automated software' banner is unacceptable for the current task. " +
    "Synthetic-DOM dispatch resumes for that tab — faster, no banner, but silently fails on " +
    "isTrusted-gated UIs (canvas apps, rich editors). Re-enable with enabled:true.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "enabled"] as const,
    properties: {
      tab_id: tabIdSchema,
      enabled: { type: "boolean" },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["enabled"] as const,
    properties: {
      enabled: { type: "boolean" },
    },
  },
  action_weight: 0.5,
  risky: "never",
  errorCodes: [...BASE_CODES, ...TAB_CODES, "CDP_ATTACH_FAILED"] as const,
} as const;

// ---------------------------------------------------------------------------
// Procedure tools (feature: "procedures")
//
// Six tools in this family:
//   procedures_search / _get / _save / _delete — store CRUD
//   procedures_execute — runs a procedure; may halt with needs_assist
//   procedures_resume  — resume a needs_assist execution with an LLM patch
//
// The runtime is deterministic-first: each step resolves a semantic Locator
// against the live a11y tree (browser_locate), polls a retrying `expect:`
// predicate, and escalates through the per-step fallback ladder
// (strict | retry | relocate | relocate_then_llm | llm). Author-time
// uniqueness is measured by `browser_propose_locator` and drift health
// is auto-recorded into the YAML's meta.health for auto-demote on save.
// ---------------------------------------------------------------------------

const procedureNamePattern = "^[a-z][a-z0-9._-]{0,79}$";
const scopePattern = "^(all|shared|composite:[a-z][a-z0-9._-]{0,79})$";
const domainPattern = "^[a-z][a-z0-9_-]*$";

const proceduresSearch: ToolDef = {
  name: "procedures_search",
  feature: "procedures",
  description:
    "Search the procedure catalogue by free-form query (token coverage + name/trigger/description ranking). " +
    "Returns metadata-only matches; use procedures_get for the YAML body. " +
    "Excludes status:draft entries by default; pass include_drafts:true to see them. " +
    'REQUIRED ARGUMENTS: {"query": "<text>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"] as const,
    properties: {
      query: { type: "string", minLength: 1, maxLength: 200 },
      limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      min_score: { type: "number", minimum: 0, maximum: 1, default: 0.2 },
      domain: { type: "string", pattern: domainPattern },
      scope: { type: "string", pattern: scopePattern, default: "all" },
      deep: { type: "boolean", default: false },
      include_drafts: { type: "boolean", default: false },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["matches", "total", "truncated"] as const,
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "kind", "description", "inputs", "triggers", "side_effects", "score"] as const,
          properties: {
            name: { type: "string" },
            kind: { enum: ["leaf", "composite"] as const },
            domain: { type: ["string", "null"] },
            description: { type: "string" },
            goal: { type: "string" },
            inputs: { type: "array", items: { type: "string" } },
            triggers: { type: "array", items: { type: "string" } },
            side_effects: { type: "array", items: { type: "string" } },
            score: { type: "number", minimum: 0, maximum: 1 },
            snippet: { type: "string" },
          },
        },
      },
      total: { type: "integer", minimum: 0 },
      truncated: { type: "boolean" },
      drafts: { type: "array", items: { type: "object" } },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...PROCEDURE_CODES] as const,
} as const;

const procedureMetaOutSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: true,
  required: ["version", "created", "last_verified", "status"] as const,
  properties: {
    version: { type: "integer", minimum: 1 },
    created: { type: "string" },
    last_verified: { type: "string" },
    status: { enum: ["draft", "trusted"] as const },
    health: { type: "object", additionalProperties: true },
  },
};

const proceduresGet: ToolDef = {
  name: "procedures_get",
  feature: "procedures",
  description:
    "Fetch the YAML body + metadata for a procedure by name. " +
    'REQUIRED ARGUMENTS: {"name": "<procedure name>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"] as const,
    properties: {
      name: { type: "string", pattern: procedureNamePattern },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["yaml", "path", "meta"] as const,
    properties: {
      yaml: { type: "string" },
      path: { type: "string" },
      meta: procedureMetaOutSchema,
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...PROCEDURE_CODES] as const,
} as const;

const proceduresSave: ToolDef = {
  name: "procedures_save",
  feature: "procedures",
  description:
    "Create or update a procedure from YAML. Validates schema + forbidden + binding shape before write. " +
    "Set bump_success:true after a clean run to flip status from draft to trusted. " +
    "The runtime refuses to bump trusted when drift health on the existing YAML " +
    "exceeds threshold (auto-demote) — the response carries {demoted:true, demote_reason:'...'} " +
    "and the save persists as draft. " +
    'REQUIRED ARGUMENTS: {"name": "<id>", "yaml": "<text>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "yaml"] as const,
    properties: {
      name: { type: "string", pattern: procedureNamePattern },
      yaml: { type: "string", minLength: 1, maxLength: 65536 },
      owner: { type: "string", pattern: procedureNamePattern },
      overwrite: { type: "boolean", default: false },
      bump_success: { type: "boolean", default: false },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: true,
    required: ["saved", "path", "version"] as const,
    properties: {
      saved: { const: true },
      path: { type: "string" },
      version: { type: "integer", minimum: 1 },
      demoted: { type: "boolean" },
      demote_reason: { type: "string" },
    },
  },
  action_weight: 0.5,
  risky: "never",
  errorCodes: [...BASE_CODES, ...PROCEDURE_CODES] as const,
} as const;

const proceduresDelete: ToolDef = {
  name: "procedures_delete",
  feature: "procedures",
  description:
    "Remove a procedure from the store. Refuses if other composites reference it unless force:true. " +
    'REQUIRED ARGUMENTS: {"name": "<id>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"] as const,
    properties: {
      name: { type: "string", pattern: procedureNamePattern },
      force: { type: "boolean", default: false },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["deleted", "path"] as const,
    properties: {
      deleted: { const: true },
      path: { type: "string" },
    },
  },
  action_weight: 0.5,
  risky: "never",
  errorCodes: [...BASE_CODES, ...PROCEDURE_CODES] as const,
} as const;

const procedureStepResultSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: true,
  required: ["id", "action", "matched"] as const,
  properties: {
    id: { type: "string" },
    action: { type: "string" },
    matched: { type: "boolean" },
    attempts: { type: "integer", minimum: 1 },
    resolved_by: {
      enum: ["first_try", "retry", "relocate", "llm", "halted"] as const,
    },
  },
};

const proceduresExecute: ToolDef = {
  name: "procedures_execute",
  feature: "procedures",
  description:
    "Run a procedure end-to-end. Resolves semantic locators against the live page, auto-waits, polls expect predicates, " +
    "and applies the per-step fallback ladder (retry → relocate → llm). " +
    "If a step's fallback resolves to llm (and strict:false), the runner halts and returns " +
    '{"status":"needs_assist","execution_id":"<id>","envelope":{...}}. ' +
    "Resume via procedures_resume(execution_id, patch). " +
    'REQUIRED ARGUMENTS: {"name": "<procedure>", "tab_id": "<tab>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "tab_id"] as const,
    properties: {
      name: { type: "string", pattern: procedureNamePattern },
      tab_id: tabIdSchema,
      inputs: { type: "object", additionalProperties: true, default: {} },
      strict: {
        type: "boolean",
        default: false,
        description:
          "Refuse all LLM fallback paths even when steps declare them. Use for CI / batch runs " +
          "and post-authoring verification before bump_success:true.",
      },
      max_tool_calls: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description: "Global cap on tool_call budget spent by fallback strategies.",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: true,
    required: ["completed", "status", "steps_executed", "step_results", "used_llm_fallback"] as const,
    properties: {
      completed: { type: "boolean" },
      status: {
        enum: ["completed", "needs_assist", "gave_up", "halted"] as const,
      },
      steps_executed: { type: "integer", minimum: 0 },
      step_results: { type: "array", items: procedureStepResultSchema },
      execution_id: { type: "string" },
      envelope: { type: "object", additionalProperties: true },
      divergence: { type: "object", additionalProperties: true },
      used_llm_fallback: { type: "boolean" },
      verify_passed: { type: "boolean" },
    },
  },
  action_weight: 1,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...PROCEDURE_CODES,
    ...TAB_CODES,
    "EXTENSION_DISCONNECTED",
    "RATE_LIMITED",
    "LOCATOR_NOT_FOUND",
    "LOCATOR_AMBIGUOUS",
    "ELEMENT_NOT_ACTIONABLE",
  ] as const,
} as const;

const proceduresResume: ToolDef = {
  name: "procedures_resume",
  feature: "procedures",
  description:
    "Resume a suspended procedure execution with a patch. Three patch kinds: " +
    "(1) resume_with{locator?, params?} — retry the failing step with a fresh descriptor; " +
    "(2) insert_steps{steps[]} — run corrective steps then continue from the original step; " +
    "(3) give_up{reason?} — abandon the run. " +
    "Every step the patch introduces goes through the same forbidden guard as a normal dispatch. " +
    'REQUIRED ARGUMENTS: {"execution_id": "<id>", "patch": {<patch>}}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["execution_id", "patch"] as const,
    properties: {
      execution_id: { type: "string", minLength: 1 },
      patch: {
        type: "object",
        additionalProperties: true,
        required: ["kind"] as const,
        properties: {
          kind: { enum: ["resume_with", "insert_steps", "give_up"] as const },
        },
      },
    },
  },
  outputSchema: proceduresExecute.outputSchema,
  action_weight: 1,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...PROCEDURE_CODES,
    ...TAB_CODES,
    "EXTENSION_DISCONNECTED",
    "LOCATOR_NOT_FOUND",
  ] as const,
} as const;
// ---------------------------------------------------------------------------
// Cross-agent memory tools (feature: "memory") — v2 shapes (Phase 4)
//
// Two stores: global/ (cross-site) + sites/<origin-slug>/ (per-site).
// Records are schema-validated YAML (MemoryRecord, schema_version:1).
// Six tools: save / search / get / delete / session_trace / list_for_origin.
// ---------------------------------------------------------------------------

const memoryNamePattern = "^[a-z][a-z0-9._-]{0,79}$";

// Schema constants must be declared before the tool defs that reference them.

/** JSON-Schema for a MemoryRecord (v2 structured record). */
export const MEMORY_RECORD_V2_SCHEMA: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "name", "scope", "kind", "title", "detail"] as const,
  properties: {
    schema_version: { const: 1 },
    name: { type: "string", pattern: "^[a-z][a-z0-9._-]{0,79}$" },
    scope: { enum: ["global", "site"] as const },
    kind: { enum: ["blocker", "affordance", "gotcha", "selector", "lesson"] as const },
    title: { type: "string", minLength: 1, maxLength: 120 },
    origin: { type: "string", maxLength: 500 },
    origin_wildcard: { type: "boolean" },
    path_glob: { type: "string", maxLength: 500 },
    severity: { enum: ["low", "med", "high"] as const },
    tags: {
      type: "array",
      items: { type: "string", maxLength: 64 },
      maxItems: 10,
      uniqueItems: true,
    },
    detail: {
      type: "object",
      additionalProperties: false,
      properties: {
        wall: { type: "string", maxLength: 2000 },
        door: { type: "string", maxLength: 2000 },
        note: { type: "string", maxLength: 2000 },
        locator: {
          type: "object",
          description: "Procedures Locator descriptor reused for selector memories.",
          additionalProperties: true,
        },
      },
    },
    links: {
      type: "object",
      additionalProperties: false,
      properties: {
        procedures: {
          type: "array",
          items: { type: "string", maxLength: 80 },
          maxItems: 20,
        },
        memories: {
          type: "array",
          items: { type: "string", maxLength: 80 },
          maxItems: 20,
        },
      },
    },
    stats: {
      type: "object",
      additionalProperties: false,
      required: ["hits", "resolved", "door_failures", "captures"] as const,
      properties: {
        hits: { type: "integer", minimum: 0 },
        last_hit: { type: "string" },
        resolved: { type: "integer", minimum: 0 },
        last_resolved: { type: "string" },
        door_failures: { type: "integer", minimum: 0 },
        captures: { type: "integer", minimum: 0 },
      },
    },
    meta: {
      type: "object",
      additionalProperties: false,
      required: ["version", "created", "updated", "source"] as const,
      properties: {
        version: { type: "integer", minimum: 1 },
        created: { type: "string" },
        updated: { type: "string" },
        source: { enum: ["scribe", "mcp-tool", "cli"] as const },
        corroborated: { type: "boolean" },
      },
    },
  },
  if: { properties: { scope: { const: "site" } } },
  then: { required: ["origin"] as const },
} as const;

/** Input schema for memory_session_trace (v2 tool added in Phase 4). */
export const MEMORY_SESSION_TRACE_INPUT_SCHEMA: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    tab_id: {
      type: "string",
      pattern: "^t_[0-9a-z]+$",
      description: "Resolve to the session that owns this tab.",
    },
    session_id: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Explicit session ID (alternative to tab_id).",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 50,
      description: "Maximum number of trace entries to return.",
    },
  },
  anyOf: [
    { required: ["tab_id"] as const },
    { required: ["session_id"] as const },
    {},
  ],
} as const;

/** Input schema for memory_list_for_origin (v2 tool added in Phase 4). */
export const MEMORY_LIST_FOR_ORIGIN_INPUT_SCHEMA: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["origin"] as const,
  properties: {
    origin: {
      type: "string",
      maxLength: 500,
      description: "scheme://host[:port] — list all site-scoped memories for this origin.",
    },
    kind: {
      enum: ["blocker", "affordance", "gotcha", "selector", "lesson"] as const,
      description: "Optional kind filter.",
    },
    min_confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Only return records whose confidence score meets this threshold.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 20,
    },
  },
} as const;

// v2 search result entry — carries confidence score alongside token coverage.
const memoryRecordMatchSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["name", "title", "scope", "kind", "score", "confidence", "snippet"] as const,
  properties: {
    name: { type: "string" },
    title: { type: "string" },
    scope: { enum: ["global", "site"] as const },
    kind: { enum: ["blocker", "affordance", "gotcha", "selector", "lesson"] as const },
    origin: { type: "string" },
    score: { type: "number", minimum: 0, maximum: 1 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    snippet: { type: "string" },
  },
} as const;

const memorySave: ToolDef = {
  name: "memory_save",
  feature: "memory",
  description:
    "Persist a structured MemoryRecord (schema_version:1) to ~/browserops/memory/, visible to every MCP client. " +
    "Records are YAML, two-store layout: global/ for cross-site lessons and sites/<origin>/ for per-site knowledge. " +
    "The store runs a dedup check on create — when a similar record exists and merge_into is absent, " +
    "the response includes possible_duplicate:{name,score} instead of writing; set merge_into to the " +
    "existing name to merge, or replace:true to overwrite by name. " +
    'REQUIRED ARGUMENTS: {"record": {schema_version:1, name, scope, kind, title, detail, …}}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["record"] as const,
    properties: {
      record: MEMORY_RECORD_V2_SCHEMA,
      merge_into: {
        type: "string",
        pattern: memoryNamePattern,
        description:
          "Name of an existing record to merge this into. Bumps stats.captures, refines title/detail/tags. " +
          "Use when possible_duplicate was returned on a prior save attempt.",
      },
      replace: {
        type: "boolean",
        default: false,
        description:
          "When true, overwrite an existing record with the same name. Default false rejects duplicates with MEMORY_ALREADY_EXISTS.",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["saved", "path", "created"] as const,
    properties: {
      saved: { const: true },
      path: { type: "string" },
      created: {
        type: "boolean",
        description: "True when a new record was created, false when merged or overwritten.",
      },
      possible_duplicate: {
        type: "object",
        additionalProperties: false,
        required: ["name", "score"] as const,
        description:
          "Present when the store detected a similar record and did NOT write. " +
          "Pass merge_into:<name> to merge instead.",
        properties: {
          name: { type: "string" },
          score: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
  action_weight: 0.5,
  risky: "never",
  errorCodes: [...BASE_CODES, ...MEMORY_CODES] as const,
} as const;

const memorySearch: ToolDef = {
  name: "memory_search",
  feature: "memory",
  description:
    "Confidence-first, token-coverage search over the structured memory store. " +
    "Returns ranked metadata-only matches; fetch the full record with memory_get. " +
    "Filter by scope (global|site), origin (scheme://host[:port]), or kind (blocker|affordance|gotcha|selector|lesson). " +
    'REQUIRED ARGUMENTS: {"query": "<search tokens>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"] as const,
    properties: {
      query: { type: "string", minLength: 1, maxLength: 200 },
      scope: {
        enum: ["global", "site"] as const,
        description: "If set, only return records with this scope.",
      },
      origin: {
        type: "string",
        maxLength: 500,
        description:
          "If set, only return site-scoped records matching this origin (scheme://host[:port]).",
      },
      kind: {
        enum: ["blocker", "affordance", "gotcha", "selector", "lesson"] as const,
        description: "If set, only return records with this kind.",
      },
      limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      min_score: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 0.2,
        description: "Minimum token-coverage ratio. Default 0.2.",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["matches", "total", "truncated"] as const,
    properties: {
      matches: { type: "array", items: memoryRecordMatchSchema },
      total: { type: "integer", minimum: 0 },
      truncated: { type: "boolean" },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...MEMORY_CODES] as const,
} as const;

const memoryGet: ToolDef = {
  name: "memory_get",
  feature: "memory",
  description:
    "Retrieve the full MemoryRecord for a single memory by name. " +
    "Errors with MEMORY_NOT_FOUND if the name is not in the store. " +
    'REQUIRED ARGUMENTS: {"name": "<id>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"] as const,
    properties: {
      name: { type: "string", pattern: memoryNamePattern },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["record", "path"] as const,
    properties: {
      record: MEMORY_RECORD_V2_SCHEMA,
      path: { type: "string" },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...MEMORY_CODES] as const,
} as const;

const memoryDelete: ToolDef = {
  name: "memory_delete",
  feature: "memory",
  description:
    "Remove a memory record from the store by name. " +
    "Errors with MEMORY_NOT_FOUND if the name is not present. " +
    'REQUIRED ARGUMENTS: {"name": "<id>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"] as const,
    properties: {
      name: { type: "string", pattern: memoryNamePattern },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["deleted", "path"] as const,
    properties: {
      deleted: { const: true },
      path: { type: "string" },
    },
  },
  action_weight: 0.5,
  risky: "never",
  errorCodes: [...BASE_CODES, ...MEMORY_CODES] as const,
} as const;

const memorySessionTrace: ToolDef = {
  name: "memory_session_trace",
  feature: "memory",
  description:
    "Retrieve recent tool-call trace entries for a session. Used by the memory-scribe subagent " +
    "to understand what happened before a roadblock or task completion. " +
    "Provide tab_id to resolve to the owning session, or session_id directly. " +
    "Returns an array of recent trace entries (method, origin, error_code?, effect_summary, ts). " +
    'REQUIRED ARGUMENTS: one of {"tab_id": "<t_…>"} or {"session_id": "<id>"}.',
  inputSchema: MEMORY_SESSION_TRACE_INPUT_SCHEMA,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["entries"] as const,
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["method", "ts"] as const,
          properties: {
            method: { type: "string" },
            origin: { type: "string" },
            error_code: { type: "string" },
            effect_summary: { type: "string" },
            ts: { type: "string" },
          },
        },
      },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES] as const,
} as const;

const memoryListForOrigin: ToolDef = {
  name: "memory_list_for_origin",
  feature: "memory",
  description:
    "List all site-scoped memory records for a given origin (scheme://host[:port]). " +
    "Returns metadata-only entries sorted by confidence descending. " +
    "Used by the hybrid-delivery layer to prime the agent with per-site context. " +
    'REQUIRED ARGUMENTS: {"origin": "scheme://host[:port]"}.',
  inputSchema: MEMORY_LIST_FOR_ORIGIN_INPUT_SCHEMA,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["records", "total"] as const,
    properties: {
      records: { type: "array", items: memoryRecordMatchSchema },
      total: { type: "integer", minimum: 0 },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...MEMORY_CODES] as const,
} as const;

const setSessionName: ToolDef = {
  name: "browser_set_session_name",
  description:
    "Rename this MCP session. The new name updates the Chrome tab-group label so the user " +
    "can tell at a glance which agent is responsible for which tabs. Default names come from " +
    "the MCP client (\"Claude Code\", \"Cursor\", …); use this when multiple sessions are alive " +
    "and you want a task-specific label like \"scrape-amazon\". Keep names short — Chrome " +
    "truncates long tab-group titles aggressively.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"] as const,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "name"] as const,
    properties: {
      session_id: { type: "string" },
      name: { type: "string" },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, "INVALID_STATE"] as const,
} as const;

const releaseTab: ToolDef = {
  name: "browser_release_tab",
  description:
    "Release a tab back to user-owned. After this call the tab leaves this session's tab " +
    "group and any session (or the user) can interact with it again. Use to hand a tab " +
    "back when you're done; otherwise tabs auto-orphan when this session disconnects.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["released"] as const,
    properties: {
      released: { const: true },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...TAB_CODES] as const,
} as const;

// ---------------------------------------------------------------------------
// Procedure locator helpers: browser_locate (resolver) + browser_propose_locator (uniqueness scorer)
// ---------------------------------------------------------------------------

const locatorInputSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    role: { type: "string", minLength: 1, maxLength: 40 },
    name: { type: "string", minLength: 1, maxLength: 400 },
    aria_label: { type: "string", minLength: 1, maxLength: 400 },
    data_testid: { type: "string", minLength: 1, maxLength: 200 },
    href: { type: "string", minLength: 1, maxLength: 400 },
    attr: {
      type: "object",
      additionalProperties: false,
      required: ["name", "value"] as const,
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
        value: { type: "string", minLength: 1, maxLength: 400 },
      },
    },
    has_text: { type: "string", minLength: 1, maxLength: 400 },
    has_text_not: { type: "string", minLength: 1, maxLength: 400 },
    in_frame: { type: "string", minLength: 1, maxLength: 400 },
    near: {
      type: "object",
      additionalProperties: false,
      properties: {
        ref: { type: "integer", minimum: 1 },
        locator: { type: "object", additionalProperties: true },
        radius_px: { type: "number", minimum: 0 },
      },
    },
    nth: { type: "integer", minimum: 0 },
    scope: { enum: ["viewport", "document"] as const },
  },
};

const browserLocate: ToolDef = {
  name: "browser_locate",
  feature: "procedures",
  description:
    "Resolve a semantic Locator descriptor (role/name/aria_label/data_testid/href/attr/has_text/nth/...) against the tab's current a11y snapshot and return matching refs. " +
    "Operates against the in-memory ref-cache, so a prior browser_read or browser_quick_read on the same tab is required. " +
    "Returns LOCATOR_NOT_FOUND when nothing matches; the procedure executor polls + refreshes the snapshot to handle dynamic UIs. " +
    'REQUIRED ARGUMENTS: {"tab_id": "<id>", "locator": {<descriptor>}}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "locator"] as const,
    properties: {
      tab_id: tabIdSchema,
      locator: locatorInputSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["matches", "used_snapshot"] as const,
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["ref", "role", "name", "selector"] as const,
          properties: {
            ref: { type: "integer", minimum: 1 },
            role: { type: "string" },
            name: { type: "string" },
            selector: { type: "string" },
          },
        },
      },
      used_snapshot: { enum: ["current", "previous", "none"] as const },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    "LOCATOR_NOT_FOUND",
    "LOCATOR_AMBIGUOUS",
    "ELEMENT_NOT_ACTIONABLE",
  ] as const,
} as const;

const browserProposeLocator: ToolDef = {
  name: "browser_propose_locator",
  feature: "procedures",
  description:
    "Author-time helper: given a target ref in the tab's current a11y snapshot, propose the smallest, highest-stability-tier Locator descriptor that resolves to exactly that element. " +
    "Walks a candidate ladder — tier 1 (aria_label / data_testid / href / attr) → tier 2 (role+name composites) → tier 3 (nth, flagged fragile). " +
    "Returns the chosen descriptor plus tier, unique flag, fragile flag, warnings, and the full candidate trace. " +
    "Use this from the browserops-teach skill (or any procedure-authoring flow) so saved locators are measured-unique, not eyeballed. " +
    'REQUIRED ARGUMENTS: {"tab_id": "<id>", "ref": <number>}. A prior browser_read (a11y_tree, augment:true) on the same tab is required to populate the ref-cache.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "ref"] as const,
    properties: {
      tab_id: tabIdSchema,
      ref: {
        type: "integer",
        minimum: 1,
        description: "The ref id (from browser_read) of the target element.",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["unique", "locator", "tier", "fragile", "warnings", "candidates"] as const,
    properties: {
      unique: {
        type: "boolean",
        description: "True when the chosen locator resolved to exactly the target ref.",
      },
      locator: {
        ...locatorInputSchema,
        description: "Chosen descriptor — the smallest, highest-tier candidate that worked.",
      },
      tier: {
        enum: [1, 2, 3] as const,
        description:
          "Stability tier of the chosen descriptor. 1=author-controlled (aria_label/data_testid/href/attr/role), 2=text-derived (name/has_text), 3=fragile (nth).",
      },
      fragile: {
        type: "boolean",
        description: "True when only the tier-3 (nth) candidate matched.",
      },
      warnings: {
        type: "array",
        items: { type: "string", maxLength: 400 },
        description: "Author-facing warnings (e.g. 'fell through to nth — descriptor is fragile').",
      },
      candidates: {
        type: "array",
        description: "Full trace of considered candidates with their match counts. Debug-grade.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["locator", "matches", "tier"] as const,
          properties: {
            locator: locatorInputSchema,
            matches: { type: "integer", minimum: 0 },
            tier: { enum: [1, 2, 3] as const },
          },
        },
      },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...TAB_CODES, "LOCATOR_NOT_FOUND", "REF_NOT_FOUND"] as const,
} as const;

// ---------------------------------------------------------------------------
// Public catalogue
// ---------------------------------------------------------------------------

// Adaptive read tool — picks the cheapest viable representation given
// page characteristics and intent. See the observation-architecture plan.
const observe: ToolDef = {
  name: "browser_observe",
  description:
    "Adaptive page observation. Returns the cheapest representation (augmented a11y, screenshot, box-drawing summary, or diff) given page size, canvas density, and stated intent. Default mode 'auto' picks based on the page; specify 'text'|'visual'|'structure'|'diff' to force a representation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
      mode: {
        enum: ["auto", "text", "visual", "structure", "diff"] as const,
        default: "auto",
        description:
          "Representation selector. 'auto' (default) chooses based on page characteristics. 'text' = augmented a11y; 'visual' = action-grade screenshot; 'structure' = box-drawing layout summary; 'diff' = changes since the supplied observation_token.",
      },
      scope: {
        type: "string",
        pattern: "^(viewport|document|ref:.+)$",
        default: "viewport",
        description:
          "Restrict the observation to a slice of the page (same shape as browser_read).",
      },
      budget_tokens: {
        type: "integer",
        minimum: 100,
        maximum: 100000,
        description:
          "Optional token budget. When set, 'auto' picks the largest representation that fits.",
      },
      since: {
        type: "string",
        description:
          "Previous observation_token. Required for mode='diff'; optional for 'auto' (the heuristic may emit a diff when the prior representation is comparable).",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["representation", "observation_token", "page_meta"] as const,
    properties: {
      representation: {
        enum: [
          "augmented_a11y",
          "screenshot",
          "box_drawing",
          "box_drawing+screenshot",
          "diff",
          "screenshot_som",
        ] as const,
      },
      observation_token: { type: "string" },
      payload: {},
      page_meta: {
        type: "object",
        additionalProperties: false,
        required: ["url", "title", "scroll", "viewport_dims", "dpr"] as const,
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          scroll: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y"] as const,
            properties: {
              x: { type: "number" },
              y: { type: "number" },
            },
          },
          viewport_dims: {
            type: "object",
            additionalProperties: false,
            required: ["w", "h"] as const,
            properties: {
              w: { type: "number" },
              h: { type: "number" },
            },
          },
          dpr: { type: "number" },
        },
      },
      warnings: warningsOutputSchema,
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...REF_CODES,
    "OBSERVATION_TOKEN_INVALID",
    "CDP_ATTACH_FAILED",
  ] as const,
} as const;

export const TOOL_DEFS: readonly ToolDef[] = [
  listTabs,
  currentTab,
  newTab,
  closeTab,
  switchTab,
  navigate,
  back,
  forward,
  reload,
  screenshot,
  read,
  quickRead,
  observe,
  click,
  clickAt,
  clickByText,
  typeTool,
  findAndReplace,
  press,
  scroll,
  hover,
  waitFor,
  waitForIdle,
  describeRef,
  querySelector,
  executeJs,
  setCdp,
  setSessionName,
  releaseTab,
  proceduresSearch,
  proceduresGet,
  proceduresSave,
  proceduresDelete,
  proceduresExecute,
  proceduresResume,
  memorySave,
  memorySearch,
  memoryGet,
  memoryDelete,
  memorySessionTrace,
  memoryListForOrigin,
  browserLocate,
  browserProposeLocator,
] as const;

export const TOOL_DEF_MAP: Record<string, ToolDef> = Object.freeze(
  TOOL_DEFS.reduce<Record<string, ToolDef>>((acc, def) => {
    acc[def.name] = def;
    return acc;
  }, {}),
);

export function getToolDef(name: string): ToolDef | undefined {
  return TOOL_DEF_MAP[name];
}
