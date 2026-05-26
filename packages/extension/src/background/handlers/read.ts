import type { ErrorCode } from "@browserops/shared";
import { sliceContent } from "@browserops/shared";
import type { Router } from "../router.js";
import type { RefCache, RefEntry, RefSnapshot } from "../ref-cache.js";
import { augment } from "../../lib/a11y-augment.js";

/**
 * browser_read handler.
 *
 * Params: { tab_id, mode } where mode ∈ {"a11y_tree","markdown","sanitized_html","text"}
 * Result: { content, refs, url, title }
 *
 * v1 coverage:
 *   - "text", "markdown", "sanitized_html": chrome.scripting.executeScript
 *     injects a function into the target tab's MAIN world. sanitized_html is
 *     post-processed in the SW with regex stripping (MV3 SWs have no
 *     DOMParser; see plan 04).
 *   - "a11y_tree": DOM-only walker (no CDP) in the ISOLATED world. See
 *     plan 05-element-refs.md Produces numbered RefEntry[] which are
 *     stored in the shared RefCache for later click/type dereference.
 */

type ReadMode = "a11y_tree" | "markdown" | "sanitized_html" | "text";

type ReadScope =
  | { kind: "viewport" }
  | { kind: "document" }
  | { kind: "ref"; ref: string };

interface ReadParams {
  tab_id: string;
  mode: ReadMode;
  verbose: boolean;
  start: number;
  length: number;
  max_length: number;
  selector?: string;
  scope: ReadScope;
  augment: boolean;
}

interface ReadResult {
  content: string;
  refs: RefEntry[];
  url: string;
  title: string;
  total_length: number;
  next_start: number | null;
  truncated: boolean;
  start: number;
  length: number;
  matched_selector?: boolean;
}

interface A11yWalkResult {
  entries: RefEntry[];
  tree: string;
  matched: boolean;
}

function codedError(code: ErrorCode, message: string): Error {
  const err = new Error(message) as Error & { code: ErrorCode };
  err.code = code;
  return err;
}

const READ_MODES: readonly ReadMode[] = [
  "a11y_tree",
  "markdown",
  "sanitized_html",
  "text",
] as const;

function parseParams(raw: Record<string, unknown>): ReadParams {
  const tabId = raw["tab_id"];
  if (typeof tabId !== "string") {
    throw codedError("INVALID_PARAMS", "read requires tab_id:string");
  }
  const mode = raw["mode"];
  if (typeof mode !== "string" || !(READ_MODES as readonly string[]).includes(mode)) {
    throw codedError(
      "INVALID_PARAMS",
      `mode must be one of ${READ_MODES.join(", ")}`,
    );
  }
  const verboseRaw = raw["verbose"];
  let verbose = false;
  if (verboseRaw !== undefined) {
    if (typeof verboseRaw !== "boolean") {
      throw codedError("INVALID_PARAMS", "verbose must be boolean");
    }
    verbose = verboseRaw;
  }
  const startRaw = raw["start"];
  let start = 0;
  if (startRaw !== undefined) {
    if (typeof startRaw !== "number" || !Number.isInteger(startRaw) || startRaw < 0) {
      throw codedError("INVALID_PARAMS", "start must be a non-negative integer");
    }
    start = startRaw;
  }
  const maxLengthRaw = raw["max_length"];
  let max_length = 131072;
  if (maxLengthRaw !== undefined) {
    if (
      typeof maxLengthRaw !== "number" ||
      !Number.isInteger(maxLengthRaw) ||
      maxLengthRaw < 1024 ||
      maxLengthRaw > 1048576
    ) {
      throw codedError("INVALID_PARAMS", "max_length must be integer in [1024, 1048576]");
    }
    max_length = maxLengthRaw;
  }
  const lengthRaw = raw["length"];
  let length = max_length;
  if (lengthRaw !== undefined) {
    if (
      typeof lengthRaw !== "number" ||
      !Number.isInteger(lengthRaw) ||
      lengthRaw < 1024 ||
      lengthRaw > 1048576
    ) {
      throw codedError("INVALID_PARAMS", "length must be integer in [1024, 1048576]");
    }
    length = lengthRaw;
  }
  const selectorRaw = raw["selector"];
  let selector: string | undefined;
  if (selectorRaw !== undefined) {
    if (typeof selectorRaw !== "string" || selectorRaw.length === 0 || selectorRaw.length > 1024) {
      throw codedError("INVALID_PARAMS", "selector must be a 1-1024 char string");
    }
    selector = selectorRaw;
  }
  let scope: ReadScope = { kind: "viewport" };
  const scopeRaw = raw["scope"];
  if (scopeRaw !== undefined) {
    if (typeof scopeRaw !== "string") {
      throw codedError("INVALID_PARAMS", "scope must be a string");
    }
    if (scopeRaw === "viewport") scope = { kind: "viewport" };
    else if (scopeRaw === "document") scope = { kind: "document" };
    else if (scopeRaw.startsWith("ref:")) scope = { kind: "ref", ref: scopeRaw.slice(4) };
    else throw codedError("INVALID_PARAMS", `scope must be 'viewport'|'document'|'ref:<id>', got ${scopeRaw}`);
  }
  const augmentRaw = raw["augment"];
  let augment = true;
  if (augmentRaw !== undefined) {
    if (typeof augmentRaw !== "boolean") {
      throw codedError("INVALID_PARAMS", "augment must be boolean");
    }
    augment = augmentRaw;
  }
  const out: ReadParams = {
    tab_id: tabId,
    mode: mode as ReadMode,
    verbose,
    start,
    length,
    max_length,
    scope,
    augment,
  };
  if (selector !== undefined) out.selector = selector;
  return out;
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /\s(class|style|id|on\w+|data-[\w-]+)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi,
      "",
    );
}

// ---------------------------------------------------------------------------
// Injected functions. These run in the target tab via
// chrome.scripting.executeScript — they cannot reference closure state, so
// they are standalone function declarations with primitive params only.
// ---------------------------------------------------------------------------

// Resolve the per-mode root element. Returns null iff selector was provided
// but did not match — the handler translates that into matched_selector:false
// in the response. When selector is undefined we return the sensible default
// root for the mode (documentElement for text/html, body for markdown/a11y).
function injectedReadText(selector: string | null): string | null {
  if (selector !== null) {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (el === null) return null;
    return el.innerText;
  }
  return document.documentElement.innerText;
}

