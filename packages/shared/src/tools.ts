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
const PROC_CODES = [
  "PROC_NOT_FOUND",
  "PROC_ALREADY_EXISTS",
  "PROC_SCHEMA_INVALID",
  "PROC_IN_USE",
  "PROC_OWNER_INVALID",
  "PROC_DOMAIN_INVALID",
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
      image: { type: "string", contentEncoding: "base64" },
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
      max_results: { type: "integer", minimum: 1, maximum: 50, default: 10 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["matches", "total", "query"] as const,
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
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
    "Type text into an element identified by ref. Two dispatch modes: 'keystroke' (default for short text, fires per-character keydown/beforeinput/input/keyup — what autocompletes and per-keystroke validators need), 'paste' (bulk-assign the value in one shot, use for long text where per-char events are wasteful). Default resolves to 'keystroke' for text <=64 chars, 'paste' otherwise. Returns `{typed, mode, page_effect?, effect, warnings?}` — `effect` is the page_effect envelope (mutations, network, visual hash diff, focus, new dialogs, a11y diff, console errors).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "ref", "text"] as const,
    properties: {
      tab_id: tabIdSchema,
      ref: refSchema,
      text: { type: "string", maxLength: 32768 },
      mode: {
        description:
          "Dispatch mode — see tool description. Omit to auto-select by text length.",
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
// Procedure-memory tools
// ---------------------------------------------------------------------------

const procedureNamePattern = "^[a-z][a-z0-9._-]{0,79}$";
const scopePattern = "^(all|shared|composite:[a-z][a-z0-9._-]{0,79})$";
const domainPattern = "^[a-z][a-z0-9_-]*$";

/** Shared metadata-only entry shape returned by list/search (no YAML body). */
const entrySchema: JSONSchemaObject = {
  type: "object",
  properties: {
    name: { type: "string" },
    kind: { type: "string" },
    domain: { type: "string" },
    description: { type: "string" },
    inputs: { type: "array", items: { type: "string" } },
    triggers: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    usedBy: { type: "array", items: { type: "string" } },
  },
} as const;

const proceduresSearch: ToolDef = {
  name: "procedures_search",
  feature: "procedures",
  description:
    "Full-text search over the procedure catalogue using pre-tokenized index fields. " +
    "Returns ranked metadata-only matches; retrieve the YAML body with procedures_get. " +
    "Scoring is coverage-based: `score` is the fraction of distinct query tokens that appear " +
    "anywhere in the procedure's union of indexed-field tokens (name + triggers + description + " +
    "inputs + tags + domain). A 4-token query that matches 2 tokens scores 0.5 regardless of which " +
    "fields they hit; ties are broken by a weighted-sum signal that favours name + trigger matches. " +
    "By default only status:trusted procedures are returned — pass include_drafts:true to also see draft entries " +
    "(authored but not yet success-confirmed). " +
    "Draft fallback: when include_drafts is false AND the trusted result set is empty, draft hits are surfaced " +
    "under a separate `drafts` key so they aren't silently missed. Treat them as suggestions, not trusted hits — " +
    "verify against the live UI before relying on them. " +
    'REQUIRED ARGUMENTS: {"query": "<search tokens>"}. Example: {"query": "github sign in"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"] as const,
    properties: {
      query: { type: "string", minLength: 1, maxLength: 200 },
      limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      min_score: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 0.2,
        description:
          "Minimum coverage ratio (matched query tokens / total query tokens) for a procedure to surface. " +
          "Default 0.2 means at least 1 in 5 query tokens must appear somewhere in the procedure's indexed fields.",
      },
      domain: { type: "string", pattern: domainPattern },
      scope: { type: "string", pattern: scopePattern, default: "all" },
      deep: {
        type: "boolean",
        default: false,
        description:
          "When true, step-body tokens join the indexed-field union before coverage is computed, " +
          "so a query whose tokens only appear inside step actions/args can still surface (slower; loads YAML).",
      },
      include_drafts: {
        type: "boolean",
        default: false,
        description:
          "When true, also returns procedures with status:draft (authored via " +
          "procedures_save but not yet promoted to trusted by a successful run). " +
          "Off by default so search results stay scoped to procedures that have " +
          "been verified at least once.",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["matches", "total", "truncated"] as const,
    properties: {
      matches: { type: "array", items: { type: "object" } },
      total: { type: "integer" },
      truncated: { type: "boolean" },
      drafts: { type: "array", items: { type: "object" } },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...PROC_CODES] as const,
} as const;

const proceduresGet: ToolDef = {
  name: "procedures_get",
  feature: "procedures",
  description:
    "Retrieve the full raw YAML body and metadata for a single procedure by name. " +
    "Errors with PROC_NOT_FOUND if the name does not exist in the index. " +
    'REQUIRED ARGUMENTS: {"name": "<procedure name>"}. Example: {"name": "tempmail.get_email"}.',
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
      meta: {
        type: "object",
        additionalProperties: false,
        required: ["version", "created", "last_verified", "status"] as const,
        properties: {
          version: { type: "integer" },
          created: { type: "string" },
          last_verified: { type: "string" },
          status: { enum: ["draft", "trusted"] as const },
        },
      },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...PROC_CODES] as const,
} as const;

const proceduresSave: ToolDef = {
  name: "procedures_save",
  feature: "procedures",
  description:
    "Validate and persist a procedure YAML. Parses, schema-validates, resolves uses: references, " +
    "then atomically writes to disk and rebuilds the search index. " +
    "Set overwrite: true to update an existing procedure. " +
    "Set bump_success: true on a save you've personally verified end-to-end " +
    "(procedure ran cleanly against the live UI in this same session) — that " +
    "flips status from draft to trusted so procedures_search starts returning " +
    "the entry by default. Do NOT set bump_success on an untested save. " +
    'REQUIRED ARGUMENTS: {"name": "<procedure name>", "yaml": "<full YAML body>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "yaml"] as const,
    properties: {
      name: { type: "string", pattern: procedureNamePattern },
      yaml: { type: "string", minLength: 1, maxLength: 65536 },
      owner: { type: "string", pattern: procedureNamePattern },
      overwrite: { type: "boolean", default: false },
      bump_success: {
        type: "boolean",
        default: false,
        description:
          "When true, mark the procedure as status:trusted so it shows up " +
          "in procedures_search by default. Use this only when you've " +
          "actually verified the procedure works against the live UI — " +
          "never on the initial untested write.",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["saved", "path", "version"] as const,
    properties: {
      saved: { const: true },
      path: { type: "string" },
      version: { type: "integer" },
    },
  },
  action_weight: 0.5,
  risky: "never",
  errorCodes: [...BASE_CODES, ...PROC_CODES] as const,
} as const;

const proceduresDelete: ToolDef = {
  name: "procedures_delete",
  feature: "procedures",
  description:
    "Delete a procedure by name, cascading to sub-procedures for composites. " +
    "Refuses if the procedure is referenced by others unless force: true is set. " +
    "Rebuilds the search index after deletion. " +
    'REQUIRED ARGUMENTS: {"name": "<procedure name>"}.',
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
  errorCodes: [...BASE_CODES, ...PROC_CODES] as const,
} as const;

/** Shared step result shape used in procedures_execute output. */
const stepResultSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "action", "matched"] as const,
  properties: {
    id: { type: "string" },
    action: { type: "string" },
    observed_effect: pageEffectSchema,
    matched: { type: "boolean" },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const;

const proceduresExecute: ToolDef = {
  name: "procedures_execute",
  feature: "procedures",
  description:
    "Replay a saved procedure step by step with effect verification. " +
    "Loads the procedure by name, substitutes {{var}} input placeholders, " +
    "then dispatches each step's browser_* tool call through the extension. " +
    "After each step the observed page_effect is compared to the step's " +
    "expected_effect (loose assertions: dom.any, url.changed, focus.changed, " +
    "network.requests_started_min, etc.). Divergence halts execution and " +
    "returns a structured report naming the step and specific reason. " +
    'REQUIRED ARGUMENTS: {"name": "<procedure name>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"] as const,
    properties: {
      name: {
        type: "string",
        pattern: procedureNamePattern,
        description: "Procedure name, e.g. 'slack.search_messages'.",
      },
      inputs: {
        type: "object",
        additionalProperties: true,
        description: "Values for procedure input params ({{var}} substitution).",
      },
      continue_on_warning: {
        type: "boolean",
        default: false,
        description:
          "Reserved for Phase 6. When true, soft divergences do not halt execution. " +
          "Phase 5 always halts on any mismatch regardless of this flag.",
      },
      max_steps: {
        type: "integer",
        minimum: 1,
        description:
          "Safety cap on the number of steps to execute. " +
          "Defaults to the total step count of the procedure.",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["completed", "steps_executed", "step_results"] as const,
    properties: {
      completed: {
        type: "boolean",
        description: "True when all steps executed without divergence.",
      },
      steps_executed: {
        type: "integer",
        minimum: 0,
        description: "Number of steps attempted (including the diverging step if any).",
      },
      step_results: {
        type: "array",
        items: stepResultSchema,
        description: "Per-step execution record in order.",
      },
      final_step: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          observed_effect: pageEffectSchema,
          expected_effect: { type: "object", additionalProperties: true },
          divergence: { type: "string" },
        },
        description: "Summary of the last executed step.",
      },
      divergence: {
        type: "object",
        additionalProperties: false,
        required: ["step_id", "step_index", "reason"] as const,
        properties: {
          step_id: { type: "string" },
          step_index: { type: "integer", minimum: 0 },
          reason: { type: "string" },
          observed: pageEffectSchema,
          expected: { type: "object", additionalProperties: true },
        },
        description: "Present only when completed is false and a step diverged.",
      },
    },
  },
  action_weight: 1,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...PROC_CODES,
    "EXTENSION_DISCONNECTED",
    "RATE_LIMITED",
    "RISKY_ACTION_DENIED",
    "TAB_NOT_FOUND",
    "REF_STALE",
    "REF_NOT_FOUND",
  ] as const,
} as const;


// ---------------------------------------------------------------------------
// Cross-agent memory tools (feature: "memory")
//
// Memories are markdown files under ~/browserops/memory/, with a small
// YAML frontmatter block carrying name/description/type/source/timestamps.
// Every MCP client (Claude Code, Cursor, Zed, custom SDK) sees the same
// store, so a lesson learned in one session can be reused in another.
// ---------------------------------------------------------------------------

const memoryNamePattern = "^[a-z][a-z0-9._-]{0,79}$";
const memoryTypeEnum = ["user", "feedback", "project", "reference"] as const;

const memoryFrontmatterSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "type", "source", "created", "updated"] as const,
  properties: {
    name: { type: "string", pattern: memoryNamePattern },
    description: { type: "string", minLength: 1, maxLength: 500 },
    type: { enum: memoryTypeEnum },
    source: { enum: ["mcp-tool", "cli"] as const },
    created: { type: "string" },
    updated: { type: "string" },
  },
} as const;

const memorySearchMatchSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "type", "score", "snippet"] as const,
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    type: { enum: memoryTypeEnum },
    score: { type: "number", minimum: 0, maximum: 1 },
    snippet: { type: "string" },
  },
} as const;

