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
      gated_domain: { type: "boolean", const: true, description: "Set to true when the destination URL matches a gated domain. Indicates the agent should prefer browser_execute_js for follow-up interactions on this tab." },
      gated_domain_directive: { type: "string", description: "Human-readable rule the agent should honor when `gated_domain` is true." },
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
  description: "Point the tab at a URL and optionally wait for page load. Returns page_effect when observe_effects is on, warnings? when expect_effect mismatches.",
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
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["final_url"] as const,
    properties: {
      final_url: { type: "string" },
      // status_code is not populated in the DOM-only v1 path: without a CDP
      // attach we cannot observe the HTTP response code for the navigation.
      // Deferred to v2.
      page_effect: pageEffectSchema,
      warnings: warningsOutputSchema,
      gated_domain: { type: "boolean", const: true, description: "Set to true when the destination URL matches a gated domain. Indicates the agent should prefer browser_execute_js for follow-up interactions on this tab." },
      gated_domain_directive: { type: "string", description: "Human-readable rule the agent should honor when `gated_domain` is true." },
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
  description: "Go back one step in the tab's history.",
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
  description: "Go forward one step in the tab's history.",
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
  description: "Reload the current page.",
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
          "Map from ref integer (as string key) to a minimal element summary. Populated only when mode == 'a11y_tree'.",
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
    "Click an element identified by ref. Fires pointer/mouse events on the element. Returns `{clicked, page_effect?, warnings?}`. On gated domains (`gated_domain: true` on navigate / current_tab — Gmail, Slack, Notion, Linear, Discord, …), prefer `browser_execute_js`. Synthetic dispatch on these sites frequently no-ops on rich editors and virtualized DOM; the bridge will warn or escalate to an error when no `page_effect` is observed.",
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
      dismiss_overlay: {
        description:
          "If the click is occluded (an overlay/scrim intercepted it), try to dismiss the overlay (ESC, then a close-button hunt) and retry once. Off by default — on sites where the overlay IS the content, auto-dismiss would be wrong. Mutually exclusive with auto_dismiss.",
        type: "boolean",
        default: false,
      },
      auto_dismiss: {
        description:
          "Smarter overlay dismissal: classifies the occluder (dialog, banner, toast, consent) and tries multiple strategies in order (ESC, close button hunt up to 5 ancestor levels, backdrop click). Reports what was dismissed. Mutually exclusive with dismiss_overlay.",
        type: "boolean",
        default: false,
      },
      observe_effects: observeEffectsInputSchema,
      expect_effect: expectEffectInputSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["clicked"] as const,
    properties: {
      clicked: { const: true },
      navigated: { type: "boolean" },
      // Set when dismiss_overlay was on and the initial click was occluded;
      // indicates the overlay was dismissed and the click retried.
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
    "Click at viewport coordinates (x, y) — no ref required. Escape hatch for canvas, maps, games, and anything the a11y walker can't address.",
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
    "Click the visible element whose accessible name matches the given text. Bypasses the a11y-tree ref mechanism — use this when browser_read didn't surface the element as a ref (common on SPA sites with div-wrapped click handlers), or when the agent knows the exact button label and doesn't want to pay for a full read first. Typically called from an operator sub-agent. On gated domains (`gated_domain: true` on navigate / current_tab — Gmail, Slack, Notion, Linear, Discord, …), prefer `browser_execute_js`. Synthetic dispatch on these sites frequently no-ops on rich editors and virtualized DOM; the bridge will warn or escalate to an error when no `page_effect` is observed.",
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
    "Type text into an element identified by ref. Two dispatch modes: 'keystroke' (default for short text, fires per-character keydown/beforeinput/input/keyup — what autocompletes and per-keystroke validators need), 'paste' (bulk-assign the value in one shot, use for long text where per-char events are wasteful). Default resolves to 'keystroke' for text <=64 chars, 'paste' otherwise. Returns `{typed, mode, page_effect?, warnings?}`. On gated domains (`gated_domain: true` on navigate / current_tab — Gmail, Slack, Notion, Linear, Discord, …), prefer `browser_execute_js`. Synthetic dispatch on these sites frequently no-ops on rich editors and virtualized DOM; the bridge will warn or escalate to an error when no `page_effect` is observed.",
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
      clear_first: {
        type: "boolean",
        default: false,
        description:
          "Shorthand for clear_mode: 'auto'. When true, the field is cleared before typing. Prefer clear_mode for explicit control; leaving clear_first at its default plus setting clear_mode is the forward-compatible pattern.",
      },
      clear_mode: {
        description:
          "How to clear the field before typing when clear_first (or clear_mode itself) is set. 'value' assigns el.value='' — fastest, but silently skips contenteditable editors (Gmail body, Notion, Slack). 'select_all' uses a range/.select()+delete path with a keyboard-fallback — works on contenteditable. 'auto' (default when clearing) picks 'value' for form inputs and 'select_all' for contenteditable, then verifies the field is empty and retries with select_all+keyboard-delete if not.",
        enum: ["value", "select_all", "auto"] as const,
      },
      delay_ms: { type: "integer", minimum: 0, maximum: 200, default: 0 },
      observe_effects: observeEffectsInputSchema,
      expect_effect: expectEffectInputSchema,
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
        description: "True when the field was cleared before typing (clear_first or clear_mode was set).",
      },
      page_effect: pageEffectSchema,
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
    "Replace a substring inside an editable element without clearing the whole field. Works on <input>, <textarea>, and contenteditable. Target resolves to `ref` if given, otherwise document.activeElement. Dispatches via beforeinput + execCommand insertText + Range fallback.",
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
    "Send a keyboard-only chord to the tab (CDP key names). Does not target a specific ref. Leading entries are treated as modifiers and the final entry as the key — e.g. [\"Primary\",\"KeyA\"] sends select-all. Use `Primary` instead of Meta/Control for portable chords; the extension resolves it to Meta on macOS and Control elsewhere at dispatch time. Returns `{pressed, page_effect?, warnings?}`. On gated domains (`gated_domain: true` on navigate / current_tab — Gmail, Slack, Notion, Linear, Discord, …), prefer `browser_execute_js`. Synthetic dispatch on these sites frequently no-ops on rich editors and virtualized DOM; the bridge will warn or escalate to an error when no `page_effect` is observed.",
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
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pressed"] as const,
    properties: {
      pressed: { const: true },
      page_effect: pageEffectSchema,
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
    "Move the synthetic mouse over an element identified by ref (fires CSS :hover and pointer events).",
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
    required: ["hovered"] as const,
    properties: {
      hovered: { const: true },
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
    "Execute JavaScript inside the tab's main world. Always risky; gated on every invocation. Preferred path on gated domains where synthetic dispatch is unreliable. CDP is auto-attached on those domains so trusted-input semantics apply.",
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
    "When enabled, all input dispatch (click, type, press) routes through trusted CDP " +
    "events instead of synthetic DOM events. Required for canvas apps (Figma, Google Docs, " +
    "Sheets, Canva, Miro) that ignore untrusted events. Call after navigating to the site. " +
    "Shows a 'controlled by automated software' banner while active. CDP is auto-attached on canvas domains and on gated domains (when the `gated-domains` feature is enabled). This tool is for manual override on other sites.",
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

const proceduresList: ToolDef = {
  name: "procedures_list",
  feature: "procedures",
  description:
    "List all stored procedures as metadata-only entries (no YAML bodies). " +
    "Scope to a specific domain or composite procedure. " +
    "Use procedures_get to retrieve a full YAML body.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: {
        type: "string",
        pattern: scopePattern,
        default: "all",
      },
      domain: {
        type: "string",
        pattern: domainPattern,
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tree"] as const,
    properties: {
      tree: {
        type: "object",
        additionalProperties: false,
        required: ["shared", "composites"] as const,
        properties: {
          shared: { type: "array", items: entrySchema },
          composites: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                composite: entrySchema,
                subs: { type: "array", items: entrySchema },
              },
            },
          },
        },
      },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...PROC_CODES] as const,
} as const;

