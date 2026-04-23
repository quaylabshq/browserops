import type { ErrorCode } from "./errors.js";

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
    window_ms: { type: "integer", minimum: 0 },
    truncated: { type: "boolean" },
  },
  required: ["dom", "url", "focus", "network", "window_ms"] as const,
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

const pinnedTab: ToolDef = {
  name: "browser_pinned_tab",
  description:
    "Return the user-selected \"home base\" tab (set via the extension popup \"Use this tab\" button). Call this FIRST when the user refers to \"this tab\" or is working on a specific page they already have open — thread the returned tab_id through the rest of the turn instead of opening a new tab. Errors with NO_PINNED_TAB if the user has not pinned one. Typically called from a navigator sub-agent.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "url", "title"] as const,
    properties: {
      tab_id: tabIdSchema,
      url: { type: "string" },
      title: { type: "string" },
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [...BASE_CODES, "NO_PINNED_TAB"] as const,
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
  description: "Point the tab at a URL and optionally wait for page load. Returns page_effect when observe_effects is on.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "url"] as const,
    properties: {
      tab_id: tabIdSchema,
      url: urlSchema,
      wait_for_load: { type: "boolean", default: true },
      observe_effects: observeEffectsInputSchema,
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
    "Capture a JPEG (default) or PNG of the tab and return it base64-encoded. Default is JPEG quality 40, downscaled so the longest edge is <= 1024 px, which typically yields 30-50k base64 chars. Set full_quality:true to bypass downscale and use quality 95; override max_dimension or quality individually for finer control.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
      full_page: { type: "boolean", default: false },
      format: { enum: ["png", "jpeg"] as const, default: "jpeg" },
      quality: { type: "integer", minimum: 0, maximum: 100, default: 40 },
      max_dimension: { type: "integer", minimum: 1, maximum: 8192, default: 1024 },
      full_quality: { type: "boolean", default: false },
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
    "Read structured page content in one of four modes (a11y_tree, markdown, sanitized_html, text). a11y_tree is the canonical source of refs. By default a11y_tree returns a compact tree dropping role='generic' / name-less nodes; pass verbose:true for the legacy full tree.",
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

const click: ToolDef = {
  name: "browser_click",
  description:
    "Click an element identified by ref. Two dispatch modes: 'synthetic' (default, DOM-only — fires pointer/mouse events in the page's main world; works on >90% of real pages), 'trusted' (CDP Input.dispatchMouseEvent — real trusted events; required for sites that gate on isTrusted like Cloudflare Turnstile, canvas widgets, and some e-commerce CAPTCHA layers). Trusted mode attaches chrome.debugger which briefly shows the \"being controlled by automation\" banner. On Tier 1 canvas apps (Figma, Google Docs, Canva, Miro, Whimsical, Figjam) the extension auto-escalates to trusted mode when the caller does not specify a mode. Returns `{clicked, mode_used, site?, page_effect?}`. `mode_used` is the dispatch mode that actually ran (may differ from requested `mode` after canvas-app auto-escalation). `site` is the matched hostname when a Tier 1 site triggered auto-escalation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "ref"] as const,
    properties: {
      tab_id: tabIdSchema,
      ref: refSchema,
      mode: {
        description:
          "Dispatch mode. Use 'trusted' only when synthetic has been observed to fail on the target.",
        enum: ["synthetic", "trusted"] as const,
        default: "synthetic",
      },
      button: { enum: ["left", "middle", "right"] as const, default: "left" },
      click_count: { type: "integer", minimum: 1, maximum: 3, default: 1 },
      modifiers: modifiersSchema,
      dismiss_overlay: {
        description:
          "If the click is occluded (an overlay/scrim intercepted it), try to dismiss the overlay (ESC, then a close-button hunt) and retry once. Off by default — on sites where the overlay IS the content, auto-dismiss would be wrong.",
        type: "boolean",
        default: false,
      },
      observe_effects: observeEffectsInputSchema,
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["clicked"] as const,
    properties: {
      clicked: { const: true },
      mode: { enum: ["synthetic", "trusted"] as const },
      // mode_used is the dispatch mode that actually ran (may differ from
      // requested mode after canvas-app auto-escalation).
      mode_used: { enum: ["synthetic", "trusted"] as const },
      // Present when a Tier 1 site hint triggered auto-escalation to trusted.
      site: { type: "string" },
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
      // True when the selector landed on a non-interactive descendant and
      // we walked up to the nearest interactive ancestor to dispatch on.
      retargeted: { type: "boolean" },
      page_effect: pageEffectSchema,
    },
  },
  action_weight: 1,
  risky: "conditional",
  // REF_CODES already includes CDP_ATTACH_FAILED — surfaced when mode=trusted
  // and chrome.debugger.attach fails (DevTools already open, another debugger).
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
    "Click at viewport coordinates (x, y) — no ref required. Escape hatch for canvas, maps, games, and anything the a11y walker can't address. Supports the same synthetic/trusted modes as browser_click.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "x", "y"] as const,
    properties: {
      tab_id: tabIdSchema,
      x: { type: "number", minimum: 0 },
      y: { type: "number", minimum: 0 },
      mode: {
        enum: ["synthetic", "trusted"] as const,
        default: "synthetic",
      },
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
      mode: { enum: ["synthetic", "trusted"] as const },
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
    "Click the visible element whose accessible name matches the given text. Bypasses the a11y-tree ref mechanism — use this when browser_read didn't surface the element as a ref (common on SPA sites with div-wrapped click handlers), or when the agent knows the exact button label and doesn't want to pay for a full read first. Typically called from an operator sub-agent.",
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
    "Type text into an element identified by ref. Three dispatch modes: 'keystroke' (default for short text, fires per-character keydown/beforeinput/input/keyup — what autocompletes and per-keystroke validators need), 'paste' (bulk-assign the value in one shot, use for long text where per-char events are wasteful), 'trusted' (CDP-backed real trusted events; requires debugger attach). Default resolves to 'keystroke' for text <=64 chars, 'paste' otherwise. Returns `{typed, mode, mode_used, editor?, site?, page_effect?}`. `mode_used` is the dispatch mode that actually ran (may differ from requested `mode` — on Quill/ProseMirror/Slate editors, trusted-mode typing auto-uses CDP `Input.insertText` to avoid double-insertion, reported as `mode_used: 'insertText'`). `editor` is present when a rich-text framework was detected. `site` is the matched hostname when the Tier 1 site registry fired.",
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
        enum: ["keystroke", "paste", "trusted"] as const,
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
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["typed"] as const,
    properties: {
      typed: { type: "integer", minimum: 0 },
      mode: { enum: ["keystroke", "paste", "trusted"] as const },
      // mode_used is the dispatch mode that actually ran after any framework
      // detection. On Quill/ProseMirror/Slate in trusted mode, this is
      // 'insertText' (CDP Input.insertText) rather than 'trusted' (per-char loop).
      mode_used: { type: "string" },
      // Present when a rich-text framework was detected and influenced dispatch.
      editor: { type: "string" },
      // Present when the Tier 1 site registry matched.
      site: { type: "string" },
      submitted: { type: "boolean" },
      navigated: { type: "boolean" },
      cleared: {
        type: "boolean",
        description: "True when the field was cleared before typing (clear_first or clear_mode was set).",
      },
      page_effect: pageEffectSchema,
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
    "Replace a substring inside an editable element without clearing the whole field. Works on <input>, <textarea>, and contenteditable. Target resolves to `ref` if given, otherwise document.activeElement. Two dispatch modes mirror browser_type: 'synthetic' (default; beforeinput + execCommand insertText + Range fallback) and 'trusted' (CDP Input.insertText; required on rich editors like Gmail/Notion/Slate that gate on isTrusted).",
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
      mode: { enum: ["synthetic", "trusted"] as const },
      case_sensitive: { type: "boolean", default: true },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["replaced"] as const,
    properties: {
      replaced: { type: "integer", minimum: 0 },
      mode: { enum: ["synthetic", "trusted"] as const },
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
    "Send a keyboard-only chord to the tab (CDP key names). Does not target a specific ref. Leading entries are treated as modifiers and the final entry as the key — e.g. [\"Primary\",\"KeyA\"] sends select-all. Use `Primary` instead of Meta/Control for portable chords; the extension resolves it to Meta on macOS and Control elsewhere at dispatch time. Returns `{pressed, dispatch, editor?, site?, page_effect?}`. `dispatch` is 'trusted' when CDP was used (Enter/Escape/Tab on Quill/ProseMirror/Slate), 'synthetic' otherwise. `editor` and `site` are present when the editor/site registry matched.",
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
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pressed"] as const,
    properties: {
      pressed: { const: true },
      // dispatch is the actual delivery path used for this key event.
      dispatch: { enum: ["synthetic", "trusted"] as const },
      // Present when a rich-text framework was detected and influenced dispatch.
      editor: { type: "string" },
      // Present when the Tier 1 site registry matched.
      site: { type: "string" },
      page_effect: pageEffectSchema,
    },
  },
  action_weight: 1,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    ...MUTATING_CODES,
    "CDP_ATTACH_FAILED",
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
    "Block until a ref, a text substring, or a URL pattern appears. Post-navigation/XHR synchronisation.",
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
    },
  },
  action_weight: 0,
  risky: "never",
  errorCodes: [
    ...BASE_CODES,
    ...TAB_CODES,
    "REF_STALE",
    "REF_NOT_FOUND",
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
    "Execute JavaScript inside the tab's main world. Always risky; gated on every invocation.",
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
  description:
    "Full-text search over the procedure catalogue using pre-tokenized index fields. " +
    "Returns ranked metadata-only matches; retrieve the YAML body with procedures_get. " +
    'REQUIRED ARGUMENTS: {"query": "<search tokens>"}. Example: {"query": "mem0 login"}.',
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

const proceduresDelete: ToolDef = {
  name: "procedures_delete",
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

// ---------------------------------------------------------------------------
// Public catalogue
// ---------------------------------------------------------------------------

export const TOOL_DEFS: readonly ToolDef[] = [
  listTabs,
  currentTab,
  pinnedTab,
  newTab,
  closeTab,
  switchTab,
  navigate,
  back,
  forward,
  reload,
  screenshot,
  read,
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
  proceduresList,
  proceduresSearch,
  proceduresGet,
  proceduresSave,
  proceduresPromote,
  proceduresDelete,
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
