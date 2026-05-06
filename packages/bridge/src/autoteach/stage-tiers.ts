/**
 * Distiller stage: assign selector_tier to each interactive IRStep.
 *
 * Tiers, most stable first:
 *   id         — addresses an element by `id` attribute or selector `#x`
 *   testid     — addresses an element by `data-testid`
 *   role_name  — uses role + accessible name (browser_click_by_text+role)
 *   text       — uses visible text only (browser_click_by_text without role)
 *   css        — generic CSS selector (e.g. `.btn-primary`)
 *   xpath      — xpath expression OR a brittle nth-child / sibling
 *                 chain — anything that depends on document order
 *
 * Steps that don't address an element (browser_navigate, browser_press,
 * browser_screenshot, browser_read with no query) get no tier.
 */
import type { IRStep, SelectorTier } from "./distiller-ir.js";

const ID_RE = /(^|\s|\[|>)#[a-zA-Z][\w-]*\b/;
const TESTID_RE = /\[data-testid[~|^$*]?=/i;
const NTH_RE = /:nth-child\(|:nth-of-type\(|:first-child|:last-child|>\s*\*:/i;
const XPATH_RE = /^\(?\.?\/\/|^xpath:/;

export function assignTiers(steps: IRStep[]): IRStep[] {
  return steps.map((s) => ({ ...s, selector_tier: tierForStep(s) ?? s.selector_tier }));
}

function tierForStep(s: IRStep): SelectorTier | undefined {
  switch (s.method) {
    case "browser_click_by_text": {
      const role = typeof s.params["role"] === "string" ? (s.params["role"] as string) : "";
      if (role !== "" && role !== "generic") return "role_name";
      return "text";
    }
    case "browser_click":
    case "browser_describe_ref":
    case "browser_query_selector": {
      const sel = typeof s.params["selector"] === "string" ? (s.params["selector"] as string) : undefined;
      if (sel !== undefined) return tierFromSelector(sel);
      // ref-based dispatch — refs are issued by the extension and are stable
      // within a single page lifetime. Treat as role_name (mid-tier) — the
      // ref ultimately resolved to an a11y node.
      if (typeof s.params["ref"] === "number") return "role_name";
      return undefined;
    }
    case "browser_type":
    case "browser_find_and_replace":
    case "browser_hover":
    case "browser_scroll": {
      const sel = typeof s.params["selector"] === "string" ? (s.params["selector"] as string) : undefined;
      if (sel !== undefined) return tierFromSelector(sel);
      if (typeof s.params["ref"] === "number") return "role_name";
      return undefined;
    }
    case "browser_execute_js": {
      const code = typeof s.params["code"] === "string" ? (s.params["code"] as string) : "";
      if (code.includes("getElementById") || ID_RE.test(code)) return "id";
      if (TESTID_RE.test(code)) return "testid";
      if (NTH_RE.test(code) || XPATH_RE.test(code)) return "xpath";
      if (code.includes("querySelector")) return "css";
      return "css";
    }
    default:
      return undefined;
  }
}

export function tierFromSelector(sel: string): SelectorTier {
  if (XPATH_RE.test(sel)) return "xpath";
  if (NTH_RE.test(sel)) return "xpath";
  if (TESTID_RE.test(sel) || /^\[data-testid/.test(sel)) return "testid";
  if (ID_RE.test(sel) || /^#[a-zA-Z]/.test(sel)) return "id";
  return "css";
}