const memorySave: ToolDef = {
  name: "memory_save",
  feature: "memory",
  description:
    "Persist a markdown memory under ~/browserops/memory/<name>.md, visible to every MCP client. " +
    "Use this when you want a lesson, preference, or context to outlive the current session and " +
    "be reachable from a different agent (e.g. a Cursor session) later. By default duplicate names " +
    "are rejected with MEMORY_ALREADY_EXISTS — set replace:true to overwrite. " +
    "type categorises the memory (user|feedback|project|reference) so memory_search can filter. " +
    'REQUIRED ARGUMENTS: {"name": "<id>", "description": "<one-liner>", "type": "<category>", "body": "<markdown>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "description", "type", "body"] as const,
    properties: {
      name: {
        type: "string",
        pattern: memoryNamePattern,
        description:
          "Stable identifier, e.g. \"feedback_terse_responses\" or \"project_q2_migration\". Lowercase, dot/underscore/hyphen separators.",
      },
      description: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description:
          "One-line summary used by memory_search to decide relevance. Be specific — vague descriptions don't surface in searches.",
      },
      type: {
        enum: memoryTypeEnum,
        description:
          "Category. user = facts about the human, feedback = how-to-collaborate corrections, project = ongoing-work context, reference = pointers to external systems.",
      },
      body: {
        type: "string",
        minLength: 1,
        maxLength: 65536,
        description: "Full markdown body of the memory.",
      },
      replace: {
        type: "boolean",
        default: false,
        description:
          "When true, overwrite an existing memory with the same name. Default false rejects duplicates with MEMORY_ALREADY_EXISTS.",
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
        description: "True when a new memory was created, false when an existing one was overwritten.",
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
    "Coverage-based search over the cross-agent memory store. Returns ranked metadata-only matches " +
    "(name + description + type + score + body snippet) — fetch the full body with memory_get. " +
    "Score is the fraction of distinct query tokens that appear anywhere in the entry's name, " +
    "description, type, or body. Tie-break favours name and description matches over body matches. " +
    "Pass type to filter by category. " +
    'REQUIRED ARGUMENTS: {"query": "<search tokens>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"] as const,
    properties: {
      query: { type: "string", minLength: 1, maxLength: 200 },
      type: {
        enum: memoryTypeEnum,
        description: "If set, only return memories whose type matches.",
      },
      limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      min_score: {
        type: "number",
        minimum: 0,
        maximum: 1,
        default: 0.2,
        description:
          "Minimum coverage ratio (matched query tokens / total query tokens). Default 0.2.",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["matches", "total", "truncated"] as const,
    properties: {
      matches: { type: "array", items: memorySearchMatchSchema },
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
    "Retrieve the full body and frontmatter for a single memory by name. " +
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
    required: ["meta", "body", "path"] as const,
    properties: {
      meta: memoryFrontmatterSchema,
      body: { type: "string" },
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
    "Remove a memory from the store by name. " +
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
  memorySave,
  memorySearch,
  memoryGet,
  memoryDelete,
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
