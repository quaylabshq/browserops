import type { ErrorCode } from "@browserops/shared";
import type { Router } from "../router.js";
import type { RefCache, RefEntry, RefSnapshot } from "../ref-cache.js";

/**
 * browser.read handler.
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
 *     plan 05-element-refs.md §4. Produces numbered RefEntry[] which are
 *     stored in the shared RefCache for later click/type dereference.
 */

type ReadMode = "a11y_tree" | "markdown" | "sanitized_html" | "text";

interface ReadParams {
  tab_id: string;
  mode: ReadMode;
}

interface ReadResult {
  content: string;
  refs: RefEntry[];
  url: string;
  title: string;
}

interface A11yWalkResult {
  entries: RefEntry[];
  tree: string;
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
  return { tab_id: tabId, mode: mode as ReadMode };
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

function injectedReadText(): string {
  return document.documentElement.innerText;
}

function injectedReadOuterHtml(): string {
  return document.documentElement.outerHTML;
}

function injectedReadMarkdown(): string {
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
  visit(document.body, 0);
  return out.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * DOM-only a11y tree walker. Runs in the ISOLATED world of the target tab.
 * Must be fully self-contained — no outer closure refs (plan 05 §4).
 *
 * Pruning: keep interactive or structural elements that are visible.
 * Numbering: 1-based refs assigned in DFS order. Capped at 500.
 */
function injectedA11yWalk(): { entries: Array<{ ref: number; selector: string; role: string; name: string; attrs: Record<string, string> }>; tree: string } {
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

  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    return true;
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

  const entries: Array<{ ref: number; selector: string; role: string; name: string; attrs: Record<string, string> }> = [];
  const treeLines: string[] = [];
  let truncated = false;
  let truncatedCount = 0;
  let refCounter = 0;

  const walk = (el: Element, depth: number): void => {
    if (!isVisible(el)) return;
    const role = roleFor(el);
    const keep = shouldKeep(el, role);
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
  };

  if (document.body !== null) {
    walk(document.body, 0);
  }

  if (truncated) {
    treeLines.push(`[... ${truncatedCount} more refs elided]`);
  }

  return { entries, tree: treeLines.join("\n") };
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

function narrowWalkResult(raw: unknown): A11yWalkResult {
  if (typeof raw !== "object" || raw === null) {
    throw codedError("INTERNAL", "a11y walker returned non-object");
  }
  const obj = raw as Record<string, unknown>;
  const tree = obj["tree"];
  const rawEntries = obj["entries"];
  if (typeof tree !== "string" || !Array.isArray(rawEntries)) {
    throw codedError("INTERNAL", "a11y walker result malformed");
  }
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
  return { entries, tree };
}

export function registerReadHandler(
  router: Router,
  opts: { tabIdMap: Map<string, number>; refCache: RefCache },
): void {
  router.register("browser.read", async (rawParams) => {
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

    if (params.mode === "a11y_tree") {
      const raw: unknown = await execInTab<unknown>(chromeTabId, injectedA11yWalk, "ISOLATED");
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
      const result: ReadResult = {
        content: walk.tree,
        refs: walk.entries,
        url,
        title,
      };
      return result;
    }

    let content: string;
    if (params.mode === "text") {
      content = await execInTab<string>(chromeTabId, injectedReadText);
    } else if (params.mode === "markdown") {
      content = await execInTab<string>(chromeTabId, injectedReadMarkdown);
    } else {
      // sanitized_html
      const rawHtml = await execInTab<string>(chromeTabId, injectedReadOuterHtml);
      content = sanitizeHtml(rawHtml);
    }

    const result: ReadResult = {
      content,
      refs: [],
      url,
      title,
    };
    return result;
  });
}