function injectedReadOuterHtml(selector: string | null): string | null {
  if (selector !== null) {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (el === null) return null;
    return el.outerHTML;
  }
  return document.documentElement.outerHTML;
}

function injectedReadMarkdown(selector: string | null): string | null {
  const root: Element | null = selector !== null
    ? document.querySelector(selector)
    : document.body;
  if (root === null) return null;
  const out: string[] = [];
  const visit = (node: Node, depth: number): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.nodeValue ?? "").replace(/\s+/g, " ");
      if (t.trim().length > 0) out.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript") return;

    if (/^h[1-6]$/.test(tag)) {
      const level = Number.parseInt(tag.slice(1), 10);
      out.push("\n" + "#".repeat(level) + " " + (el.textContent ?? "").trim() + "\n");
      return;
    }
    if (tag === "p") {
      out.push("\n");
      for (const child of Array.from(el.childNodes)) visit(child, depth);
      out.push("\n");
      return;
    }
    if (tag === "br") {
      out.push("\n");
      return;
    }
    if (tag === "hr") {
      out.push("\n---\n");
      return;
    }
    if (tag === "ul" || tag === "ol") {
      out.push("\n");
      let i = 1;
      for (const li of Array.from(el.children)) {
        if (li.tagName.toLowerCase() !== "li") continue;
        const bullet = tag === "ol" ? `${i}. ` : "- ";
        out.push("  ".repeat(depth) + bullet);
        for (const child of Array.from(li.childNodes)) visit(child, depth + 1);
        out.push("\n");
        i += 1;
      }
      return;
    }
    if (tag === "code") {
      out.push("`" + (el.textContent ?? "") + "`");
      return;
    }
    if (tag === "pre") {
      out.push("\n```\n" + (el.textContent ?? "") + "\n```\n");
      return;
    }
    if (tag === "a") {
      const href = el.getAttribute("href") ?? "";
      const label = (el.textContent ?? "").trim();
      out.push(href.length > 0 ? `[${label}](${href})` : label);
      return;
    }
    if (tag === "strong" || tag === "b") {
      out.push("**" + (el.textContent ?? "").trim() + "**");
      return;
    }
    if (tag === "em" || tag === "i") {
      out.push("*" + (el.textContent ?? "").trim() + "*");
      return;
    }
    for (const child of Array.from(el.childNodes)) visit(child, depth);
  };
  visit(root, 0);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * DOM-only a11y tree walker. Runs in the ISOLATED world of the target tab.
 * Must be fully self-contained — no outer closure refs.
 *
 * Pruning: keep interactive or structural elements that are visible.
 * Numbering: 1-based refs assigned in DFS order. Capped at 500.
 */