const proceduresSearch: ToolDef = {
  name: "procedures_search",
  feature: "procedures",
  description:
    "Full-text search over the procedure catalogue using pre-tokenized index fields. " +
    "Returns ranked metadata-only matches; retrieve the YAML body with procedures_get. " +
    'REQUIRED ARGUMENTS: {"query": "<search tokens>"}. Example: {"query": "github sign in"}.',
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
      deep: {
        type: "boolean",
        default: false,
        description: "When true, also scores tokens from step bodies (slower).",
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
        required: ["version", "created", "last_verified", "success_count", "failure_count"] as const,
        properties: {
          version: { type: "integer" },
          created: { type: "string" },
          last_verified: { type: "string" },
          success_count: { type: "integer" },
          failure_count: { type: "integer" },
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

const proceduresPromote: ToolDef = {
  name: "procedures_promote",
  feature: "procedures",
  description:
    "Move a sub-procedure from a composite's subs/ folder into the top-level shared/ folder, " +
    "making it independently reusable. Rebuilds the index and rewrites any affected uses: references. " +
    'REQUIRED ARGUMENTS: {"name": "<sub-procedure name>", "from_owner": "<composite name>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "from_owner"] as const,
    properties: {
      name: { type: "string", pattern: procedureNamePattern },
      from_owner: { type: "string", pattern: procedureNamePattern },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["promoted", "old_path", "new_path", "rewrote"] as const,
    properties: {
      promoted: { const: true },
      old_path: { type: "string" },
      new_path: { type: "string" },
      rewrote: { type: "array", items: { type: "string" } },
    },
  },
  action_weight: 0.5,
  risky: "never",
  errorCodes: [...BASE_CODES, ...PROC_CODES] as const,
} as const;

const proceduresCompile: ToolDef = {
  name: "procedures_compile",
  feature: "procedures",
  description:
    "Compile a JSONL trace file into a draft procedure YAML. " +
    "Reads the trace, drops read-only and failed-call events, and emits one step per " +
    "remaining tool call with a loose expected_effect clause derived from observed page_effect. " +
    "Returns the YAML as a string for review — never auto-saved. " +
    "Caller can review and persist via procedures_save.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["trace_path", "out_name"] as const,
    properties: {
      trace_path: {
        type: "string",
        description: "Absolute path to a .jsonl trace file produced by browserops tracing.",
        minLength: 1,
        maxLength: 4096,
      },
      out_name: {
        type: "string",
        pattern: "^[a-z][a-z0-9_.-]{0,79}$",
        description: "Dot-delimited procedure name for the compiled output (e.g. 'slack.search_messages').",
      },
      skip_tools: {
        type: "array",
        items: { type: "string" },
        description:
          "Additional tool names to exclude from the compiled procedure (beyond the default read-only skip list).",
        maxItems: 50,
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["yaml", "warnings"] as const,
    properties: {
      yaml: {
        type: "string",
        description: "The compiled YAML body as a string. Review and save via procedures_save.",
      },
      path: {
        type: "string",
        description: "Always absent — procedures_compile never auto-saves.",
      },
      warnings: {
        type: "array",
        items: { type: "string" },
        description: "Compile-time warnings (e.g. empty trace, filtered events).",
      },
    },
  },
  action_weight: 0,
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
// Teach mode — record / observe / distill user demonstrations
// ---------------------------------------------------------------------------

const teachStepDescription =
  "Each step is one of: " +
  "{ kind: 'click', target, button, modifiers, x?, y? }, " +
  "{ kind: 'type', target, value, redacted, redaction_reason? }, " +
  "{ kind: 'key', keys, target? }, " +
  "{ kind: 'navigate', url, transition? }, " +
  "{ kind: 'scroll', target?, delta_y }, " +
  "{ kind: 'narration', text }, " +
  "{ kind: 'marker', label? }. " +
  "TeachTargetRef shape: { selector, role?, name?, text?, tag?, input_type?, contenteditable? }.";

const teachEventSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: true,
  required: ["session_id", "seq", "ts", "tab_id", "url", "step"] as const,
  properties: {
    session_id: { type: "string" },
    seq: { type: "integer", minimum: 1 },
    ts: { type: "integer", minimum: 0 },
    tab_id: { type: "string" },
    url: { type: "string" },
    step: { type: "object", additionalProperties: true },
  },
} as const;

const teachSessionMetaSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["session_id", "started_at", "scope", "event_count"] as const,
  properties: {
    session_id: { type: "string" },
    started_at: { type: "integer", minimum: 0 },
    stopped_at: { type: "integer", minimum: 0 },
    scope: { type: "string", enum: ["active_tab", "all_tabs"] as const },
    narration_hint: { type: "string" },
    event_count: { type: "integer", minimum: 0 },
  },
} as const;

const proceduresTeachStart: ToolDef = {
  name: "procedures_teach_start",
  feature: "teach",
  description:
    "Start a teach-mode session. The user demonstrates a flow in their real browser; the extension " +
    "records each click/type/key/navigate/scroll into a TeachEvent stream that the agent can read " +
    "live via procedures_teach_observe. Capture-time redaction strips passwords and known secret " +
    "patterns. Idempotent: returns the in-flight session if one is already active. " +
    'OPTIONAL ARGUMENTS: {"scope": "all_tabs"|"active_tab" (default all_tabs), "narration_hint": "<one-line description>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: { type: "string", enum: ["active_tab", "all_tabs"] as const, default: "all_tabs" },
      narration_hint: { type: "string", maxLength: 200 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "started_at", "resumed"] as const,
    properties: {
      session_id: { type: "string" },
      started_at: { type: "integer" },
      resumed: { type: "boolean", description: "true if returned an already-active session." },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, "EXTENSION_DISCONNECTED"] as const,
} as const;

const proceduresTeachStop: ToolDef = {
  name: "procedures_teach_stop",
  feature: "teach",
  description:
    "Stop the active teach-mode session and finalize its meta sidecar (sets stopped_at). After stop, " +
    "procedures_teach_observe returns finished: true once the cursor catches up. Errors with INVALID_STATE " +
    "if no session is active. Pass session_id only when stopping a specific known session — usually omitted.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      session_id: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "event_count", "duration_ms"] as const,
    properties: {
      session_id: { type: "string" },
      event_count: { type: "integer", minimum: 0 },
      duration_ms: { type: "integer", minimum: 0 },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, "INVALID_STATE", "EXTENSION_DISCONNECTED"] as const,
} as const;

const proceduresTeachObserve: ToolDef = {
  name: "procedures_teach_observe",
  feature: "teach",
  description:
    "Stream events from a teach session. Returns events with seq > since_seq up to max_batch. If no new " +
    "events are available and wait_ms > 0 and the session is still live, blocks up to wait_ms for the " +
    "next event. When finished: true, the session has stopped and you've consumed all events. " +
    teachStepDescription +
    ' REQUIRED: {"session_id": "ts_..."}. OPTIONAL: {"since_seq": 0, "wait_ms": 0..30000, "max_batch": 1..500}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id"] as const,
    properties: {
      session_id: { type: "string" },
      since_seq: { type: "integer", minimum: 0, default: 0 },
      wait_ms: { type: "integer", minimum: 0, maximum: 30000, default: 0 },
      max_batch: { type: "integer", minimum: 1, maximum: 500, default: 200 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["events", "next_seq", "finished"] as const,
    properties: {
      events: { type: "array", items: teachEventSchema },
      next_seq: { type: "integer", minimum: 0 },
      finished: { type: "boolean" },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES] as const,
} as const;

const proceduresTeachList: ToolDef = {
  name: "procedures_teach_list",
  feature: "teach",
  description:
    "List known teach sessions on disk, newest first. Useful after the user demonstrates a flow but " +
    "the agent doesn't know the session_id (e.g., session was started from the popup, not over MCP).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sessions"] as const,
    properties: {
      sessions: { type: "array", items: teachSessionMetaSchema },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES] as const,
} as const;

const proceduresTeachMarker: ToolDef = {
  name: "procedures_teach_marker",
  feature: "teach",
  description:
    "Insert a synthetic split marker into the active teach session. The distiller treats markers as " +
    "hard leaf boundaries — use this when you want to force a split between two sub-flows the user is " +
    'demonstrating in one session. OPTIONAL: {"label": "<short hint about what just ended>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      label: { type: "string", maxLength: 80 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["ok"] as const,
    properties: { ok: { const: true } },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, "INVALID_STATE", "EXTENSION_DISCONNECTED"] as const,
} as const;

const proceduresTeachDistill: ToolDef = {
  name: "procedures_teach_distill",
  feature: "teach",
  description:
    "Convert a recorded teach session into one or more draft procedure YAMLs. Splits the timeline into " +
    "leaves on user markers, tab change, URL host change, idle gap > 4s, and form-submit events; emits a " +
    "composite that uses each leaf in order when there is more than one. Redacted typing always becomes a " +
    "required input; non-redacted typing matching email or URL patterns is auto-parameterised; everything " +
    "else is surfaced as a parameter_candidate the agent can choose to lift. Save each procedure with " +
    "procedures_save AFTER replaying it — leaves first, composite last. " +
    'REQUIRED: {"session_id": "ts_..."}. OPTIONAL: {"name", "description"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id"] as const,
    properties: {
      session_id: { type: "string" },
      name: { type: "string", pattern: procedureNamePattern },
      description: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["procedures", "warnings", "redacted_inputs", "parameter_candidates"] as const,
    properties: {
      procedures: {
        type: "array",
        description:
          "Leaves in execution order; composite (if any) is the last entry. " +
          "Save them in this order via procedures_save.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "kind", "yaml"] as const,
          properties: {
            name: { type: "string" },
            kind: { type: "string", enum: ["leaf", "composite"] as const },
            yaml: { type: "string" },
          },
        },
      },
      warnings: { type: "array", items: { type: "string" } },
      redacted_inputs: {
        type: "array",
        items: { type: "string" },
        description:
          "Names of inputs the runner must supply at execution time (created from redacted typing).",
      },
      parameter_candidates: {
        type: "array",
        description:
          "Typed values the distiller noticed that look like they should be procedure inputs. " +
          "Email and URL values are already auto_parameterized; other strings are surfaced for the " +
          "agent to lift manually if they're meant to vary across runs.",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "seq",
            "value",
            "suggested_name",
            "suggested_type",
            "auto_parameterized",
          ] as const,
          properties: {
            seq: { type: "integer", minimum: 1 },
            value: { type: "string" },
            suggested_name: { type: "string" },
            suggested_type: { type: "string", enum: ["string"] as const },
            auto_parameterized: { type: "boolean" },
            target_field_label: { type: "string" },
          },
        },
      },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, ...PROC_CODES] as const,
} as const;

const proceduresTeachNarration: ToolDef = {
  name: "procedures_teach_narration",
  feature: "teach",
  description:
    "Insert a narration step into the active teach session — free-text the agent (or the user, via the " +
    "popup) wants to attach to the timeline. The distiller uses narration to name leaves, suggest input " +
    'parameters, and document the flow. REQUIRED: {"text": "<short description>"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text"] as const,
    properties: {
      text: { type: "string", minLength: 1, maxLength: 400 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["ok"] as const,
    properties: { ok: { const: true } },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, "INVALID_STATE", "EXTENSION_DISCONNECTED"] as const,
} as const;

// ---------------------------------------------------------------------------
// Auto-teach — bootstrap a procedure from one user demo (or one cold-start
// exploration), then iteratively replay-and-optimize until convergence.
// ---------------------------------------------------------------------------

const autoteachConsentSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["budget", "side_effect_policy"] as const,
  properties: {
    dummies: {
      type: "object",
      additionalProperties: { type: ["string", "number", "boolean"] },
      description:
        "Map of input name → safe dummy value to thread through training " +
        "runs in place of any destructive input.",
    },
    budget: {
      oneOf: [
        { type: "integer", minimum: 1, maximum: 50 },
        { const: "convergence" },
      ],
      description:
        "Hard cap on optimization runs (after run 0), or 'convergence' to " +
        "let the loop stop on its own when the metrics stop improving.",
    },
    side_effect_policy: {
      enum: ["use_dummies", "pause_at_destructive", "read_only_only"] as const,
      description:
        "How the loop treats destructive leaves. use_dummies = replay with " +
        "dummies; pause_at_destructive = optimize leading non-destructive " +
        "leaves only and run destructive leaf once on finalize; " +
        "read_only_only = refuse session if any leaf has side_effects.",
    },
  },
};

const autoteachOptimizationSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: true,
  required: ["kind"] as const,
  properties: {
    kind: {
      enum: [
        "drop_dead_read",
        "cache_selector",
        "lift_to_bind",
        "tighten_wait",
        "swap_to_execute_js",
        "split_leaf",
        "reuse_existing",
      ] as const,
    },
    step_id: { type: "string" },
    new_tier: { type: "string" },
    new_selector: { type: "string" },
    input_name: { type: "string" },
    source_step_id: { type: "string" },
    new_timeout_ms: { type: "integer", minimum: 0 },
    at_step_id: { type: "string" },
    reason: { type: "string" },
    leaf_name: { type: "string" },
    replacement_name: { type: "string" },
  },
};

const autoteachSessionSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: true,
  required: [
    "session_id",
    "goal",
    "mode",
    "consent",
    "state",
    "draft_version",
    "created_at",
  ] as const,
  properties: {
    session_id: { type: "string" },
    goal: { type: "string" },
    mode: { enum: ["demo", "explore"] as const },
    consent: autoteachConsentSchema,
    state: {
      enum: [
        "consenting",
        "capturing_demo",
        "exploring",
        "distilled",
        "optimizing",
        "finalizing",
        "converged",
        "stalled",
        "aborted",
      ] as const,
    },
    teach_session_id: { type: "string" },
    attached_tab_id: { type: "string" },
    best_procedure_name: { type: "string" },
    draft_version: { type: "integer", minimum: 0 },
    created_at: { type: "integer", minimum: 0 },
    last_run_at: { type: "integer", minimum: 0 },
  },
};

const autoteachRunSchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: true,
  required: [
    "run_id",
    "run_index",
    "started_at",
    "tool_count",
    "wall_clock_ms",
    "retries",
    "errors",
    "outcome",
    "trace_ref",
  ] as const,
  properties: {
    run_id: { type: "string" },
    run_index: { type: "integer", minimum: 0 },
    started_at: { type: "integer" },
    ended_at: { type: "integer" },
    tool_count: { type: "integer", minimum: 0 },
    wall_clock_ms: { type: "integer", minimum: 0 },
    retries: { type: "integer", minimum: 0 },
    errors: { type: "array", items: { type: "string" } },
    optimization_tried: autoteachOptimizationSchema,
    outcome: { enum: ["improved", "regressed", "noop", "failed"] as const },
    trace_ref: { type: "string" },
  },
};

