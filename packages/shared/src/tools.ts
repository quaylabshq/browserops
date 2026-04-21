import type { ErrorCode } from "./errors.js";

/**
 * Minimal structural representation of a JSON Schema draft 2020-12 object
 * sufficient for describing v1 browser.* tool params and results.
 * Authoritative schemas live in plans/04-tools.md.
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
// Shared schema fragments (plan 04 §4.2)
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
  items: { type: "string", enum: ["Control", "Alt", "Shift", "Meta"] as const },
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
// Error-code bundles (see plan 04 §4.3 and user spec)
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

// ---------------------------------------------------------------------------
// Tool definitions (plan 04 §4.3)
// ---------------------------------------------------------------------------

const listTabs: ToolDef = {
  name: "browser.list_tabs",
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
  name: "browser.current_tab",
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
  name: "browser.new_tab",
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
  name: "browser.close_tab",
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
  name: "browser.switch_tab",
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
  name: "browser.navigate",
  description: "Point the tab at a URL and optionally wait for page load.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "url"] as const,
    properties: {
      tab_id: tabIdSchema,
      url: urlSchema,
      wait_for_load: { type: "boolean", default: true },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["final_url"] as const,
    properties: {
      final_url: { type: "string" },
      status_code: { type: "integer", minimum: 100, maximum: 599 },
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
  name: "browser.back",
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
  name: "browser.forward",
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
  name: "browser.reload",
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
  name: "browser.screenshot",
  description: "Capture a PNG or JPEG of the tab and return it base64-encoded.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id"] as const,
    properties: {
      tab_id: tabIdSchema,
      full_page: { type: "boolean", default: false },
      format: { enum: ["png", "jpeg"] as const, default: "png" },
      quality: { type: "integer", minimum: 0, maximum: 100 },
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
  name: "browser.read",
  description:
    "Read structured page content in one of four modes (a11y_tree, markdown, sanitized_html, text). a11y_tree is the canonical source of refs.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "mode"] as const,
    properties: {
      tab_id: tabIdSchema,
      mode: { enum: ["a11y_tree", "markdown", "sanitized_html", "text"] as const },
      max_length: { type: "integer", minimum: 1024, maximum: 1048576, default: 131072 },
      viewport_only: { type: "boolean", default: false },
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
  name: "browser.click",
  description: "Click an element identified by ref.",
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
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["clicked"] as const,
    properties: {
      clicked: { const: true },
      navigated: { type: "boolean" },
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

const typeTool: ToolDef = {
  name: "browser.type",
  description:
    "Type text into an element identified by ref. Dispatches per-character CDP Input.dispatchKeyEvent so keydown listeners fire.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tab_id", "ref", "text"] as const,
    properties: {
      tab_id: tabIdSchema,
      ref: refSchema,
      text: { type: "string", maxLength: 32768 },
      submit: { type: "boolean", default: false },
      clear_first: { type: "boolean", default: false },
      delay_ms: { type: "integer", minimum: 0, maximum: 200, default: 0 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["typed"] as const,
    properties: {
      typed: { type: "integer", minimum: 0 },
      submitted: { type: "boolean" },
      navigated: { type: "boolean" },
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

const press: ToolDef = {
  name: "browser.press",
  description:
    "Send a keyboard-only chord to the tab (CDP key names). Does not target a specific ref.",
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
        items: { type: "string", minLength: 1, maxLength: 32 },
      },
      repeat: { type: "integer", minimum: 1, maximum: 20, default: 1 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pressed"] as const,
    properties: {
      pressed: { const: true },
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
  name: "browser.scroll",
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
  name: "browser.hover",
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

const waitFor: ToolDef = {
  name: "browser.wait_for",
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

const executeJs: ToolDef = {
  name: "browser.execute_js",
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
  click,
  typeTool,
  press,
  scroll,
  hover,
  waitFor,
  executeJs,
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
