/**
 * Pure formatters that turn a `tool_use` block into a human "action row" for the
 * activity stream — an icon key, a verb, and a concise target derived from the
 * tool's input. No DOM, no side effects, so it unit-tests in plain Node.
 *
 * The stream foregrounds what the agent does to the page, so every browserops
 * tool maps to a legible `navigate mail.google.com` / `click Compose` line. An
 * unknown tool never renders blank — it falls back to a de-prefixed name.
 */
import type { ChatBlock } from "@browserops/shared";

export type ActionIcon =
  | "navigate"
  | "back"
  | "forward"
  | "tab"
  | "click"
  | "hover"
  | "type"
  | "press"
  | "read"
  | "camera"
  | "scroll"
  | "wait"
  | "code"
  | "procedure"
  | "search"
  | "locate"
  | "dot";

export interface ActionView {
  icon: ActionIcon;
  verb: string;
  /** Concise target, e.g. "mail.google.com", "Compose", "inbox". May be empty. */
  target: string;
  /** Risky tools (run JS, deletes) get a ⚠ marker in the row. */
  risky: boolean;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Hostname of a URL, falling back to the raw string when unparseable. */
export function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Collapse whitespace and clamp to `cap` chars with an ellipsis. */
export function truncate(s: string, cap = 44): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > cap ? flat.slice(0, cap - 1) + "…" : flat;
}

const keys = (v: unknown): string => (Array.isArray(v) ? v.map(String).join("+") : "");

interface Spec {
  icon: ActionIcon;
  verb: string;
  risky?: boolean;
  target?: (i: Record<string, unknown>) => string;
}

// Field names verified against packages/shared/src/tools.ts input schemas.
const SPECS: Record<string, Spec> = {
  browser_navigate: { icon: "navigate", verb: "navigate", target: (i) => host(str(i["url"])) },
  browser_back: { icon: "back", verb: "back" },
  browser_forward: { icon: "forward", verb: "forward" },
  browser_reload: { icon: "navigate", verb: "reload" },
  browser_new_tab: { icon: "tab", verb: "new tab", target: (i) => host(str(i["url"])) },
  browser_switch_tab: { icon: "tab", verb: "switch tab", target: (i) => str(i["tab_id"]) },
  browser_close_tab: { icon: "tab", verb: "close tab", target: (i) => str(i["tab_id"]) },
  browser_list_tabs: { icon: "tab", verb: "list tabs" },
  browser_current_tab: { icon: "tab", verb: "current tab" },
  browser_click: {
    icon: "click",
    verb: "click",
    target: (i) => truncate(str(i["text"]) || str(i["ref"])),
  },
  browser_click_at: {
    icon: "click",
    verb: "click",
    target: (i) => `${i["x"] ?? "?"},${i["y"] ?? "?"}`,
  },
  browser_click_by_text: { icon: "click", verb: "click", target: (i) => truncate(str(i["text"])) },
  browser_hover: { icon: "hover", verb: "hover", target: (i) => truncate(str(i["ref"])) },
  browser_type: { icon: "type", verb: "type", target: (i) => truncate(str(i["text"])) },
  browser_find_and_replace: {
    icon: "type",
    verb: "replace",
    target: (i) => truncate(str(i["find"])),
  },
  browser_press: { icon: "press", verb: "press", target: (i) => keys(i["keys"]) },
  browser_read: { icon: "read", verb: "read", target: (i) => str(i["scope"]) || "page" },
  browser_quick_read: { icon: "read", verb: "find", target: (i) => truncate(str(i["query"])) },
  browser_observe: { icon: "read", verb: "observe", target: (i) => str(i["scope"]) || "viewport" },
  browser_screenshot: { icon: "camera", verb: "screenshot", target: () => "viewport" },
  browser_scroll: { icon: "scroll", verb: "scroll", target: (i) => str(i["direction"]) },
  browser_wait_for: {
    icon: "wait",
    verb: "wait",
    target: (i) => truncate(str(i["text"]) || str(i["ref"])),
  },
  browser_wait_for_idle: { icon: "wait", verb: "wait", target: () => "idle" },
  browser_execute_js: {
    icon: "code",
    verb: "run JS",
    risky: true,
    target: (i) => truncate(str(i["code"]), 32),
  },
  browser_locate: {
    icon: "locate",
    verb: "locate",
    target: (i) => truncate(jsonish(i["locator"])),
  },
  browser_query_selector: {
    icon: "locate",
    verb: "select",
    target: (i) => truncate(str(i["selector"])),
  },
  procedures_execute: { icon: "procedure", verb: "run procedure", target: (i) => str(i["name"]) },
  procedures_search: {
    icon: "search",
    verb: "find procedure",
    target: (i) => truncate(str(i["query"])),
  },
  procedures_save: { icon: "procedure", verb: "save procedure", target: (i) => str(i["name"]) },
};

function jsonish(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return v === undefined ? "" : JSON.stringify(v);
  } catch {
    return "";
  }
}

/** Strip the mcp / family prefix so an unknown tool reads as a plain verb. */
function bareName(name: string): string {
  return name
    .replace(/^mcp__browserops__/, "")
    .replace(/^(browser|procedures|lore)_/, "")
    .replace(/_/g, " ");
}

export function formatAction(block: Extract<ChatBlock, { kind: "tool_use" }>): ActionView {
  const input = asRecord(block.input);
  const spec = SPECS[block.name];
  if (spec) {
    return {
      icon: spec.icon,
      verb: spec.verb,
      target: spec.target ? spec.target(input) : "",
      risky: spec.risky ?? false,
    };
  }
  const name = bareName(block.name);
  return {
    icon: "dot",
    verb: name || "tool",
    target: "",
    risky: /execute|delete|remove|kill/.test(name),
  };
}