function injectedA11yWalk(
  verbose: boolean,
  selector: string | null,
  scopeMode: "viewport" | "document",
  rootSelector: string | null,
): { entries: Array<{ ref: number; selector: string; role: string; name: string; attrs: Record<string, string> }>; tree: string; matched: boolean } {
  const MAX_REFS = 500;
  const MAX_SELECTOR_DEPTH = 6;
  const NAME_MAX = 80;

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "combobox",
    "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio",
    "tab", "switch", "radio", "slider", "spinbutton", "treeitem",
  ]);
  const STRUCTURAL_ROLES = new Set([
    "main", "navigation", "banner", "contentinfo", "form", "dialog",
    "region", "heading", "search", "complementary", "tablist", "tabpanel",
  ]);
  const INTERACTIVE_TAGS = new Set(["a", "button", "input", "textarea", "select"]);
  const STRUCTURAL_TAGS = new Set(["main", "nav", "header", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6"]);

  const truncate = (s: string): string => {
    const trimmed = s.replace(/\s+/g, " ").trim();
    if (trimmed.length <= NAME_MAX) return trimmed;
    return trimmed.slice(0, NAME_MAX - 1) + "…";
  };

  // Two separate questions:
  //   canEmit  — should this element itself be surfaced as a ref?
  //   canDescend — should we walk into this element's subtree?
  // They diverge for `display: contents` wrappers, React animation wrappers
  // with aria-hidden, and similar patterns where the element has no box of
  // its own but descendants render normally.
  const canEmit = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (style.opacity === "0") return false;
    if (scopeMode === "viewport") {
      if (
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth
      ) {
        return false;
      }
    }
    return true;
  };
  const canDescend = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    if (style.display === "none") return false;
    // `visibility: hidden` on a parent can be overridden by child
    // `visibility: visible`, so don't block descent on it.
    return true;
  };

  // Click-handler heuristic: SPA sites (Flipkart, Amazon, Myntra, etc.) bind
  // onClick handlers on role-less <div>/<span> elements, so the strict
  // semantic walker misses the primary call-to-action buttons. A node is a
  // "click candidate" if it has an inline onclick attribute, OR it is the
  // outermost node in a cursor:pointer region (cursor is inherited via CSS,
  // so the parent check dedupes: we emit only the clickable root, not every
  // descendant that merely inherited the pointer cursor).
  const isClickCandidate = (el: Element): boolean => {
    if (el.hasAttribute("onclick")) return true;
    const style = window.getComputedStyle(el);
    if (style.cursor !== "pointer") return false;
    const parent = el.parentElement;
    if (parent === null) return true;
    return window.getComputedStyle(parent).cursor !== "pointer";
  };

  const roleFor = (el: Element): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit !== null && explicit.length > 0) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "a") {
      return el.hasAttribute("href") ? "link" : null;
    }
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") ?? "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "main") return "main";
    if (tag === "nav") return "navigation";
    if (tag === "header") return "banner";
    if (tag === "footer") return "contentinfo";
    if (tag === "form") return "form";
    if (el.getAttribute("contenteditable") === "true") return "textbox";
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number.parseInt(tabindex, 10) >= 0) {
      return "generic";
    }
    // Last-resort SPA fallback — see isClickCandidate comment above.
    if (isClickCandidate(el)) return "button";
    return null;
  };

  const shouldKeep = (el: Element, role: string | null): boolean => {
    if (role === null) return false;
    if (INTERACTIVE_ROLES.has(role) || STRUCTURAL_ROLES.has(role)) return true;
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag) || STRUCTURAL_TAGS.has(tag)) return true;
    if (el.getAttribute("contenteditable") === "true") return true;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number.parseInt(tabindex, 10) >= 0) return true;
    return false;
  };

  const nameOf = (el: Element): string => {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel !== null && ariaLabel.trim().length > 0) return truncate(ariaLabel);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy !== null) {
      const parts: string[] = [];
      for (const id of labelledBy.split(/\s+/)) {
        if (id.length === 0) continue;
        const ref = document.getElementById(id);
        if (ref !== null) parts.push(ref.textContent ?? "");
      }
      const joined = parts.join(" ").trim();
      if (joined.length > 0) return truncate(joined);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt !== null && alt.length > 0) return truncate(alt);
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const placeholder = el.getAttribute("placeholder");
      if (placeholder !== null && placeholder.length > 0) return truncate(placeholder);
      const value = (el as HTMLInputElement).value;
      const inputType = (el.getAttribute("type") ?? "").toLowerCase();
      if (typeof value === "string" && value.length > 0 && inputType !== "password") {
        return truncate(value);
      }
    }
    const text = (el.textContent ?? "").trim();
    if (text.length > 0) return truncate(text);
    const title = el.getAttribute("title");
    if (title !== null && title.length > 0) return truncate(title);
    return "";
  };

  const isSafeId = (id: string): boolean => /^[a-zA-Z_-][\w-]*$/.test(id);

  const selectorFor = (el: Element): string => {
    const id = el.getAttribute("id");
    if (id !== null && isSafeId(id)) {
      try {
        if (document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
          return `#${CSS.escape(id)}`;
        }
      } catch {
        // CSS.escape unavailable or selector misbehaved; fall through.
      }
    }
    const testId = el.getAttribute("data-testid");
    if (testId !== null && testId.length > 0) {
      const candidate = `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
      try {
        if (document.querySelectorAll(candidate).length === 1) {
          return candidate;
        }
      } catch {
        // ignore
      }
    }
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node !== null && node !== document.body && depth < MAX_SELECTOR_DEPTH) {
      const parent: Element | null = node.parentElement;
      if (parent === null) break;
      const tag = node.tagName.toLowerCase();
      let index = 1;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node) break;
        if (sibling.tagName.toLowerCase() === tag) index += 1;
      }
      parts.unshift(`${tag}:nth-of-type(${index})`);
      node = parent;
      depth += 1;
    }
    return parts.length > 0 ? parts.join(" > ") : el.tagName.toLowerCase();
  };

  const attrsOf = (el: Element): Record<string, string> => {
    const attrs: Record<string, string> = {};
    attrs["domType"] = el.tagName.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      attrs["inputType"] = (el.getAttribute("type") ?? "text").toLowerCase();
    }
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href !== null) attrs["href"] = href;
    }
    if (tag === "button") {
      const t = el.getAttribute("type");
      if (t !== null) attrs["type"] = t;
    }
    return attrs;
  };

  // Non-verbose filter: restricts emission to elements that (a) already pass
  // shouldKeep && canEmit (today's eligible set) and additionally have a
  // non-empty accessible name, a core interactive role, or an eligible
  // descendant that survived. A pre-pass marks those; the main walk then
  // emits only marked elements. In verbose mode the pre-pass is skipped and
  // the legacy (shouldKeep && canEmit) gate is used.
  const CORE_INTERACTIVE = new Set([
    "button", "link", "textbox", "combobox", "checkbox", "radio", "menuitem", "tab",
  ]);
  const marked: WeakSet<Element> = new WeakSet();
  const markPass = (el: Element): boolean => {
    // Returns true iff this subtree contains any marked element.
    if (!canDescend(el)) return false;
    let anyChildMarked = false;
    for (const child of Array.from(el.children)) {
      if (markPass(child)) anyChildMarked = true;
    }
    if (el.shadowRoot !== null) {
      for (const child of Array.from(el.shadowRoot.children)) {
        if (markPass(child)) anyChildMarked = true;
      }
    }
    const role = roleFor(el);
    const eligible = role !== null && shouldKeep(el, role) && canEmit(el);
    if (eligible) {
      const name = nameOf(el);
      const rule1 = name.length > 0;
      const rule2 = CORE_INTERACTIVE.has(role);
      const rule3 = anyChildMarked;
      if (rule1 || rule2 || rule3) {
        marked.add(el);
        return true;
      }
    }
    return anyChildMarked;
  };
  // rootSelector (from scope: "ref:<id>") wins over the legacy selector
  // arg — the ref scope is more specific.
  const rootEl: Element | null = rootSelector !== null
    ? document.querySelector(rootSelector)
    : selector !== null
      ? document.querySelector(selector)
      : document.body;

  if (!verbose && rootEl !== null) {
    markPass(rootEl);
  }

  const entries: Array<{ ref: number; selector: string; role: string; name: string; attrs: Record<string, string> }> = [];
  const treeLines: string[] = [];
  let truncated = false;
  let truncatedCount = 0;
  let refCounter = 0;

  const walk = (el: Element, depth: number): void => {
    if (!canDescend(el)) return;
    const role = roleFor(el);
    const keep = verbose
      ? (shouldKeep(el, role) && canEmit(el))
      : marked.has(el);
    let childDepth = depth;
    if (keep && role !== null) {
      if (refCounter >= MAX_REFS) {
        truncated = true;
        truncatedCount += 1;
      } else {
        refCounter += 1;
        const ref = refCounter;
        const name = nameOf(el);
        const selector = selectorFor(el);
        const attrs = attrsOf(el);
        entries.push({ ref, selector, role, name, attrs });
        const indent = "  ".repeat(depth);
        const nameStr = name.length > 0 ? ` "${name.replace(/"/g, '\\"')}"` : "";
        treeLines.push(`${indent}[${ref}] ${role}${nameStr}`);
        childDepth = depth + 1;
      }
    }
    for (const child of Array.from(el.children)) {
      walk(child, childDepth);
    }
    // Pierce open shadow roots. Closed shadow roots are intentionally opaque
    // and there's nothing we can do about those from script.
    if (el.shadowRoot !== null) {
      for (const child of Array.from(el.shadowRoot.children)) {
        walk(child, childDepth);
      }
    }
  };

  const matched = rootEl !== null;
  if (rootEl !== null) {
    walk(rootEl, 0);
  }

  if (truncated) {
    treeLines.push(`[... ${truncatedCount} more refs elided]`);
  }

  return { entries, tree: treeLines.join("\n"), matched };
}

