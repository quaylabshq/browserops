import type { ErrorCode } from "@browserops/shared";
import type { Router } from "../router.js";

/**
 * browser.read handler.
 *
 * Params: { tab_id, mode } where mode ∈ {"a11y_tree","markdown","sanitized_html","text"}
 * Result: { content, refs, url, title }
 *
 * v1 coverage:
 *   - "text", "markdown", "sanitized_html": implemented via
 *     chrome.scripting.executeScript injecting a function into the target
 *     tab. sanitized_html is post-processed in the SW with regex stripping
 *     (MV3 service workers have no DOMParser; see plan 05-element-refs.md
 *     §4 / the TS port of sanitize_html.py called out in plan 04).
 *   - "a11y_tree": deferred to v2. Throws INTERNAL so callers don't get
 *     misleading placeholder content.
 *
 * refs is always [] here — the a11y-tree pipeline (plan 05 §4) is the
 * only producer of refs and is not implemented in v1.
 */

type ReadMode = "a11y_tree" | "markdown" | "sanitized_html" | "text";

interface ReadParams {
  tab_id: string;
  mode: ReadMode;
}

interface RefEntry {
  ref: number;
  role: string;
  name: string;
  attrs?: Record<string, string>;
}

interface ReadResult {
  content: string;
  refs: RefEntry[];
  url: string;
  title: string;
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

/**
 * Regex-based HTML sanitizer. Strips scripts/styles/meta/link/noscript,
 * HTML comments, and class / style / id / on-handler / data- attributes.
 * This is deliberately coarse — a real parser (DOMParser/parse5) would be
 * better but MV3 service workers don't have DOMParser and we don't want
 * to pull parse5 into the extension bundle for v1. Good enough for LLM
 * consumption where a few leftover attribute artifacts are acceptable.
 */
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
// Injected functions. These run in the target tab's MAIN world via
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
  // Very small HTML→Markdown walker. Covers headings, paragraphs, lists,
  // inline code, and links. Intentionally skips tables, images, blockquotes
  // nested beyond one level, and anything else exotic — we only need to
  // hand the LLM something more structured than raw innerText.
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

async function execInTab<T>(
  chromeTabId: number,
  fn: () => T,
): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId: chromeTabId },
    func: fn,
    world: "MAIN",
  });
  if (!Array.isArray(results) || results.length === 0) {
    throw codedError("INTERNAL", "executeScript returned no frames");
  }
  // Main-frame result is results[0].
  const first = results[0];
  if (first === undefined) {
    throw codedError("INTERNAL", "executeScript main-frame result missing");
  }
  return first.result as T;
}

export function registerReadHandler(
  router: Router,
  opts: { tabIdMap: Map<string, number> },
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
      throw codedError("INTERNAL", "a11y_tree mode deferred to v2");
    }

    let content: string;
    if (params.mode === "text") {
      content = await execInTab<string>(chromeTabId, injectedReadText);
    } else if (params.mode === "markdown") {
      content = await execInTab<string>(chromeTabId, injectedReadMarkdown);
    } else {
      // sanitized_html
      const raw = await execInTab<string>(chromeTabId, injectedReadOuterHtml);
      content = sanitizeHtml(raw);
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