const autoteachLeafSummarySchema: JSONSchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["name", "draft_status", "side_effects", "fragility"] as const,
  properties: {
    name: { type: "string" },
    draft_status: { enum: ["draft", "trusted", "missing"] as const },
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
    },
    fragility: { enum: ["low", "medium", "high"] as const },
  },
};

const proceduresAutoteachStart: ToolDef = {
  name: "procedures_autoteach_start",
  feature: "autoteach",
  description:
    "Open an auto-teach session. Stores the user's goal + consent (mode, " +
    "side-effect policy, dummy values, run budget) so the rest of the " +
    "loop can reference one session_id. Mode 'demo' will additionally " +
    "kick off a procedures_teach_start internally and return its " +
    "teach_session_id; mode 'explore' returns no teach_session_id and " +
    "expects the agent to call procedures_autoteach_attach + drive the " +
    "browser itself for run 0. " +
    "OPTIONAL: pass session_name to label the tab group (so the user " +
    "can tell at a glance which Chrome tabs belong to this loop), and " +
    "start_url to have the bridge open + claim a fresh tab there before " +
    "the demo (defaults true when start_url is set; binds tab to " +
    "run_index 0 automatically). " +
    'REQUIRED: {"goal", "mode", "consent"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["goal", "mode", "consent"] as const,
    properties: {
      goal: { type: "string", minLength: 1, maxLength: 400 },
      mode: { enum: ["demo", "explore"] as const },
      consent: autoteachConsentSchema,
      narration_hint: { type: "string", maxLength: 200 },
      session_name: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description:
          "Label applied to the Chrome tab group for this MCP session " +
          "via browser_set_session_name. Helps the user identify which " +
          "tabs belong to the auto-teach loop.",
      },
      start_url: {
        type: "string",
        format: "uri",
        maxLength: 4096,
        description:
          "URL the bridge opens + claims into the calling session before " +
          "the demo. The new tab is bound to run_index 0 automatically " +
          "so the user demonstrates in a tab the agent can see.",
      },
      acquire_tab: {
        type: "boolean",
        description:
          "Force tab acquisition even without start_url (opens about:blank). " +
          "Defaults true when start_url is set, false otherwise.",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "state"] as const,
    properties: {
      session_id: { type: "string" },
      teach_session_id: { type: "string" },
      state: { type: "string" },
      tab_id: {
        type: "string",
        description:
          "Set when the bridge acquired a tab (start_url or acquire_tab). " +
          "Already attached to run_index 0 — the agent does not need to " +
          "call procedures_autoteach_attach for run 0.",
      },
      session_name: {
        type: "string",
        description: "The canonical session name set on the tab group, when applied.",
      },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, "INVALID_STATE", "EXTENSION_DISCONNECTED"] as const,
} as const;