async function execInTab<T>(
  chromeTabId: number,
  fn: () => T,
  world: chrome.scripting.ExecutionWorld = "MAIN",
): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    func: fn,
    world,
  });
  if (!Array.isArray(results) || results.length === 0) {
    throw codedError("INTERNAL", "executeScript returned no frames");
  }
  const first = results[0];
  if (first === undefined) {
    throw codedError("INTERNAL", "executeScript main-frame result missing");
  }
  return first.result as T;
}

async function execInTabWithArgs<A extends readonly unknown[], T>(
  chromeTabId: number,
  fn: (...args: A) => T,
  args: A,
  world: chrome.scripting.ExecutionWorld = "MAIN",
): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    func: fn as unknown as (...a: unknown[]) => T,
    args: args as unknown as unknown[],
    world,
  });
  if (!Array.isArray(results) || results.length === 0) {
    throw codedError("INTERNAL", "executeScript returned no frames");
  }
  const first = results[0];
  if (first === undefined) {
    throw codedError("INTERNAL", "executeScript main-frame result missing");
  }
  return first.result as T;
}

function narrowWalkResult(raw: unknown): A11yWalkResult {
  if (typeof raw !== "object" || raw === null) {
    throw codedError("INTERNAL", "a11y walker returned non-object");
  }
  const obj = raw as Record<string, unknown>;
  const tree = obj["tree"];
  const rawEntries = obj["entries"];
  const matchedRaw = obj["matched"];
  if (typeof tree !== "string" || !Array.isArray(rawEntries)) {
    throw codedError("INTERNAL", "a11y walker result malformed");
  }
  const matched = typeof matchedRaw === "boolean" ? matchedRaw : true;
  const entries: RefEntry[] = [];
  for (const item of rawEntries) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const ref = e["ref"];
    const selector = e["selector"];
    const role = e["role"];
    const name = e["name"];
    const attrs = e["attrs"];
    if (
      typeof ref !== "number" ||
      typeof selector !== "string" ||
      typeof role !== "string" ||
      typeof name !== "string"
    ) {
      continue;
    }
    let attrsClean: Record<string, string> | undefined;
    if (typeof attrs === "object" && attrs !== null) {
      const acc: Record<string, string> = {};
      for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
        if (typeof v === "string") acc[k] = v;
      }
      attrsClean = acc;
    }
    const entry: RefEntry = attrsClean === undefined
      ? { ref, selector, role, name }
      : { ref, selector, role, name, attrs: attrsClean };
    entries.push(entry);
  }
  return { entries, tree, matched };
}

/**
 * Injected: describe an element's current state. Runs in MAIN world so it
 * can see framework-controlled `value` on React inputs (a getter on the
 * prototype still reports the native value, so ISOLATED would work too,
 * but MAIN matches the click/type dispatch world for consistency).
 */
function injectedDescribe(selector: string): {
  found: boolean;
  role?: string;
  name?: string;
  tag?: string;
  visible?: boolean;
  disabled?: boolean;
  focused?: boolean;
  checked?: boolean;
  value?: string;
  attrs?: Record<string, string>;
  aria?: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
} {
  // Shared element → state encoder. Duplicated verbatim in
  // injectedQuerySelector below because MAIN-world injection cannot close
  // over outer helpers.
  const describeOne = (el: HTMLElement) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") ?? "";
    const aria: Record<string, string> = {};
    for (const a of el.getAttributeNames()) {
      if (a.startsWith("aria-")) {
        const v = el.getAttribute(a);
        if (v !== null) aria[a] = v;
      }
    }
    const attrs: Record<string, string> = {};
    for (const a of ["id", "class", "name", "type", "href", "placeholder", "data-testid"]) {
      const v = el.getAttribute(a);
      if (v !== null) attrs[a] = v;
    }
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.opacity !== "0";
    const disabled =
      (el as HTMLButtonElement).disabled === true ||
      el.getAttribute("aria-disabled") === "true";
    const focused = document.activeElement === el;
    const checked =
      (el as HTMLInputElement).checked === true ||
      el.getAttribute("aria-checked") === "true";
    const valueField = (el as HTMLInputElement).value;
    const value = typeof valueField === "string" ? valueField : undefined;
    let name = el.getAttribute("aria-label") ?? "";
    if (name === "") {
      const text = (el.textContent ?? "").trim();
      if (text.length > 0) name = text;
    }
    return {
      role,
      name: name.slice(0, 200),
      tag,
      visible,
      disabled,
      focused,
      checked,
      value: value !== undefined ? value.slice(0, 1024) : undefined,
      attrs,
      aria,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  };
  const el = document.querySelector(selector) as HTMLElement | null;
  if (el === null) return { found: false };
  const out = describeOne(el);
  return { found: true, ...out };
}

/**
 * Injected: query elements by CSS selector and return the same shape as
 * injectedDescribe (minus `ref`) for each match. Read-only — no ref
 * assignment, no walker mutation. `all=true` returns up to `maxResults`
 * matches with a `total` count for caller-side truncation detection.
 */
interface QuerySelectorState {
  role: string;
  name: string;
  tag: string;
  visible: boolean;
  disabled: boolean;
  focused: boolean;
  checked: boolean;
  value?: string;
  attrs: Record<string, string>;
  aria: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

function injectedQuerySelector(
  selector: string,
  all: boolean,
  maxResults: number,
): {
  found: boolean;
  matches: QuerySelectorState[];
  total: number;
  invalidSelector?: string;
} {
  // Duplicated from injectedDescribe — see that function for invariants.
  const describeOne = (el: HTMLElement): QuerySelectorState => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") ?? "";
    const aria: Record<string, string> = {};
    for (const a of el.getAttributeNames()) {
      if (a.startsWith("aria-")) {
        const v = el.getAttribute(a);
        if (v !== null) aria[a] = v;
      }
    }
    const attrs: Record<string, string> = {};
    for (const a of ["id", "class", "name", "type", "href", "placeholder", "data-testid"]) {
      const v = el.getAttribute(a);
      if (v !== null) attrs[a] = v;
    }
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.opacity !== "0";
    const disabled =
      (el as HTMLButtonElement).disabled === true ||
      el.getAttribute("aria-disabled") === "true";
    const focused = document.activeElement === el;
    const checked =
      (el as HTMLInputElement).checked === true ||
      el.getAttribute("aria-checked") === "true";
    const valueField = (el as HTMLInputElement).value;
    const value = typeof valueField === "string" ? valueField.slice(0, 1024) : undefined;
    let name = el.getAttribute("aria-label") ?? "";
    if (name === "") {
      const text = (el.textContent ?? "").trim();
      if (text.length > 0) name = text;
    }
    return {
      role,
      name: name.slice(0, 200),
      tag,
      visible,
      disabled,
      focused,
      checked,
      ...(value !== undefined ? { value } : {}),
      attrs,
      aria,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  };
  if (!all) {
    let el: Element | null;
    try {
      el = document.querySelector(selector);
    } catch (e) {
      return { found: false, matches: [], total: 0, invalidSelector: String((e as Error)?.message ?? e) };
    }
    if (el === null) return { found: false, matches: [], total: 0 };
    return { found: true, matches: [describeOne(el as HTMLElement)], total: 1 };
  }
  let list: NodeListOf<Element>;
  try {
    list = document.querySelectorAll(selector);
  } catch (e) {
    return { found: false, matches: [], total: 0, invalidSelector: String((e as Error)?.message ?? e) };
  }
  const total = list.length;
  const out: QuerySelectorState[] = [];
  const cap = Math.min(total, Math.max(1, maxResults));
  for (let i = 0; i < cap; i++) {
    const el = list.item(i);
    if (el === null) continue;
    out.push(describeOne(el as HTMLElement));
  }
  return { found: total > 0, matches: out, total };
}

export function registerReadHandler(
  router: Router,
  opts: { tabIdMap: Map<string, number>; refCache: RefCache },
): void {
  router.register("browser_read", async (rawParams) => {
    const params = parseParams(rawParams);

    const chromeTabId = opts.tabIdMap.get(params.tab_id);
    if (chromeTabId === undefined) {
      throw codedError("TAB_NOT_FOUND", `unknown tab_id: ${params.tab_id}`);
    }

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(chromeTabId);
    } catch {
      throw codedError("TAB_NOT_FOUND", `chrome tab ${chromeTabId} no longer exists`);
    }

    const url = typeof tab.url === "string" ? tab.url : "";
    const title = typeof tab.title === "string" ? tab.title : "";

    const effectiveLength = Math.min(params.length, params.max_length);
    const selectorArg = params.selector ?? null;

    if (params.mode === "a11y_tree") {
      // Resolve scope. "ref:<id>" needs to translate the ref id into a CSS
      // selector via the RefCache so the walker can root its DOM traversal.
      const scopeMode = params.scope.kind === "viewport" ? "viewport" : "document";
      let rootSelector: string | null = null;
      if (params.scope.kind === "ref") {
        const snapshot = opts.refCache.get(params.tab_id);
        const refNum = Number.parseInt(params.scope.ref, 10);
        const entry = snapshot?.entries.get(refNum);
        if (entry === undefined) {
          throw codedError(
            "REF_STALE",
            `scope=ref:${params.scope.ref} could not be resolved; call browser_read mode:'a11y_tree' first`,
          );
        }
        rootSelector = entry.selector;
      }
      const raw: unknown = await execInTabWithArgs<
        readonly [boolean, string | null, "viewport" | "document", string | null],
        unknown
      >(
        chromeTabId,
        injectedA11yWalk,
        [params.verbose, selectorArg, scopeMode, rootSelector],
        "ISOLATED",
      );
      const walk = narrowWalkResult(raw);
      const entriesMap = new Map<number, RefEntry>();
      for (const entry of walk.entries) {
        entriesMap.set(entry.ref, entry);
      }
      const snapshot: RefSnapshot = {
        tab_id: params.tab_id,
        url,
        createdAt: Date.now(),
        entries: entriesMap,
      };
      opts.refCache.set(params.tab_id, snapshot);
      const sliced = sliceContent(walk.tree, params.start, effectiveLength);
      // Visual augmentation: one extra round-trip that returns bounds /
      // visibility / occlusion / style per ref. Costs O(refs) elementFromPoint
      // calls inside the injected fn but is capped at 200 occlusion samples
      // per call to stay under ~30 ms on typical pages.
      let refsOut: ReadResult["refs"] = walk.entries;
      if (params.augment && walk.entries.length > 0) {
        try {
          const a11yNodes = walk.entries.map((e) => ({
            ref: String(e.ref),
            role: e.role,
            name: e.name,
            selector: e.selector,
          }));
          const augmented = await augment(chromeTabId, a11yNodes);
          refsOut = walk.entries.map((entry, i) => {
            const a = augmented[i];
            if (a === undefined) return entry;
            return {
              ...entry,
              bounds: a.bounds,
              visible: a.visible,
              in_viewport: a.in_viewport,
              occluded_by: a.occluded_by,
              bg_color: a.bg_color,
              fg_color: a.fg_color,
              opacity: a.opacity,
              disabled_visual: a.disabled_visual,
              ...(a.display !== undefined ? { display: a.display } : {}),
              ...(a.flex_direction !== undefined ? { flex_direction: a.flex_direction } : {}),
            };
          });
        } catch (err) {
          console.warn("[browserops] augmentation skipped:", err);
        }
      }
      const result: ReadResult = {
        content: sliced.slice,
        refs: refsOut,
        url,
        title,
        total_length: sliced.total_length,
        next_start: sliced.next_start,
        truncated: sliced.truncated,
        start: params.start,
        length: sliced.slice.length,
      };
      if (params.selector !== undefined) {
        result.matched_selector = walk.matched;
      }
      return result;
    }

    let content: string;
    let matched = true;
    if (params.mode === "text") {
      const res = await execInTabWithArgs<readonly [string | null], string | null>(
        chromeTabId,
        injectedReadText,
        [selectorArg],
      );
      if (res === null) { matched = false; content = ""; } else { content = res; }
    } else if (params.mode === "markdown") {
      const res = await execInTabWithArgs<readonly [string | null], string | null>(
        chromeTabId,
        injectedReadMarkdown,
        [selectorArg],
      );
      if (res === null) { matched = false; content = ""; } else { content = res; }
    } else {
      // sanitized_html
      const res = await execInTabWithArgs<readonly [string | null], string | null>(
        chromeTabId,
        injectedReadOuterHtml,
        [selectorArg],
      );
      if (res === null) { matched = false; content = ""; } else { content = sanitizeHtml(res); }
    }

    const sliced = sliceContent(content, params.start, effectiveLength);
    const result: ReadResult = {
      content: sliced.slice,
      refs: [],
      url,
      title,
      total_length: sliced.total_length,
      next_start: sliced.next_start,
      truncated: sliced.truncated,
      start: params.start,
      length: sliced.slice.length,
    };
    if (params.selector !== undefined) {
      result.matched_selector = matched;
    }
    return result;
  });