const proceduresAutoteachAttach: ToolDef = {
  name: "procedures_autoteach_attach",
  feature: "autoteach",
  description:
    "Tag a tab so every browser_* call dispatched on it is appended to " +
    "this session's trace.jsonl with the current run_index. Used in " +
    "explore mode to capture the agent's run 0, and in every replay run " +
    "to capture the optimization run. Idempotent — re-attaching the " +
    "same tab is a no-op; attaching a different tab replaces the " +
    "previous binding for this session. " +
    'REQUIRED: {"session_id", "tab_id", "run_index"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "tab_id", "run_index"] as const,
    properties: {
      session_id: { type: "string" },
      tab_id: tabIdSchema,
      run_index: { type: "integer", minimum: 0 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["attached"] as const,
    properties: {
      attached: { const: true },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, "PROC_NOT_FOUND", "INVALID_STATE"] as const,
} as const;

const proceduresAutoteachRecordTrace: ToolDef = {
  name: "procedures_autoteach_record_trace",
  feature: "autoteach",
  description:
    "Close the trace window for a given run and return its records. " +
    "After the agent finishes a run (run 0 demo distillation, an " +
    "optimization replay, or the explore run), call this to detach " +
    "the tab + freeze the slice of trace.jsonl belonging to this " +
    "run_index. Returns nothing of substance to the agent — the " +
    "distiller reads the trace itself. " +
    'REQUIRED: {"session_id", "run_index"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "run_index"] as const,
    properties: {
      session_id: { type: "string" },
      run_index: { type: "integer", minimum: 0 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["record_count"] as const,
    properties: {
      record_count: { type: "integer", minimum: 0 },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, "PROC_NOT_FOUND"] as const,
} as const;

const proceduresAutoteachDistill: ToolDef = {
  name: "procedures_autoteach_distill",
  feature: "autoteach",
  description:
    "Run the auto-teach distiller over a given run's trace and emit " +
    "draft procedure YAMLs. The distiller drops dead reads, collapses " +
    "retries, lifts dynamic values to bind references, sets wait_for " +
    "timeouts from observed durations, splits leaves at UI-state " +
    "transitions, runs reuse-detection against the existing procedure " +
    "store, classifies side effects, and scores fragility. Default " +
    "run_index is the latest one recorded. Drafts are written to " +
    "drafts/v<N>.yaml in the session directory and the latest draft " +
    "becomes the new best for the next replay. " +
    'REQUIRED: {"session_id"}. OPTIONAL: {"run_index"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id"] as const,
    properties: {
      session_id: { type: "string" },
      run_index: { type: "integer", minimum: 0 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["draft_version", "leaves", "composite_name", "validation_errors"] as const,
    properties: {
      draft_version: { type: "integer", minimum: 1 },
      composite_name: { type: ["string", "null"] },
      leaves: {
        type: "array",
        items: autoteachLeafSummarySchema,
      },
      yaml: {
        type: "string",
        description:
          "The full composite + leaves YAML for the new draft (concatenated, --- separated).",
      },
      validation_errors: {
        type: "array",
        items: { type: "string" },
        description:
          "If non-empty, the distiller emitted but flagged issues — the " +
          "skill should ask the user before continuing.",
      },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, "PROC_NOT_FOUND", "PROC_SCHEMA_INVALID"] as const,
} as const;

const proceduresAutoteachRecordRun: ToolDef = {
  name: "procedures_autoteach_record_run",
  feature: "autoteach",
  description:
    "Append run metrics to runs.jsonl and compute the run's outcome " +
    "(improved | regressed | noop | failed) vs the prior best. Outcome " +
    "drives the convergence detector and the next-optimization picker. " +
    "If outcome === 'regressed', the skill should revert the " +
    "optimization tried this run before the next replay. " +
    'REQUIRED: {"session_id", "run_index", "metrics"}. ' +
    'OPTIONAL: {"optimization_tried"} (echoed back into the run record).',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id", "run_index", "metrics"] as const,
    properties: {
      session_id: { type: "string" },
      run_index: { type: "integer", minimum: 0 },
      metrics: {
        type: "object",
        additionalProperties: false,
        required: ["tool_count", "wall_clock_ms"] as const,
        properties: {
          tool_count: { type: "integer", minimum: 0 },
          wall_clock_ms: { type: "integer", minimum: 0 },
          retries: { type: "integer", minimum: 0, default: 0 },
          errors: {
            type: "array",
            items: { type: "string" },
            default: [],
          },
          succeeded: { type: "boolean", default: true },
        },
      },
      optimization_tried: autoteachOptimizationSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["outcome", "delta"] as const,
    properties: {
      outcome: { enum: ["improved", "regressed", "noop", "failed"] as const },
      delta: {
        type: "object",
        additionalProperties: false,
        required: ["tool_count", "wall_clock_ms"] as const,
        properties: {
          tool_count: { type: "integer" },
          wall_clock_ms: { type: "integer" },
        },
      },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, "PROC_NOT_FOUND"] as const,
} as const;

const proceduresAutoteachStatus: ToolDef = {
  name: "procedures_autoteach_status",
  feature: "autoteach",
  description:
    "Return the session metadata, run history, current best draft, " +
    "convergence verdict (converged | stalled | improving), and the " +
    "next optimization the loop should try (when verdict is " +
    "'improving'). The agent loop calls this between every replay to " +
    "decide whether to keep going. " +
    'REQUIRED: {"session_id"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id"] as const,
    properties: {
      session_id: { type: "string" },
      include_yaml: {
        type: "boolean",
        default: true,
        description: "Set false to skip embedding the current best YAML.",
      },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session", "history", "convergence", "leaves"] as const,
    properties: {
      session: autoteachSessionSchema,
      history: {
        type: "array",
        items: autoteachRunSchema,
      },
      best_procedure_yaml: { type: "string" },
      convergence: {
        type: "object",
        additionalProperties: false,
        required: ["verdict", "reasons"] as const,
        properties: {
          verdict: { enum: ["converged", "stalled", "improving"] as const },
          reasons: { type: "array", items: { type: "string" } },
        },
      },
      next_optimization: autoteachOptimizationSchema,
      leaves: {
        type: "array",
        items: autoteachLeafSummarySchema,
      },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, "PROC_NOT_FOUND"] as const,
} as const;

const proceduresAutoteachFinalize: ToolDef = {
  name: "procedures_autoteach_finalize",
  feature: "autoteach",
  description:
    "Promote the current best draft to a trusted procedure. Runs the " +
    "replay-variance gate first: each leaf is replayed under perturbed " +
    "starting conditions (fresh tab, varied input where applicable, " +
    "different starting URL) — every variant must succeed for the leaf " +
    "to promote. Side-effecting leaves run once with real values when " +
    "side_effect_policy === 'pause_at_destructive'. Force=true skips " +
    "the gate at the caller's risk. Writes leaves first, then the " +
    "composite, mirroring procedures_save semantics. " +
    'REQUIRED: {"session_id"}. OPTIONAL: {"force"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id"] as const,
    properties: {
      session_id: { type: "string" },
      force: { type: "boolean", default: false },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["saved", "failed"] as const,
    properties: {
      saved: {
        type: "array",
        items: { type: "string" },
        description: "Names of procedures successfully promoted to trusted.",
      },
      failed: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "reason"] as const,
          properties: {
            name: { type: "string" },
            reason: { type: "string" },
          },
        },
      },
    },
  },
  action_weight: 0,
  risky: "conditional",
  errorCodes: [
    ...BASE_CODES,
    ...PROC_CODES,
    "RISKY_ACTION_DENIED",
    "EXTENSION_DISCONNECTED",
  ] as const,
} as const;

const proceduresAutoteachList: ToolDef = {
  name: "procedures_autoteach_list",
  feature: "autoteach",
  description:
    "List known auto-teach sessions on disk, newest first. Useful when " +
    "the user resumes a long-running auto-teach across conversations.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sessions"] as const,
    properties: {
      sessions: { type: "array", items: autoteachSessionSchema },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES] as const,
} as const;

const proceduresAutoteachResume: ToolDef = {
  name: "procedures_autoteach_resume",
  feature: "autoteach",
  description:
    "Reload an existing auto-teach session by session_id. Returns the " +
    "same shape as procedures_autoteach_status so a fresh conversation " +
    "can pick up where the previous one left off. " +
    'REQUIRED: {"session_id"}.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id"] as const,
    properties: {
      session_id: { type: "string" },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session", "history", "convergence", "leaves"] as const,
    properties: {
      session: autoteachSessionSchema,
      history: { type: "array", items: autoteachRunSchema },
      best_procedure_yaml: { type: "string" },
      convergence: {
        type: "object",
        additionalProperties: false,
        required: ["verdict", "reasons"] as const,
        properties: {
          verdict: { enum: ["converged", "stalled", "improving"] as const },
          reasons: { type: "array", items: { type: "string" } },
        },
      },
      next_optimization: autoteachOptimizationSchema,
      leaves: { type: "array", items: autoteachLeafSummarySchema },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, "PROC_NOT_FOUND"] as const,
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
  proceduresList,
  proceduresSearch,
  proceduresGet,
  proceduresSave,
  proceduresPromote,
  proceduresDelete,
  proceduresCompile,
  proceduresExecute,
  proceduresTeachStart,
  proceduresTeachStop,
  proceduresTeachObserve,
  proceduresTeachList,
  proceduresTeachMarker,
  proceduresTeachNarration,
  proceduresTeachDistill,
  proceduresAutoteachStart,
  proceduresAutoteachAttach,
  proceduresAutoteachRecordTrace,
  proceduresAutoteachDistill,
  proceduresAutoteachRecordRun,
  proceduresAutoteachStatus,
  proceduresAutoteachFinalize,
  proceduresAutoteachList,
  proceduresAutoteachResume,
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