  router.register("browser_describe_ref", async (rawParams) => {
    const tab_id = rawParams["tab_id"];
    const refRaw = rawParams["ref"];
    if (typeof tab_id !== "string") {
      throw codedError("INVALID_PARAMS", "tab_id must be a string");
    }
    if (typeof refRaw !== "number" || !Number.isInteger(refRaw) || refRaw < 1) {
      throw codedError("INVALID_PARAMS", "ref must be a positive integer");
    }
    const chromeTabId = opts.tabIdMap.get(tab_id);
    if (chromeTabId === undefined) {
      throw codedError("TAB_NOT_FOUND", `unknown tab_id: ${tab_id}`);
    }
    const snap = opts.refCache.get(tab_id);
    if (snap === undefined) {
      throw codedError("REF_STALE", `no a11y snapshot for tab ${tab_id}; call browser_read first`);
    }
    const entry = snap.entries.get(refRaw);
    if (entry === undefined) {
      throw codedError("REF_NOT_FOUND", `ref ${refRaw} not present in current snapshot for ${tab_id}`);
    }
    const results = (await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      world: "MAIN",
      func: injectedDescribe,
      args: [entry.selector],
    })) as chrome.scripting.InjectionResult[];
    const first = results[0];
    const res = first?.result as ReturnType<typeof injectedDescribe> | undefined;
    if (res === undefined || res.found === false) {
      throw codedError("REF_STALE", `ref ${refRaw} no longer resolves in tab ${tab_id}`);
    }
    return {
      ref: refRaw,
      role: res.role ?? entry.role,
      name: res.name ?? entry.name,
      tag: res.tag ?? "",
      visible: res.visible ?? false,
      ...(res.disabled !== undefined ? { disabled: res.disabled } : {}),
      ...(res.focused !== undefined ? { focused: res.focused } : {}),
      ...(res.checked !== undefined ? { checked: res.checked } : {}),
      ...(res.value !== undefined ? { value: res.value } : {}),
      ...(res.attrs !== undefined ? { attrs: res.attrs } : {}),
      ...(res.aria !== undefined ? { aria: res.aria } : {}),
      ...(res.rect !== undefined ? { rect: res.rect } : {}),
    };
  });

  router.register("browser_query_selector", async (rawParams) => {
    const MAX_MATCHES = 50;
    const tab_id = rawParams["tab_id"];
    const selector = rawParams["selector"];
    const allRaw = rawParams["all"];
    if (typeof tab_id !== "string") {
      throw codedError("INVALID_PARAMS", "tab_id must be a string");
    }
    if (typeof selector !== "string" || selector.length === 0 || selector.length > 2048) {
      throw codedError(
        "INVALID_PARAMS",
        "selector must be a non-empty string up to 2048 chars",
      );
    }
    const all = allRaw === true;
    const chromeTabId = opts.tabIdMap.get(tab_id);
    if (chromeTabId === undefined) {
      throw codedError("TAB_NOT_FOUND", `unknown tab_id: ${tab_id}`);
    }
    const results = (await chrome.scripting.executeScript({
      target: { tabId: chromeTabId },
      world: "MAIN",
      func: injectedQuerySelector,
      args: [selector, all, MAX_MATCHES],
    })) as chrome.scripting.InjectionResult[];
    const res = results[0]?.result as
      | ReturnType<typeof injectedQuerySelector>
      | undefined;
    if (res === undefined) {
      throw codedError("INTERNAL", "executeScript returned no result");
    }
    if (res.invalidSelector !== undefined) {
      throw codedError("INVALID_PARAMS", `invalid CSS selector: ${res.invalidSelector}`);
    }
    if (all) {
      return {
        matches: res.matches,
        total: res.total,
        truncated: res.total > res.matches.length,
      };
    }
    return { match: res.matches.length > 0 ? res.matches[0] : null };
  });

  // -------------------------------------------------------------------------
  // browser_quick_read — lightweight a11y search by accessible name
  // -------------------------------------------------------------------------

  /**
   * DOM-only a11y search. Runs in the ISOLATED world.
   * Must be fully self-contained — no outer closure refs.
   * Walks the DOM looking for elements whose accessible name contains the query.
   */
  function injectedA11yFind(
    query: string,
    roleFilter: string | null,
    viewportOnly: boolean,
    maxResults: number,
  ): { entries: Array<{ ref: number; selector: string; role: string; name: string; attrs: Record<string, string>; rect: { x: number; y: number; width: number; height: number } }>; total: number } {
    const MAX_SELECTOR_DEPTH = 6;
    const NAME_MAX = 80;

    const INTERACTIVE_ROLES = new Set([
      "button", "link", "textbox", "searchbox", "checkbox", "combobox",
      "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio",
      "tab", "switch", "radio", "slider", "spinbutton", "treeitem",
    ]);
    const STRUCTURAL_ROLES = new Set([
      "main", "navigation", "banner", "contentinfo", "form", "dialog",
      "region", "heading", "search", "complementary", "tablist", "tabpanel",
    ]);
    const INTERACTIVE_TAGS = new Set(["a", "button", "input", "textarea", "select"]);
    const STRUCTURAL_TAGS = new Set(["main", "nav", "header", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6"]);

    const truncate = (s: string): string => {
      const trimmed = s.replace(/\s+/g, " ").trim();
      if (trimmed.length <= NAME_MAX) return trimmed;
      return trimmed.slice(0, NAME_MAX - 1) + "\u2026";
    };

    const canEmit = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return false;
      if (style.opacity === "0") return false;
      if (viewportOnly) {
        if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return false;
      }
      return true;
    };

    const canDescend = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      if (style.display === "none") return false;
      return true;
    };

    const isClickCandidate = (el: Element): boolean => {
      if (el.hasAttribute("onclick")) return true;
      const style = window.getComputedStyle(el);
      if (style.cursor !== "pointer") return false;
      const parent = el.parentElement;
      if (parent === null) return true;
      return window.getComputedStyle(parent).cursor !== "pointer";
    };

    const roleFor = (el: Element): string | null => {
      const explicit = el.getAttribute("role");
      if (explicit !== null && explicit.length > 0) return explicit.toLowerCase();
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return el.hasAttribute("href") ? "link" : null;
      if (tag === "button") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const t = (el.getAttribute("type") ?? "text").toLowerCase();
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "submit" || t === "button" || t === "reset") return "button";
        if (t === "range") return "slider";
        if (t === "number") return "spinbutton";
        if (t === "search") return "searchbox";
        return "textbox";
      }
      if (/^h[1-6]$/.test(tag)) return "heading";
      if (tag === "main") return "main";
      if (tag === "nav") return "navigation";
      if (tag === "header") return "banner";
      if (tag === "footer") return "contentinfo";
      if (tag === "form") return "form";
      if (el.getAttribute("contenteditable") === "true") return "textbox";
      const tabindex = el.getAttribute("tabindex");
      if (tabindex !== null && Number.parseInt(tabindex, 10) >= 0) return "generic";
      if (isClickCandidate(el)) return "button";
      return null;
    };

    const shouldKeep = (el: Element, role: string | null): boolean => {
      if (role === null) return false;
      if (INTERACTIVE_ROLES.has(role) || STRUCTURAL_ROLES.has(role)) return true;
      const tag = el.tagName.toLowerCase();
      if (INTERACTIVE_TAGS.has(tag) || STRUCTURAL_TAGS.has(tag)) return true;
      if (el.getAttribute("contenteditable") === "true") return true;
      const tabindex = el.getAttribute("tabindex");
      if (tabindex !== null && Number.parseInt(tabindex, 10) >= 0) return true;
      return false;
    };

    const nameOf = (el: Element): string => {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel !== null && ariaLabel.trim().length > 0) return truncate(ariaLabel);
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy !== null) {
        const parts: string[] = [];
        for (const id of labelledBy.split(/\s+/)) {
          if (id.length === 0) continue;
          const ref = document.getElementById(id);
          if (ref !== null) parts.push(ref.textContent ?? "");
        }
        const joined = parts.join(" ").trim();
        if (joined.length > 0) return truncate(joined);
      }
      const tag = el.tagName.toLowerCase();
      if (tag === "img") {
        const alt = el.getAttribute("alt");
        if (alt !== null && alt.length > 0) return truncate(alt);
      }
      if (tag === "input" || tag === "textarea" || tag === "select") {
        const placeholder = el.getAttribute("placeholder");
        if (placeholder !== null && placeholder.length > 0) return truncate(placeholder);
        const value = (el as HTMLInputElement).value;
        const inputType = (el.getAttribute("type") ?? "").toLowerCase();
        if (typeof value === "string" && value.length > 0 && inputType !== "password") return truncate(value);
      }
      const text = (el.textContent ?? "").trim();
      if (text.length > 0) return truncate(text);
      const title = el.getAttribute("title");
      if (title !== null && title.length > 0) return truncate(title);
      return "";
    };

    const isSafeId = (id: string): boolean => /^[a-zA-Z_-][\w-]*$/.test(id);

    const selectorFor = (el: Element): string => {
      const id = el.getAttribute("id");
      if (id !== null && isSafeId(id)) {
        try {
          if (document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) return `#${CSS.escape(id)}`;
        } catch { /* fall through */ }
      }
      const testId = el.getAttribute("data-testid");
      if (testId !== null && testId.length > 0) {
        const candidate = `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
        try {
          if (document.querySelectorAll(candidate).length === 1) return candidate;
        } catch { /* ignore */ }
      }
      const parts: string[] = [];
      let node: Element | null = el;
      let depth = 0;
      while (node !== null && node !== document.body && depth < MAX_SELECTOR_DEPTH) {
        const parent: Element | null = node.parentElement;
        if (parent === null) break;
        const tag = node.tagName.toLowerCase();
        let index = 1;
        for (const sibling of Array.from(parent.children)) {
          if (sibling === node) break;
          if (sibling.tagName.toLowerCase() === tag) index += 1;
        }
        parts.unshift(`${tag}:nth-of-type(${index})`);
        node = parent;
        depth += 1;
      }
      return parts.length > 0 ? parts.join(" > ") : el.tagName.toLowerCase();
    };

    const attrsOf = (el: Element): Record<string, string> => {
      const attrs: Record<string, string> = {};
      attrs["domType"] = el.tagName.toLowerCase();
      const tag = el.tagName.toLowerCase();
      if (tag === "input") attrs["inputType"] = (el.getAttribute("type") ?? "text").toLowerCase();
      if (tag === "a") { const href = el.getAttribute("href"); if (href !== null) attrs["href"] = href; }
      if (tag === "button") { const t = el.getAttribute("type"); if (t !== null) attrs["type"] = t; }
      return attrs;
    };

    const entries: Array<{ ref: number; selector: string; role: string; name: string; attrs: Record<string, string>; rect: { x: number; y: number; width: number; height: number } }> = [];
    let total = 0;
    let refCounter = 0;
    const queryLower = query.toLowerCase();

    const walk = (el: Element): void => {
      if (!canDescend(el)) return;
      const role = roleFor(el);
      if (role !== null && shouldKeep(el, role) && canEmit(el)) {
        if (roleFilter !== null && role !== roleFilter) {
          // Role doesn't match filter — skip this element but still walk children.
        } else {
          const name = nameOf(el);
          if (name.toLowerCase().includes(queryLower)) {
            total += 1;
            if (entries.length < maxResults) {
              refCounter += 1;
              const rect = el.getBoundingClientRect();
              entries.push({
                ref: refCounter,
                selector: selectorFor(el),
                role,
                name,
                attrs: attrsOf(el),
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
              });
            }
          }
        }
      }
      for (const child of Array.from(el.children)) walk(child);
      if (el.shadowRoot !== null) {
        for (const child of Array.from(el.shadowRoot.children)) walk(child);
      }
    };

    if (document.body !== null) walk(document.body);
    return { entries, total };
  }

  router.register("browser_quick_read", async (rawParams) => {
    const tabId = rawParams["tab_id"];
    if (typeof tabId !== "string") {
      throw codedError("INVALID_PARAMS", "tab_id must be a string");
    }
    const chromeTabId = opts.tabIdMap.get(tabId);
    if (chromeTabId === undefined) {
      throw codedError("TAB_NOT_FOUND", `unknown tab_id: ${tabId}`);
    }
    const query = rawParams["query"];
    if (typeof query !== "string" || query.length === 0) {
      throw codedError("INVALID_PARAMS", "query must be a non-empty string");
    }
    const roleRaw = rawParams["role"];
    const roleFilter = typeof roleRaw === "string" ? roleRaw.toLowerCase() : null;
    let viewportOnly = rawParams["viewport_only"] === true;
    const maxResultsRaw = rawParams["max_results"];
    const maxResults = typeof maxResultsRaw === "number" && Number.isInteger(maxResultsRaw)
      ? Math.min(Math.max(maxResultsRaw, 1), 50)
      : 10;

    // scope is the new viewport/document/ref discriminant. Default 'viewport'
    // matches the observation-architecture plan; legacy viewport_only is
    // preserved for callers that already opt into the same behavior.
    const scopeRaw = rawParams["scope"];
    let scope: "viewport" | "document" | { kind: "ref"; ref: string } = "viewport";
    if (typeof scopeRaw === "string") {
      if (scopeRaw === "viewport") scope = "viewport";
      else if (scopeRaw === "document") scope = "document";
      else if (scopeRaw.startsWith("ref:")) scope = { kind: "ref", ref: scopeRaw.slice(4) };
      else throw codedError("INVALID_PARAMS", `scope must be 'viewport'|'document'|'ref:<id>', got ${scopeRaw}`);
    }
    if (scope === "viewport") viewportOnly = true;
    else if (scope === "document") viewportOnly = false;

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(chromeTabId);
    } catch {
      throw codedError("TAB_NOT_FOUND", `chrome tab ${chromeTabId} no longer exists`);
    }

    const url = typeof tab.url === "string" ? tab.url : "";

    const raw: unknown = await execInTabWithArgs<
      readonly [string, string | null, boolean, number],
      unknown
    >(
      chromeTabId,
      injectedA11yFind,
      [query, roleFilter, viewportOnly, maxResults],
      "ISOLATED",
    );

    const result = raw as { entries: Array<{ ref: number; selector: string; role: string; name: string; attrs: Record<string, string>; rect: { x: number; y: number; width: number; height: number } }>; total: number };

    // Store entries in refCache so returned refs can be used with browser_click etc.
    const entriesMap = new Map<number, RefEntry>();
    for (const entry of result.entries) {
      entriesMap.set(entry.ref, entry);
    }
    const snapshot: RefSnapshot = {
      tab_id: tabId,
      url,
      createdAt: Date.now(),
      entries: entriesMap,
    };
    opts.refCache.set(tabId, snapshot);

    const onlyEnabled = rawParams["only_enabled"] === true;
    const onlyVisible = rawParams["only_visible"] === true;
    const onlyInViewport = rawParams["only_in_viewport"] === true;

    // Augment matches with visual fields by default. The quick_read injected
    // fn already attaches a `rect` so the agent gets bounds either way, but
    // the augmentation pass adds visible / in_viewport / occluded_by / etc.
    let matches: typeof result.entries | Array<typeof result.entries[number] & {
      visible?: boolean;
      in_viewport?: boolean;
      occluded_by?: string | null;
      bg_color?: string | null;
      fg_color?: string | null;
      opacity?: number;
      disabled_visual?: boolean;
      display?: string;
      flex_direction?: string;
    }> = result.entries;
    const augmentFlag = rawParams["augment"];
    if (augmentFlag !== false && result.entries.length > 0) {
      try {
        const a11yNodes = result.entries.map((e) => ({
          ref: String(e.ref),
          role: e.role,
          name: e.name,
          selector: e.selector,
        }));
        const augmented = await augment(chromeTabId, a11yNodes);
        matches = result.entries.map((entry, i) => {
          const a = augmented[i];
          if (a === undefined) return entry;
          return {
            ...entry,
            visible: a.visible,
            in_viewport: a.in_viewport,
            occluded_by: a.occluded_by,
            bg_color: a.bg_color,
            fg_color: a.fg_color,
            opacity: a.opacity,
            disabled_visual: a.disabled_visual,
            ...(a.display !== undefined ? { display: a.display } : {}),
            ...(a.flex_direction !== undefined ? { flex_direction: a.flex_direction } : {}),
          };
        });
      } catch (err) {
        console.warn("[browserops] quick_read augmentation skipped:", err);
      }
    }

    if (onlyEnabled || onlyVisible || onlyInViewport) {
      matches = (matches as Array<{
        visible?: boolean;
        in_viewport?: boolean;
        disabled_visual?: boolean;
      }>).filter((m) => {
        if (onlyEnabled && m.disabled_visual === true) return false;
        if (onlyVisible && m.visible === false) return false;
        if (onlyInViewport && m.in_viewport === false) return false;
        return true;
      }) as typeof matches;
    }

    const region = rawParams["within_region"];
    if (
      typeof region === "object" &&
      region !== null &&
      !Array.isArray(region)
    ) {
      const r = region as { x: number; y: number; w: number; h: number };
      if (
        typeof r.x === "number" &&
        typeof r.y === "number" &&
        typeof r.w === "number" &&
        typeof r.h === "number"
      ) {
        matches = (matches as Array<{
          rect: { x: number; y: number; width: number; height: number };
        }>).filter((m) => {
          const rect = m.rect;
          return (
            rect.x + rect.width > r.x &&
            rect.y + rect.height > r.y &&
            rect.x < r.x + r.w &&
            rect.y < r.y + r.h
          );
        }) as typeof matches;
      }
    }

    return {
      matches,
      total: result.total,
      query,
    };
  });
}
